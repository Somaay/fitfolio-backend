-- 0003_category_integrity_and_consent_order.sql
-- Two integrity gaps found by the quality engineer and reproduced against a real
-- database before fixing. See docs/decisions.md D-21 and D-22.

-- D-21 -----------------------------------------------------------------------
-- An expense could be filed against a commitment in a DIFFERENT category: a
-- supplements payment could settle a personal-trainer commitment, after which
-- category reporting and commitment reporting silently disagree.
--
-- 0001 already created `commitments UNIQUE (user_id, plan_id, category_id, id)`
-- specifically to support a category-carrying foreign key, but `expenses`
-- referenced only (user_id, plan_id, commitment_id). Widen it so the database
-- enforces category compatibility instead of leaving it to service code alone.
--
-- commitment_id stays nullable; under MATCH SIMPLE a NULL in any column skips
-- the check, so unlinked expenses are unaffected.

ALTER TABLE expenses DROP CONSTRAINT expenses_user_id_plan_id_commitment_id_fkey;

ALTER TABLE expenses
  ADD CONSTRAINT expenses_commitment_same_category_fkey
  FOREIGN KEY (user_id, plan_id, category_id, commitment_id)
  REFERENCES commitments (user_id, plan_id, category_id, id);

-- Keep the lookup index aligned with the new constraint.
DROP INDEX IF EXISTS expenses_commitment;
CREATE INDEX expenses_commitment
  ON expenses (user_id, plan_id, category_id, commitment_id)
  WHERE commitment_id IS NOT NULL;

-- D-22 -----------------------------------------------------------------------
-- `consent_events.created_at` defaults to now(), which is the TRANSACTION
-- timestamp. Two events for the same purpose written in one transaction share a
-- timestamp, so "what is the current consent state?" fell back to an arbitrary
-- UUID tie-break. That is the wrong answer to ask a random number for: consent
-- must resolve deterministically, and a revocation must never lose to a grant.
--
-- A monotonic ordinal makes the latest event unambiguous regardless of clock
-- granularity. Existing rows are ordered by their timestamp.

ALTER TABLE consent_events ADD COLUMN ordinal bigint;

CREATE SEQUENCE consent_events_ordinal_seq OWNED BY consent_events.ordinal;

UPDATE consent_events SET ordinal = nextval('consent_events_ordinal_seq')
FROM (SELECT id FROM consent_events ORDER BY created_at, id) ordered
WHERE consent_events.id = ordered.id;

ALTER TABLE consent_events
  ALTER COLUMN ordinal SET DEFAULT nextval('consent_events_ordinal_seq'),
  ALTER COLUMN ordinal SET NOT NULL;

GRANT USAGE, SELECT ON SEQUENCE consent_events_ordinal_seq TO app_api;

-- Resolve current consent by ordinal, not by a tied timestamp.
DROP INDEX IF EXISTS consent_latest;
CREATE INDEX consent_latest ON consent_events (user_id, purpose, ordinal DESC);

INSERT INTO schema_migrations(version) VALUES ('0003_category_integrity_and_consent_order');
