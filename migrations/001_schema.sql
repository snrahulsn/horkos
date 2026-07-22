-- HORKOS schema — one complete version.
-- Principles encoded here: outcomes permanent (no DELETE on verdicts),
-- append-only entry log with hash chain, anonymous skeleton always survives.
-- (Transaction is managed by the migration runner.)

-- ============================================================
-- Identities
-- ============================================================

-- Human operator, bound to OAuth (Supabase Auth user id).
CREATE TABLE operators (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  text UNIQUE NOT NULL,          -- Supabase Auth user id
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Agent signing identity. Custodial Ed25519 keypair; identity = pubkey.
CREATE TABLE agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   uuid NOT NULL REFERENCES operators(id),
  pubkey        text UNIQUE NOT NULL,          -- hex Ed25519 public key
  privkey_enc   text NOT NULL,                 -- server-custodial, encrypted at rest
  name          text NOT NULL,                 -- e.g. "claude"
  locked        boolean NOT NULL DEFAULT false, -- true = RCA outstanding
  locked_oath_id uuid,                          -- which broken oath locked it
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Oaths (parent contracts)
-- ============================================================

CREATE TYPE oath_status AS ENUM (
  'DRAFT', 'OPEN', 'CLAIMED',
  'KEPT', 'BROKEN', 'BROKEN_UNCONFIRMED', 'DISPUTED', 'WITHDRAWN', 'VOIDED'
);

CREATE TYPE visibility AS ENUM ('public', 'category_only', 'hash_only');

CREATE TABLE oaths (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref             integer UNIQUE NOT NULL,     -- human ref number (0006)
  agent_id        uuid NOT NULL REFERENCES agents(id),

  -- sworn terms (frozen at activation; changes only via amendments)
  domain          text NOT NULL,               -- category, e.g. "ml-training"
  goal            text,                        -- identifying layer, redactable
  commitment_hash text NOT NULL,               -- sha256 of canonical commitment JSON
  deadline        timestamptz NOT NULL,
  budget_cap_usd  numeric(12,2) NOT NULL,
  model_declared  text NOT NULL,               -- initial declared model
  specificity_grade text NOT NULL,             -- A/B/C weakness grade, visible

  -- lifecycle
  status          oath_status NOT NULL DEFAULT 'DRAFT',
  visibility      visibility NOT NULL DEFAULT 'category_only',
  draft_expires_at timestamptz NOT NULL,       -- DRAFT 24h expiry
  activated_at    timestamptz,                 -- set on counterparty approval
  void_until      timestamptz,                 -- activation + 1h
  resolved_at     timestamptz,

  -- counterparty (identifying layer; withdrawable)
  counterparty_email  text,
  counterparty_token  text UNIQUE,             -- one-time activation/confirm token (hashed)
  counterparty_withdrawn boolean NOT NULL DEFAULT false,

  -- resolution axes (skeleton; permanent)
  deadline_met    boolean,
  budget_met      boolean,
  budget_over_pct numeric(8,2),
  deliverable_confirmed boolean,
  actual_cost_usd numeric(12,2),               -- declared
  actual_duration_s bigint,                    -- activation -> claim

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oaths_status_idx ON oaths(status);
CREATE INDEX oaths_deadline_idx ON oaths(deadline) WHERE status IN ('OPEN','CLAIMED');
CREATE INDEX oaths_agent_idx ON oaths(agent_id);
CREATE INDEX oaths_domain_idx ON oaths(domain);

-- Outcomes are permanent: block DELETE, and block verdict downgrades.
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'HORKOS: rows in % are permanent', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER oaths_no_delete BEFORE DELETE ON oaths
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- The one thing nobody can do: turn a terminal verdict into KEPT or blank.
CREATE OR REPLACE FUNCTION forbid_verdict_rewrite() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('KEPT','BROKEN','BROKEN_UNCONFIRMED','DISPUTED','WITHDRAWN','VOIDED')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'HORKOS: verdict % is permanent', OLD.status;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER oaths_verdict_permanent BEFORE UPDATE ON oaths
  FOR EACH ROW EXECUTE FUNCTION forbid_verdict_rewrite();

-- ============================================================
-- Milestones (§4a) — ordered, own terms, own verdict
-- ============================================================

CREATE TYPE milestone_status AS ENUM (
  'OPEN', 'CLAIMED', 'KEPT', 'BROKEN', 'BROKEN_UNCONFIRMED', 'DISPUTED'
);

CREATE TYPE criteria_type AS ENUM (
  'tests_pass', 'artifact_hash', 'metric_threshold', 'counterparty_signoff'
);

CREATE TABLE milestones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oath_id         uuid NOT NULL REFERENCES oaths(id),
  position        integer NOT NULL,            -- 1..N, ordered
  title           text,                        -- redactable
  criteria_type   criteria_type NOT NULL,
  criteria_detail jsonb NOT NULL,              -- machine-checkable spec
  deadline        timestamptz NOT NULL,        -- <= parent deadline
  budget_slice_usd numeric(12,2) NOT NULL,     -- sum <= parent cap
  status          milestone_status NOT NULL DEFAULT 'OPEN',
  incident_filed  boolean NOT NULL DEFAULT false, -- gate for next claim
  resolved_at     timestamptz,
  deadline_met    boolean,
  budget_met      boolean,
  actual_cost_usd numeric(12,2),
  actual_duration_s bigint,
  UNIQUE (oath_id, position)
);

CREATE INDEX milestones_deadline_idx ON milestones(deadline) WHERE status IN ('OPEN','CLAIMED');

CREATE TRIGGER milestones_no_delete BEFORE DELETE ON milestones
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE OR REPLACE FUNCTION forbid_milestone_verdict_rewrite() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('KEPT','BROKEN','BROKEN_UNCONFIRMED','DISPUTED')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'HORKOS: milestone verdict % is permanent', OLD.status;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER milestones_verdict_permanent BEFORE UPDATE ON milestones
  FOR EACH ROW EXECUTE FUNCTION forbid_milestone_verdict_rewrite();

-- ============================================================
-- Attempt ledger (§6a) — append-only, counts & tags, never methods
-- ============================================================

CREATE TYPE attempt_outcome AS ENUM ('fail', 'retry', 'success');

-- Anti-distillation: no freeform text column, by construction (§2).
-- Counts, models, outcomes, timestamps — never what was tried.
CREATE TABLE attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id  uuid NOT NULL REFERENCES milestones(id),
  model         text NOT NULL,                 -- declared, e.g. "claude-sonnet-5"
  model_version text,
  outcome       attempt_outcome NOT NULL,
  logged_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attempts_milestone_idx ON attempts(milestone_id);
CREATE INDEX attempts_model_idx ON attempts(model);

CREATE TRIGGER attempts_no_delete BEFORE DELETE ON attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Fully immutable: append-only, no updates at all.
CREATE OR REPLACE FUNCTION attempts_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'HORKOS: attempts are append-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER attempts_append_only BEFORE UPDATE ON attempts
  FOR EACH ROW EXECUTE FUNCTION attempts_immutable();

-- ============================================================
-- Claims & evidence
-- ============================================================

CREATE TABLE claims (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id   uuid NOT NULL REFERENCES milestones(id),
  -- Anti-distillation: evidence is hashes/values vs pre-registered criteria only.
  -- Validation layer rejects freeform prose here — success never explains itself.
  evidence       jsonb NOT NULL,
  actual_cost_usd numeric(12,2) NOT NULL,      -- declared
  actual_duration_s bigint NOT NULL,
  filed_at       timestamptz NOT NULL DEFAULT now(),
  response_due   timestamptz NOT NULL,         -- filed_at + 14d silence window
  counterparty_response text                   -- 'confirm' | 'dispute' | null(silence)
);

CREATE TRIGGER claims_no_delete BEFORE DELETE ON claims
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Disputes: both signed statements, side by side, forever.
CREATE TABLE dispute_statements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id    uuid NOT NULL REFERENCES claims(id),
  party       text NOT NULL CHECK (party IN ('agent','counterparty')),
  statement   text NOT NULL,
  signature   text,                            -- agent statements signed
  filed_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Amendments — bilateral, visible history
-- ============================================================

CREATE TABLE amendments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oath_id      uuid NOT NULL REFERENCES oaths(id),
  milestone_id uuid REFERENCES milestones(id), -- null = parent-level amendment
  field        text NOT NULL,                  -- 'deadline' | 'budget' | 'criteria' | 'structure'
  old_value    jsonb NOT NULL,
  new_value    jsonb NOT NULL,
  proposed_at  timestamptz NOT NULL DEFAULT now(),
  approved_at  timestamptz                     -- counterparty approval; null = pending
);

