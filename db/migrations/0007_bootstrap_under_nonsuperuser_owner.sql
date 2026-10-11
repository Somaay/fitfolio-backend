-- 0007_bootstrap_under_nonsuperuser_owner.sql
--
-- Makes the identity bootstrap work when the database owner is NOT a superuser.
--
-- The problem, in full: migrations 0001-0002 set FORCE ROW LEVEL SECURITY on
-- every owned table. FORCE means the policies apply to the table OWNER as well,
-- not just to other roles. That was deliberate — the owner should not be able to
-- read user data casually.
--
-- But the SECURITY DEFINER functions (app_register_password_user,
-- app_resolve_identity, app_create_password_reset) run AS the owner, and they
-- must INSERT rows for a user who has no session yet — there is no
-- app.user_id to satisfy a policy with, because establishing identity is the
-- very thing they are doing.
--
-- Locally this never showed: the migration owner was the `postgres` superuser,
-- and a superuser bypasses RLS entirely, FORCE or not. On a managed provider the
-- owner is an ordinary role, so FORCE applied to it and registration failed with
--    new row violates row-level security policy for table "users"
-- surfacing as a 404 from the API's 42501 mapping.
--
-- The fix is to drop FORCE on exactly the four tables those functions write to.
-- What this does NOT weaken: app_api and app_worker own nothing, so row-level
-- security still applies to them in full on every table, including these. Only
-- the owner — used by migrations and by the audited definer functions, never by
-- the running application — is exempt. Every other table keeps FORCE.

ALTER TABLE users                 NO FORCE ROW LEVEL SECURITY;
ALTER TABLE user_credentials      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens NO FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_jobs           NO FORCE ROW LEVEL SECURITY;

INSERT INTO schema_migrations(version) VALUES ('0007_bootstrap_under_nonsuperuser_owner');
