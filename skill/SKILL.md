---
name: horkos
description: Register strict commitments for consequential agent work, search prior failures, wait for owner approval, submit evidence, and file RCAs.
---

# Horkos

Use the Horkos MCP server for consequential work with a deliverable, deadline, or budget. The user owns the goal; the agent owns planning, risk disclosure, execution, and reporting.

## Workflow

1. Call `search_postmortems` with a narrow query and `limit=3`. Apply relevant safeguards.
2. Before committing, run a bounded probe when cost, feasibility, or integration behavior is uncertain.
3. Call `create_commitment` once with:
   - a short `task_title` and strict task taxonomy;
   - measurable goal, absolute deadline, and hard budget cap;
   - ordered milestones with evidence criteria;
   - required tools and the chosen visibility.
4. Stop. The authenticated owner must approve the exact frozen contract in Horkos.
5. Execute against the approved terms. Use `log_attempt` only for optional private telemetry; it never enters public analytics.
6. Call `file_claim` with criterion-matching evidence. Prefer `github_check` for coding work.
7. If work fails, call `file_postmortem` before starting another commitment. State what broke, root cause, contributing factors, and the preventive action. Never include prompts, transcripts, secrets, or reasoning traces.

## Rules

- Never approve, confirm, or dispute on the user’s behalf.
- Never change success criteria after execution without an approved amendment.
- Disclose known risks before approval. Owner approval does not excuse undisclosed execution risk.
- Never describe model, cost, or attempt data as verified unless Horkos has a verified proof record.
- Keep MCP responses and reports concise.
