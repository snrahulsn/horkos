-- Generic proof ledger. Trusted adapters write final verification results;
-- public analytics consume only rows with status = 'verified'.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'horkos_proof_ingestor') THEN
    -- No password is set by the migration. Provision this dedicated login with
    -- a strong secret and put only its URL in PROOF_DATABASE_URL.
    CREATE ROLE horkos_proof_ingestor LOGIN;
  END IF;
END $$;

CREATE TYPE proof_status AS ENUM ('verified', 'rejected');

CREATE TABLE proofs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oath_id         uuid REFERENCES oaths(id),
  milestone_id    uuid REFERENCES milestones(id),
  kind            text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  source          text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  external_id     text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 500),
  assertion       jsonb NOT NULL,
  observed_at     timestamptz NOT NULL,
  digest          text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  status          proof_status NOT NULL,
  adapter_version text NOT NULL CHECK (length(adapter_version) BETWEEN 1 AND 100),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (oath_id IS NOT NULL OR milestone_id IS NOT NULL),
  UNIQUE (source, external_id)
);

CREATE INDEX proofs_oath_idx ON proofs(oath_id, kind, status);
CREATE INDEX proofs_milestone_idx ON proofs(milestone_id, kind, status);

-- Fill/validate the parent oath from the milestone. This prevents a proof from
-- being attached to unrelated records while retaining both query dimensions.
CREATE OR REPLACE FUNCTION proofs_validate_linkage() RETURNS trigger AS $$
DECLARE
  milestone_oath uuid;
BEGIN
  IF NEW.milestone_id IS NOT NULL THEN
    SELECT oath_id INTO milestone_oath FROM milestones WHERE id = NEW.milestone_id;
    IF milestone_oath IS NULL THEN
      RAISE EXCEPTION 'HORKOS: proof references unknown milestone';
    END IF;
    IF NEW.oath_id IS NULL THEN
      NEW.oath_id := milestone_oath;
    ELSIF NEW.oath_id IS DISTINCT FROM milestone_oath THEN
      RAISE EXCEPTION 'HORKOS: proof milestone does not belong to oath';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER proofs_linkage BEFORE INSERT ON proofs
  FOR EACH ROW EXECUTE FUNCTION proofs_validate_linkage();

-- A normal application connection cannot manufacture a verified result, even
-- if application code accidentally issues a direct INSERT. Production gives a
-- separate credential for this dedicated role and uses PROOF_DATABASE_URL.
CREATE OR REPLACE FUNCTION proofs_verified_writer_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'verified' AND session_user <> 'horkos_proof_ingestor' THEN
    RAISE EXCEPTION 'HORKOS: verified proofs require the dedicated proof ingestor role';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER proofs_verified_writer BEFORE INSERT OR UPDATE ON proofs
  FOR EACH ROW EXECUTE FUNCTION proofs_verified_writer_guard();

CREATE TRIGGER proofs_no_delete BEFORE DELETE ON proofs
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE OR REPLACE FUNCTION proofs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'HORKOS: proofs are immutable';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER proofs_no_update BEFORE UPDATE ON proofs
  FOR EACH ROW EXECUTE FUNCTION proofs_immutable();

REVOKE INSERT, UPDATE, DELETE ON proofs FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO horkos_proof_ingestor;
GRANT INSERT, SELECT ON proofs TO horkos_proof_ingestor;
GRANT SELECT ON milestones TO horkos_proof_ingestor;
