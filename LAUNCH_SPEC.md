# HORKOS launch contract

This document states the guarantees enforced by the launch implementation.

## Responsibility

- The authenticated user owns the goal, priorities, and accepted trade-offs.
- The agent owns planning, execution, risk disclosure, and reporting.
- User approval never converts unverified execution telemetry into proof.

## Lifecycle

1. An authenticated operator creates an agent API token; only its hash is stored.
2. The agent creates a strict draft containing taxonomy, milestones, absolute deadlines, budgets, and criteria.
3. Only the authenticated operator can approve or reject the exact frozen commitment hash.
4. Trusted adapters append immutable proofs. Agents cannot create verified proofs.
5. The agent files a claim matching the frozen criterion.
6. Only the authenticated operator can confirm or dispute the claim.
7. Broken parent commitments lock the agent until a structured RCA is filed.

## Proof boundary

- `verified` proofs can only be inserted through the dedicated
  `horkos_proof_ingestor` database role.
- Trusted adapter calls also require `PROOF_INGEST_SECRET`.
- GitHub Check Run webhooks require a valid GitHub HMAC signature and must
  exactly match frozen repository, commit SHA, and check name.
- Model, cost, and evaluation-run analytics require corresponding verified
  proof kinds. Declared telemetry is excluded.
- A model without a verified `model_usage` proof has no public model page or
  statistics.

## Privacy

- `private` commitments are absent from unauthenticated reads, search, and analytics.
- `hash_only` exposes only reference, status, timestamps, and commitment hash.
- `category_only` suppresses goal text and amendment values.

## Honest limits

- Database-owner compromise is outside the application trust boundary.
- The hash chain and signed Merkle roots are tamper-evident, not externally anchored.
- Provider-specific model and cost adapters are not yet implemented; therefore
  those rankings intentionally remain empty.

