-- 0001_core_schema.sql
-- Evolution of outputs/schema.sql. Material changes are recorded in docs/decisions.md.
-- Apply as the MIGRATION OWNER. Runtime grants live in 0002; the API never uses this role.

CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- reference
CREATE TABLE currencies (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  minor_unit_exponent smallint NOT NULL CHECK (minor_unit_exponent BETWEEN 0 AND 4)
);
INSERT INTO currencies VALUES ('INR',2),('USD',2),('EUR',2),('GBP',2),('JPY',0);

CREATE TABLE categories (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  sort_order smallint NOT NULL DEFAULT 0
);
INSERT INTO categories(code,label,sort_order) VALUES
 ('gym','Gym',1),('trainer','Personal trainer',2),('groceries','Everyday food',3),
 ('prepared_meals','Prepared meals',4),('supplements','Supplements',5),('other','Other',6);

-- -------------------------------------------------------------------- users
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_issuer text NOT NULL,
  auth_subject text NOT NULL,
  display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 120),
  timezone text NOT NULL DEFAULT 'UTC',
  weight_unit text NOT NULL DEFAULT 'kg' CHECK (weight_unit IN ('kg','lb')),
  notification_opt_in boolean NOT NULL DEFAULT false,
  -- D-11: deletion must disable access IMMEDIATELY, before the erasure job runs.
  deletion_requested_at timestamptz,
  deactivated_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auth_issuer, auth_subject)
);

-- -------------------------------------------------------------------- plans
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','completed','cancelled')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  timezone text NOT NULL,
  currency_code text NOT NULL REFERENCES currencies(code),
  budget_scope text NOT NULL CHECK (budget_scope IN ('total','incremental')),
  baseline_weight_kg numeric(7,3) NOT NULL CHECK (baseline_weight_kg > 0 AND baseline_weight_kg < 1000),
  target_weight_kg numeric(7,3) NOT NULL CHECK (target_weight_kg > 0),
  daily_protein_target_g numeric(7,2) CHECK (daily_protein_target_g >= 0 AND daily_protein_target_g < 10000),
  daily_calorie_target integer CHECK (daily_calorie_target >= 0 AND daily_calorie_target < 20000),
  activated_at timestamptz,
  closed_at timestamptz,
  -- D-03: the plan-LOCAL closing date. Cancelled plans accept corrections only
  -- through this date; a timestamptz alone cannot express that cap.
  closed_on date,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT target_below_baseline CHECK (target_weight_kg < baseline_weight_kg),
  CONSTRAINT six_calendar_months CHECK (end_date = (start_date + interval '6 months')::date),
  CONSTRAINT activated_when_live CHECK (status NOT IN ('active','completed') OR activated_at IS NOT NULL),
  CONSTRAINT closed_consistently CHECK ((status IN ('completed','cancelled')) = (closed_at IS NOT NULL)),
  CONSTRAINT closed_on_with_closed_at CHECK ((closed_at IS NULL) = (closed_on IS NULL)),
  UNIQUE (user_id,id)
);
-- Final protection against two concurrent activations for one user.
CREATE UNIQUE INDEX one_active_plan_per_user ON plans(user_id) WHERE status = 'active';

-- ----------------------------------------------------------------- budgets
CREATE TABLE budget_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0 AND total_minor <= 1000000000000000),
  effective_on date NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 280),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id,plan_id) REFERENCES plans(user_id,id) ON DELETE CASCADE,
  UNIQUE (user_id,plan_id,id),
  UNIQUE (user_id,plan_id,revision)
);

CREATE TABLE budget_lines (
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  category_id smallint NOT NULL REFERENCES categories(id),
  allocated_minor bigint NOT NULL CHECK (allocated_minor >= 0 AND allocated_minor <= 1000000000000000),
  PRIMARY KEY (revision_id,category_id),
  FOREIGN KEY (user_id,plan_id,revision_id) REFERENCES budget_revisions(user_id,plan_id,id) ON DELETE CASCADE
);

-- ------------------------------------------------------------- commitments
CREATE TABLE commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  category_id smallint NOT NULL REFERENCES categories(id),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  due_on date NOT NULL,
  expected_minor bigint NOT NULL CHECK (expected_minor >= 0 AND expected_minor <= 1000000000000000),
  attributable_minor bigint NOT NULL CHECK (attributable_minor BETWEEN 0 AND expected_minor),
  -- D-08: an unlimited membership has VISITS, not an invented session allowance.
  session_model text NOT NULL DEFAULT 'unlimited' CHECK (session_model IN ('unlimited','sessions')),
  expected_sessions integer CHECK (expected_sessions > 0 AND expected_sessions <= 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','cancelled')),
  -- D-07: reopening after a refund is an explicit, audited user action.
  reopened_at timestamptz,
  generation_key text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_match_model CHECK ((session_model = 'sessions') = (expected_sessions IS NOT NULL)),
  FOREIGN KEY (user_id,plan_id) REFERENCES plans(user_id,id) ON DELETE CASCADE,
  UNIQUE (user_id,plan_id,id),
  UNIQUE (user_id,plan_id,category_id,id)
);
-- Idempotent expansion of a recurring estimate: re-running generation is a no-op.
CREATE UNIQUE INDEX commitments_generation_key
  ON commitments(user_id,plan_id,generation_key) WHERE generation_key IS NOT NULL;

