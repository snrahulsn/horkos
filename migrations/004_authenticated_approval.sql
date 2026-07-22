-- User-approved commitments and verdicts. Agents never receive approval credentials.
ALTER TABLE oaths
  ADD COLUMN approved_by_operator_id uuid REFERENCES operators(id),
  ADD COLUMN approved_commitment_hash text;

ALTER TABLE claims
  ADD COLUMN responded_by_operator_id uuid REFERENCES operators(id);

