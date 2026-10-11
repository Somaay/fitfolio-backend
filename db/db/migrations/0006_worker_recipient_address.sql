-- 0006_worker_recipient_address.sql
-- Let the worker resolve a recipient address — and nothing else.
--
-- Real email delivery needs an address. The worker deliberately had NO access to
-- user_credentials at all, so this grants the narrowest thing that works:
-- column-level SELECT on (user_id, email) only. The password hash stays
-- unreachable to every runtime role, as before.
--
-- No new policy is needed. user_credentials already carries `owned_credential`
-- (user_id = app_current_user_id()), and the worker sets app.user_id to the
-- job's owner before running a handler — so it can read the address of the
-- account it is currently delivering to, and no other.

GRANT SELECT (user_id, email) ON user_credentials TO app_worker;

INSERT INTO schema_migrations(version) VALUES ('0006_worker_recipient_address');