-- ---------------------------------------------------------------- expenses
CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  category_id smallint NOT NULL REFERENCES categories(id),
  commitment_id uuid,
  paid_on date NOT NULL,
  kind text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','refund')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000),
  attributable_minor bigint NOT NULL CHECK (attributable_minor BETWEEN 0 AND amount_minor),
  refund_of_id uuid,
  description text CHECK (description IS NULL OR length(description) <= 280),
  -- D-06: corrections are an audited void-and-replace, never a fake refund.
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(void_reason) <= 280),
  replaced_by_id uuid REFERENCES expenses(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_has_original CHECK ((kind = 'refund') = (refund_of_id IS NOT NULL)),
  CONSTRAINT refund_not_self CHECK (refund_of_id IS NULL OR refund_of_id <> id),
  CONSTRAINT void_is_explained CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  FOREIGN KEY (user_id,plan_id) REFERENCES plans(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,plan_id,commitment_id) REFERENCES commitments(user_id,plan_id,id),
  UNIQUE (user_id,plan_id,category_id,id),
  -- A refund must point at a payment in the SAME user, plan and category.
  FOREIGN KEY (user_id,plan_id,category_id,refund_of_id)
    REFERENCES expenses(user_id,plan_id,category_id,id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------ health
CREATE TABLE weight_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  measured_at timestamptz NOT NULL,
  -- Derived on the SERVER from measured_at and the plan's frozen zone (D-03).
  local_date date NOT NULL,
  weight_kg numeric(7,3) NOT NULL CHECK (weight_kg > 0 AND weight_kg < 1000),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  external_id text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id,plan_id) REFERENCES plans(user_id,id) ON DELETE CASCADE,
  UNIQUE (user_id,source,external_id)
);

CREATE TABLE nutrition_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  local_date date NOT NULL,
  -- NULL means UNKNOWN; an explicit 0 means zero. They are different facts.
  calories integer CHECK (calories >= 0 AND calories < 20000),
  protein_g numeric(7,2) CHECK (protein_g >= 0 AND protein_g < 10000),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT at_least_one_value CHECK (calories IS NOT NULL OR protein_g IS NOT NULL),
  FOREIGN KEY (user_id,plan_id) REFERENCES plans(user_id,id) ON DELETE CASCADE,
  UNIQUE (user_id,plan_id,local_date)
);

CREATE TABLE activity_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  commitment_id uuid,
  occurred_at timestamptz NOT NULL,
  local_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('gym','trainer','home_workout','other')),
  status text NOT NULL CHECK (status IN ('completed','missed')),
  duration_minutes integer CHECK (duration_minutes > 0 AND duration_minutes <= 1440),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (user_id,plan_id) REFERENCES plans(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY (user_id,plan_id,commitment_id) REFERENCES commitments(user_id,plan_id,id)
);

-- --------------------------------------------------- consent / audit / ops
CREATE TABLE consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 64),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 32),
  action text NOT NULL CHECK (action IN ('granted','revoked')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Deliberately carries NO body measurements, amounts or free text (D-10).
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_type text NOT NULL CHECK (actor_type IN ('user','system')),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  entity_type text NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 40),
  entity_id uuid,
  request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  route text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  request_hash text NOT NULL,
  resource_id uuid,
  response_status smallint CHECK (response_status BETWEEN 200 AND 299),
  -- D-12: a resource id alone cannot reproduce the original response body once the
  -- resource has since been edited. Store the agreed replay representation.
  response_body jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  PRIMARY KEY (user_id,route,key)
);

CREATE TABLE outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  -- D-13: a crashed worker's claim must expire so the job is retried.
  lease_expires_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR length(last_error_code) <= 64),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id,dedupe_key)
);

-- Owner-only, expiring export artifacts.
CREATE TABLE account_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed','expired')),
  download_token text UNIQUE,
  payload jsonb,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- ----------------------------------------------------------------- indexes
CREATE INDEX plans_owner_created ON plans(user_id,created_at DESC,id);
CREATE INDEX revisions_effective ON budget_revisions(user_id,plan_id,effective_on DESC,revision DESC);
CREATE INDEX commitments_due ON commitments(user_id,plan_id,due_on,id);
CREATE INDEX expenses_timeline ON expenses(user_id,plan_id,paid_on,id) WHERE voided_at IS NULL;
CREATE INDEX expenses_commitment ON expenses(user_id,plan_id,commitment_id) WHERE commitment_id IS NOT NULL;
CREATE INDEX expenses_refund ON expenses(refund_of_id) WHERE refund_of_id IS NOT NULL;
CREATE INDEX weights_timeline ON weight_entries(user_id,plan_id,local_date,id);
CREATE INDEX activities_timeline ON activity_entries(user_id,plan_id,local_date,id);
CREATE INDEX activities_commitment ON activity_entries(user_id,plan_id,commitment_id) WHERE commitment_id IS NOT NULL;
CREATE INDEX nutrition_timeline ON nutrition_days(user_id,plan_id,local_date);
CREATE INDEX consent_latest ON consent_events(user_id,purpose,created_at DESC);
CREATE INDEX audit_owner_time ON audit_events(user_id,created_at DESC);
CREATE INDEX idempotency_expiry ON idempotency_keys(expires_at);
CREATE INDEX jobs_ready ON outbox_jobs(available_at,id) WHERE status = 'pending';
CREATE INDEX jobs_stale ON outbox_jobs(lease_expires_at) WHERE status = 'running';
CREATE INDEX exports_owner ON account_exports(user_id,created_at DESC);

-- ---------------------------------------------------------------- triggers
CREATE FUNCTION bump_version() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$fn$;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','plans','commitments','weight_entries','nutrition_days','activity_entries'] LOOP
    EXECUTE format('CREATE TRIGGER bump_version BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION bump_version()',t);
  END LOOP;
END;
$do$;

INSERT INTO schema_migrations(version) VALUES ('0001_core_schema');