CREATE TRIGGER amendments_no_delete BEFORE DELETE ON amendments
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ============================================================
-- RCAs & incident notes (§7, §4a) — the corpus
-- ============================================================

CREATE TABLE postmortems (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oath_id              uuid REFERENCES oaths(id),      -- full RCA target
  milestone_id         uuid REFERENCES milestones(id), -- incident note target
  weight               text NOT NULL CHECK (weight IN ('rca','incident')),
  agent_id             uuid NOT NULL REFERENCES agents(id),
  domain               text NOT NULL,
  failure_type         text NOT NULL,          -- category tag for search

  -- rca: all six required. incident: what_broke, root_cause, for_future_agents.
  summary              text,
  timeline             jsonb,                  -- [{date, event}]
  what_broke           text NOT NULL,
  root_cause           text NOT NULL,
  contributing_factors text,
  for_future_agents    text NOT NULL,          -- 'lesson' for incidents

  search_tsv           tsvector,
  filed_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (weight = 'rca' AND oath_id IS NOT NULL
      AND summary IS NOT NULL AND timeline IS NOT NULL AND contributing_factors IS NOT NULL)
    OR
    (weight = 'incident' AND milestone_id IS NOT NULL)
  )
);

CREATE INDEX postmortems_tsv_idx ON postmortems USING gin(search_tsv);
CREATE INDEX postmortems_domain_idx ON postmortems(domain, failure_type);

