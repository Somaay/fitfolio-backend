-- 0002_rls_and_roles.sql
-- Row-level security plus least-privilege runtime roles.
--
-- The migration owner keeps DDL rights and is NEVER used by the API or worker.
-- app_api and app_worker are NOSUPERUSER, NOBYPASSRLS and own no tables, so
-- FORCE ROW LEVEL SECURITY genuinely applies to them (the owner would otherwise
-- bypass its own policies). Integration tests connect as app_api, not the owner.

-- ------------------------------------------------------------------- roles
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
    CREATE ROLE app_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END;
$do$;

GRANT USAGE ON SCHEMA public TO app_api, app_worker;

-- Reference data is shared and read-only for runtime roles.
GRANT SELECT ON currencies, categories TO app_api, app_worker;

-- Ordinary owned data: full DML for the API.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  plans, commitments, weight_entries, nutrition_days, activity_entries
TO app_api;

GRANT SELECT, INSERT, UPDATE, DELETE ON users TO app_api;

-- Append-only history. No UPDATE and no DELETE for the ordinary runtime role:
-- a budget revision, consent record or audit event must never be rewritten.
GRANT SELECT, INSERT ON budget_revisions, budget_lines, consent_events, audit_events TO app_api;

-- Expenses are append-only EXCEPT for the void-and-replace correction workflow.
-- Column-level UPDATE is the narrow privilege that makes corrections possible
-- without allowing an amount, date or category to be silently rewritten.
GRANT SELECT, INSERT ON expenses TO app_api;
GRANT UPDATE (voided_at, void_reason, replaced_by_id) ON expenses TO app_api;

GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO app_api;
GRANT SELECT, INSERT, UPDATE ON outbox_jobs TO app_api;
GRANT SELECT, INSERT, UPDATE ON account_exports TO app_api;

-- The worker processes jobs and writes exports; it never edits user records.
GRANT SELECT, UPDATE ON outbox_jobs TO app_worker;
GRANT SELECT, INSERT, UPDATE ON account_exports TO app_worker;
GRANT SELECT ON users, plans, expenses, weight_entries, nutrition_days,
                activity_entries, commitments, budget_revisions, budget_lines,
                consent_events TO app_worker;
GRANT INSERT ON audit_events TO app_worker;

-- --------------------------------------------------------------- RLS setup
-- Context is set per-transaction with:
--   SELECT set_config('app.user_id', <verified uuid>, true)
-- The `true` makes it TRANSACTION-local, so a pooled connection cannot leak one
-- user's context into the next user's queries. With no context set, the
-- expression is NULL and every policy matches zero rows: it fails closed.

CREATE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $fn$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$fn$;

CREATE FUNCTION app_is_worker() RETURNS boolean
LANGUAGE sql STABLE AS $fn$
  SELECT coalesce(nullif(current_setting('app.worker', true), ''), 'off') = 'on'
$fn$;

GRANT EXECUTE ON FUNCTION app_current_user_id() TO app_api, app_worker;
GRANT EXECUTE ON FUNCTION app_is_worker() TO app_api, app_worker;

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY owned_user ON users
  USING (id = app_current_user_id())
  WITH CHECK (id = app_current_user_id());

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plans','budget_revisions','budget_lines','commitments','expenses',
    'weight_entries','nutrition_days','activity_entries','consent_events','audit_events',
    'idempotency_keys','outbox_jobs','account_exports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format(
      'CREATE POLICY owned_rows ON %I USING (user_id = app_current_user_id()) '
      'WITH CHECK (user_id = app_current_user_id())', t);
  END LOOP;
END;
$do$;

-- The worker must claim jobs ACROSS users before it knows whose job it is.
-- This cross-user reach is deliberately scoped to the queue table and the
-- app_worker role, and is never granted to an HTTP handler.
CREATE POLICY worker_claims_jobs ON outbox_jobs
  TO app_worker
  USING (app_is_worker())
  WITH CHECK (app_is_worker());

CREATE POLICY worker_writes_exports ON account_exports
  TO app_worker
  USING (app_is_worker())
  WITH CHECK (app_is_worker());

-- ------------------------------------------------- identity bootstrap path
-- Looking up "which internal user is this token subject?" happens BEFORE any
-- user context exists, so it cannot go through the owner-scoped policies.
-- Rather than granting the API a policy bypass, this SECURITY DEFINER function
-- exposes exactly one narrow operation: resolve-or-create by (issuer, subject),
-- returning only the internal id. It can read nothing else.
CREATE FUNCTION app_resolve_identity(
  p_issuer text, p_subject text, p_timezone text DEFAULT 'UTC'
) RETURNS TABLE (user_id uuid, is_new boolean, deactivated boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_id uuid; v_deactivated timestamptz; v_new boolean := false;
BEGIN
  IF p_issuer IS NULL OR p_subject IS NULL
     OR length(p_issuer) = 0 OR length(p_subject) = 0 THEN
    RAISE EXCEPTION 'issuer and subject are required';
  END IF;

  SELECT u.id, u.deactivated_at INTO v_id, v_deactivated
  FROM users u WHERE u.auth_issuer = p_issuer AND u.auth_subject = p_subject;

  IF v_id IS NULL THEN
    INSERT INTO users(auth_issuer, auth_subject, timezone)
    VALUES (p_issuer, p_subject, coalesce(p_timezone,'UTC'))
    ON CONFLICT (auth_issuer, auth_subject) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN  -- lost a concurrent race; re-read
      SELECT u.id, u.deactivated_at INTO v_id, v_deactivated
      FROM users u WHERE u.auth_issuer = p_issuer AND u.auth_subject = p_subject;
    ELSE
      v_new := true;
    END IF;
  END IF;

  RETURN QUERY SELECT v_id, v_new, (v_deactivated IS NOT NULL);
END;
$fn$;

REVOKE ALL ON FUNCTION app_resolve_identity(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_identity(text,text,text) TO app_api;

-- --------------------------------------------------- account erasure path
-- Deletion must remove rows the ordinary role is forbidden to DELETE
-- (append-only history). Reconciling that with RLS needs one narrow,
-- owner-scoped SECURITY DEFINER routine rather than broad DELETE grants.
CREATE FUNCTION app_erase_account(p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'user id required'; END IF;
  -- users cascades to every owned table, including the append-only ones and the
  -- self-referencing refund chain in expenses.
  DELETE FROM users WHERE id = p_user_id;
END;
$fn$;

REVOKE ALL ON FUNCTION app_erase_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_erase_account(uuid) TO app_worker;

INSERT INTO schema_migrations(version) VALUES ('0002_rls_and_roles');
