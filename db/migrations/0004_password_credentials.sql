-- 0004_password_credentials.sql
-- First-party email + password authentication.
--
-- Password material lives in its own table, not on `users`, so it can carry its
-- own grants: the ordinary API role cannot read a hash at all. Every pre-auth
-- operation (there is no user context yet) goes through a narrow SECURITY
-- DEFINER function rather than a policy bypass, the same pattern as D-15.

CREATE TABLE user_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Stored lowercase and unique, so Alice@x.com and alice@x.com are one account.
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 254),
  -- Encoded as algorithm$params$salt$hash. The algorithm is recorded so a future
  -- migration can re-hash on next successful login without guessing.
  password_hash text NOT NULL CHECK (length(password_hash) BETWEEN 32 AND 512),
  password_updated_at timestamptz NOT NULL DEFAULT now(),
  -- Throttling lives beside the credential so a lockout survives a restart and
  -- cannot be bypassed by rotating IP addresses.
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_credentials_email ON user_credentials (email);

ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credentials FORCE ROW LEVEL SECURITY;

-- A signed-in user may see that a credential exists (to show their email and
-- when the password last changed). The hash itself is never granted.
CREATE POLICY owned_credential ON user_credentials
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

GRANT SELECT (user_id, email, password_updated_at, last_login_at, created_at)
  ON user_credentials TO app_api;

-- ---------------------------------------------------------------- registration
-- Creates the user and its credential atomically. Returns NULL when the email is
-- already taken, so the caller can answer identically whether or not it was.
CREATE FUNCTION app_register_password_user(
  p_email text, p_password_hash text, p_timezone text DEFAULT 'UTC'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_email text; v_id uuid;
BEGIN
  v_email := lower(btrim(p_email));
  IF v_email IS NULL OR length(v_email) < 3 THEN
    RAISE EXCEPTION 'email is required';
  END IF;
  IF p_password_hash IS NULL OR length(p_password_hash) < 32 THEN
    RAISE EXCEPTION 'password hash is required';
  END IF;

  IF EXISTS (SELECT 1 FROM user_credentials c WHERE c.email = v_email) THEN
    RETURN NULL;
  END IF;

  INSERT INTO users (auth_issuer, auth_subject, timezone)
  VALUES ('password', v_email, coalesce(p_timezone, 'UTC'))
  RETURNING id INTO v_id;

  INSERT INTO user_credentials (user_id, email, password_hash)
  VALUES (v_id, v_email, p_password_hash);

  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  -- Lost a concurrent registration race for the same address.
  RETURN NULL;
END;
$fn$;

-- ---------------------------------------------------------------------- login
-- Returns the material needed to verify a password. The API must still compare
-- the hash in constant time and apply the lockout decision.
CREATE FUNCTION app_password_credential(p_email text)
RETURNS TABLE (
  user_id uuid, password_hash text, failed_attempts integer,
  locked_until timestamptz, deactivated boolean
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
  SELECT c.user_id, c.password_hash, c.failed_attempts, c.locked_until,
         (u.deactivated_at IS NOT NULL)
    FROM user_credentials c
    JOIN users u ON u.id = c.user_id
   WHERE c.email = lower(btrim(p_email));
$fn$;

-- Records the outcome of an attempt. Success clears the counter; failure
-- increments it and locks the credential once the threshold is crossed.
CREATE FUNCTION app_record_login_attempt(
  p_user_id uuid, p_success boolean, p_max_attempts integer, p_lock_seconds integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF p_success THEN
    UPDATE user_credentials
       SET failed_attempts = 0, locked_until = NULL,
           last_login_at = now(), updated_at = now()
     WHERE user_id = p_user_id;
  ELSE
    UPDATE user_credentials
       SET failed_attempts = failed_attempts + 1,
           locked_until = CASE
             WHEN failed_attempts + 1 >= p_max_attempts
               THEN now() + make_interval(secs => p_lock_seconds)
             ELSE locked_until END,
           updated_at = now()
     WHERE user_id = p_user_id;
  END IF;
END;
$fn$;

-- ------------------------------------------------------------ password change
-- Requires the caller to prove the current password, which the API does by
-- fetching the hash through app_password_credential first.
CREATE FUNCTION app_set_password(p_user_id uuid, p_password_hash text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF p_password_hash IS NULL OR length(p_password_hash) < 32 THEN
    RAISE EXCEPTION 'password hash is required';
  END IF;
  UPDATE user_credentials
     SET password_hash = p_password_hash, password_updated_at = now(),
         failed_attempts = 0, locked_until = NULL, updated_at = now()
   WHERE user_id = p_user_id;
END;
$fn$;

REVOKE ALL ON FUNCTION app_register_password_user(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_password_credential(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_record_login_attempt(uuid,boolean,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_set_password(uuid,text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_register_password_user(text,text,text) TO app_api;
GRANT EXECUTE ON FUNCTION app_password_credential(text) TO app_api;
GRANT EXECUTE ON FUNCTION app_record_login_attempt(uuid,boolean,integer,integer) TO app_api;
GRANT EXECUTE ON FUNCTION app_set_password(uuid,text) TO app_api;

-- No updated_at trigger: every write to this table goes through one of the
-- SECURITY DEFINER functions above, and each sets updated_at explicitly.

INSERT INTO schema_migrations(version) VALUES ('0004_password_credentials');