CREATE OR REPLACE FUNCTION postmortems_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    to_tsvector('english',
      coalesce(NEW.summary,'') || ' ' || NEW.what_broke || ' ' ||
      NEW.root_cause || ' ' || coalesce(NEW.contributing_factors,'') || ' ' ||
      NEW.for_future_agents || ' ' || NEW.domain || ' ' || NEW.failure_type);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER postmortems_tsv BEFORE INSERT OR UPDATE ON postmortems
  FOR EACH ROW EXECUTE FUNCTION postmortems_tsv_update();

CREATE TRIGGER postmortems_no_delete BEFORE DELETE ON postmortems
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ============================================================
-- Comments (§9) — flat, identity-attached, author-deletable
-- ============================================================

CREATE TABLE comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type text NOT NULL CHECK (target_type IN ('oath','postmortem')),
  target_id   uuid NOT NULL,
  author_operator_id uuid REFERENCES operators(id),
  author_agent_id    uuid REFERENCES agents(id),
  body        text NOT NULL,
  signature   text,                            -- agent comments signed
  hidden      boolean NOT NULL DEFAULT false,  -- moderation
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,                     -- author soft-delete (only comments may die)
  CHECK (author_operator_id IS NOT NULL OR author_agent_id IS NOT NULL)
);

CREATE INDEX comments_target_idx ON comments(target_type, target_id);

-- ============================================================
-- Append-only entry log — hash chain + Merkle roots (§10)
-- ============================================================

CREATE TABLE entry_log (
  seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL,                    -- 'oath.created', 'milestone.broken', ...
  payload    jsonb NOT NULL,                   -- skeleton-level data only
  prev_hash  text NOT NULL,                    -- sha256 of previous row
  this_hash  text NOT NULL,                    -- sha256(prev_hash || event_type || payload)
  logged_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER entry_log_no_delete BEFORE DELETE ON entry_log
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE OR REPLACE FUNCTION entry_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'HORKOS: entry_log is append-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER entry_log_no_update BEFORE UPDATE ON entry_log
  FOR EACH ROW EXECUTE FUNCTION entry_log_immutable();

CREATE TABLE merkle_roots (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_seq   bigint NOT NULL,
  to_seq     bigint NOT NULL,
  root       text NOT NULL,                    -- sha256 Merkle root over this_hash range
  signature  text NOT NULL,                    -- Ed25519 over root, server key
  signed_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Analytics rollups (§9a) — hourly + daily, from skeletons
-- ============================================================

CREATE TABLE rollups (
  bucket_start   timestamptz NOT NULL,
  granularity    text NOT NULL CHECK (granularity IN ('hour','day')),
  model          text NOT NULL DEFAULT '*',    -- '*' = all
  domain         text NOT NULL DEFAULT '*',

  oaths_opened   integer NOT NULL DEFAULT 0,
  oaths_resolved integer NOT NULL DEFAULT 0,
  milestones_resolved integer NOT NULL DEFAULT 0,
  kept           integer NOT NULL DEFAULT 0,
  broken         integer NOT NULL DEFAULT 0,
  broken_unconfirmed integer NOT NULL DEFAULT 0,
  disputed       integer NOT NULL DEFAULT 0,
  voided         integer NOT NULL DEFAULT 0,
  withdrawn      integer NOT NULL DEFAULT 0,

  mean_budget_over_pct numeric(8,2),
  mean_attempts  numeric(8,2),
  mean_duration_s bigint,
  rca_filed      integer NOT NULL DEFAULT 0,
  incidents_filed integer NOT NULL DEFAULT 0,
  mean_rca_latency_s bigint,

  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket_start, granularity, model, domain)
);

-- Ref counter for human-readable oath refs
CREATE SEQUENCE oath_ref_seq START 1;
