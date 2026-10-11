-- 0005_password_reset.sql
-- Password reset, plus the session revocation that makes a reset meaningful.
--
-- A reset is most often requested BECAUSE someone else has the password. If the
-- old sessions keep working, the reset has not actually removed them. Sessions
-- here are stateless signed cookies, so revocation needs a server-side epoch
-- that the cookie carries and every request re-checks.

ALTER TABLE users ADD COLUMN session_epoch integer NOT NULL DEFAULT 1;

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Only the SHA-256 of the token is stored. A database leak therefore yields
  -- nothing usable: the raw token exists only in the link sent to the user.
  -- A fast hash is correct here — the token is 256 bits of randomness, so
  -- there is nothing to brute force and no need for a slow KDF.
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_lookup ON password_reset_tokens (token_hash);
CREATE INDEX password_reset_by_user ON password_reset_tokens (user_id, created_at DESC);

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;
-- No policy grants the ordinary role access: every operation below is a narrow
-- SECURITY DEFINER function, because a reset happens with no user context.

-- --------------------------------------------------------------- request
-- Returns the user id when the address exists, NULL otherwise. The CALLER must
-- answer identically either way; this function deliberately does not decide.
CREATE FUNCTION app_create_password_reset(
  p_email text, p_token_hash text, p_ttl_seconds integer, p_payload jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_id uuid;
BEGIN
  SELECT c.user_id INTO v_id
    FROM user_credentials c JOIN users u ON u.id = c.user_id
   WHERE c.email = lower(btrim(p_email)) AND u.deactivated_at IS NULL;

  IF v_id IS NULL THEN RETURN NULL; END IF;

  -- One live token at a time: requesting a new link retires the previous one,
  -- so an older email in an inbox cannot still be used.
  UPDATE password_reset_tokens
     SET used_at = now()
   WHERE user_id = v_id AND used_at IS NULL AND expires_at > now();

  INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
  VALUES (v_id, p_token_hash, now() + make_interval(secs => p_ttl_seconds));

  -- Queue delivery in the SAME transaction as the token. A reset link that was
  -- recorded but never queued, or queued but never recorded, would both be
  -- bugs; the transactional outbox makes them impossible.
  INSERT INTO outbox_jobs (user_id, kind, dedupe_key, payload)
  VALUES (v_id, 'password_reset', 'password-reset:' || p_token_hash, p_payload);

  RETURN v_id;
END;
$fn$;

-- --------------------------------------------------------------- redeem
-- Single-use and atomic: the UPDATE ... RETURNING both claims the token and
-- reports whether it was still claimable, so two simultaneous redemptions
-- cannot both succeed.
CREATE FUNCTION app_redeem_password_reset(p_token_hash text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_id uuid;
BEGIN
  UPDATE password_reset_tokens
     SET used_at = now()
   WHERE token_hash = p_token_hash
     AND used_at IS NULL
     AND expires_at > now()
  RETURNING user_id INTO v_id;

  RETURN v_id;
END;
$fn$;

-- ------------------------------------------------------ session revocation
-- Bumping the epoch invalidates every cookie already issued for this user.
CREATE FUNCTION app_bump_session_epoch(p_user_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_epoch integer;
BEGIN
  UPDATE users SET session_epoch = session_epoch + 1, updated_at = now()
   WHERE id = p_user_id
  RETURNING session_epoch INTO v_epoch;
  RETURN v_epoch;
END;
$fn$;

-- Identity resolution must now also report the epoch, so every authenticated
-- request can reject a cookie minted before the most recent password change.
DROP FUNCTION IF EXISTS app_resolve_identity(text, text, text);
CREATE FUNCTION app_resolve_identity(
  p_issuer text, p_subject text, p_timezone text DEFAULT 'UTC'
) RETURNS TABLE (user_id uuid, is_new boolean, deactivated boolean, session_epoch integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_id uuid; v_deactivated timestamptz; v_epoch integer; v_new boolean := false;
BEGIN
  IF p_issuer IS NULL OR p_subject IS NULL
     OR length(p_issuer) = 0 OR length(p_subject) = 0 THEN
    RAISE EXCEPTION 'issuer and subject are required';
  END IF;

  SELECT u.id, u.deactivated_at, u.session_epoch INTO v_id, v_deactivated, v_epoch
  FROM users u WHERE u.auth_issuer = p_issuer AND u.auth_subject = p_subject;

  IF v_id IS NULL THEN
    -- Qualify both columns: RETURNS TABLE makes `session_epoch` a variable too,
    -- and an unqualified reference is ambiguous between the two.
    INSERT INTO users AS u2 (auth_issuer, auth_subject, timezone)
    VALUES (p_issuer, p_subject, coalesce(p_timezone,'UTC'))
    ON CONFLICT (auth_issuer, auth_subject) DO NOTHING
    RETURNING u2.id, u2.session_epoch INTO v_id, v_epoch;

    IF v_id IS NULL THEN
      SELECT u.id, u.deactivated_at, u.session_epoch INTO v_id, v_deactivated, v_epoch
      FROM users u WHERE u.auth_issuer = p_issuer AND u.auth_subject = p_subject;
    ELSE
      v_new := true;
    END IF;
  END IF;

  RETURN QUERY SELECT v_id, v_new, (v_deactivated IS NOT NULL), v_epoch;
END;
$fn$;

REVOKE ALL ON FUNCTION app_create_password_reset(text,text,integer,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_redeem_password_reset(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_bump_session_epoch(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_resolve_identity(text,text,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_create_password_reset(text,text,integer,jsonb) TO app_api;
GRANT EXECUTE ON FUNCTION app_redeem_password_reset(text) TO app_api;
GRANT EXECUTE ON FUNCTION app_bump_session_epoch(uuid) TO app_api;
GRANT EXECUTE ON FUNCTION app_resolve_identity(text,text,text) TO app_api;

INSERT INTO schema_migrations(version) VALUES ('0005_password_reset');
