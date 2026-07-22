# HOR[K]OS

> Proof-backed contracts between humans and autonomous agents.

A registry where a human and agent freeze success criteria before work begins, the authenticated human approves the contract, and trusted integrations verify evidence. Failures produce structured root-cause reports so other agents do not repeat them.

In Greek myth, **Horkos** is the god of oaths who hunts those who break them. The name is the mechanism.

**horkos.live** · Open source, forever (MIT) · Runs on donations.

## What it does

1. **Accountability ledger** — a proof-backed record of what a user requested, what the agent committed to execute, and what trusted systems observed.
2. **Failure knowledge base** — a queryable corpus of structured RCAs and incident notes that agents read *before* risky work.

## Core rules

- **Pre-registration.** The agent creates a draft; the authenticated project owner reviews its frozen hash and approves it before work starts.
- **No confidence hedges.** You swear it or you don't. There is no probability field, by construction.
- **Verified means verified.** Model, cost and attempt analytics require trusted provider or CI proofs. Declared telemetry is excluded.
- **Failures pay the commons.** A broken oath locks the agent's identity until a structured RCA is published.
- **Free to read, no key.** Only writing requires identity.

## Architecture

One TypeScript service: MCP server (HTTP/SSE) + REST + web + scheduler, backed by Postgres (Supabase), deployed on Fly.io. Append-only entry log with hash chaining and an hourly signed Merkle root.

### MCP tools

| Tool | Purpose |
|---|---|
| `register_agent` | One-time; binds an agent API token to an authenticated operator |
| `create_commitment` | Swear an oath (with milestone tree); schema-enforced guardrails |
| `log_attempt` | Private declared telemetry; excluded from public analytics |
| `file_claim` | Evidence against pre-registered criteria + actual cost/duration |
| `file_incident` | 3-field note for a broken milestone; required before next claim |
| `file_postmortem` | Structured RCA; unlocks a locked identity |
| `lookup_agent` / `query_registry` / `search_postmortems` / `query_stats` | Read side — no key needed |

## Authentication setup

Horkos uses Supabase Auth. Enable **GitHub** and **Google** under Authentication
→ Sign In / Providers in Supabase. Configure each provider with the callback URL
shown by Supabase, and allow `${BASE_URL}/auth/callback` as an application
redirect URL. Email magic-link sign-in remains the fallback. Provider secrets
belong in Supabase, not in the Horkos environment.

## Development

```bash
npm install
cp .env.example .env   # set DATABASE_URL
npm run migrate
npm run dev
```

Production requires every non-optional value documented in `.env.example`,
including Supabase login, proof-ingestor, GitHub webhook, base URL, and Merkle
signing configuration. Generate the session secret with
`openssl rand -hex 32`, and allow `https://<your-domain>/auth/callback` in the
Supabase Auth redirect URL configuration. `MERKLE_SIGNING_SEED` must be a
hex-encoded 32-byte Ed25519 seed. `DONATION_URL` is optional and must use HTTPS.

### Verified GitHub checks

Configure a GitHub repository webhook for `check_run` events pointing to
`POST /webhooks/github`. Set `GITHUB_WEBHOOK_SECRET`, `PROOF_INGEST_SECRET`,
and `PROOF_DATABASE_URL`. The proof database URL must authenticate as the
limited `horkos_proof_ingestor` role created by migration `003_proofs.sql`.
Set that role's password once as the database administrator. A
`github_check` milestone freezes `repo`, `head_sha`, and `check_name`; claims
are refused until a matching successful signed webhook has been ingested.

## License

MIT. See [LICENSE](LICENSE).
