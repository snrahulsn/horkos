import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool.js';
import { recordRejectedAssertion, recordVerifiedAssertion } from '../core/proofs.js';
function validSignature(body, signature) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret || !signature?.startsWith('sha256='))
        return false;
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
/** Ingest a GitHub check_run webhook and attach it only to exact frozen criteria. */
export async function ingestGitHubCheckRun(body, signature, event) {
    if (!validSignature(body, signature))
        throw new Error('invalid GitHub webhook signature');
    if (event !== 'check_run')
        return { accepted: true, matched: 0 };
    const payload = JSON.parse(body);
    const run = payload.check_run;
    const repo = payload.repository?.full_name;
    if (payload.action !== 'completed' || !run?.id || !run?.head_sha || !run?.name || !repo) {
        return { accepted: true, matched: 0 };
    }
    const { rows } = await pool.query(`SELECT m.id AS milestone_id, m.oath_id
     FROM milestones m JOIN oaths o ON m.oath_id = o.id
     WHERE m.criteria_type = 'github_check'
       AND m.criteria_detail->>'repo' = $1
       AND lower(m.criteria_detail->>'head_sha') = lower($2)
       AND m.criteria_detail->>'check_name' = $3
       AND m.status = 'OPEN' AND o.status IN ('OPEN','CLAIMED')`, [repo, run.head_sha, run.name]);
    const assertion = {
        repo,
        head_sha: run.head_sha,
        check_name: run.name,
        conclusion: run.conclusion,
        details_url: run.html_url ?? run.details_url ?? null,
        app: run.app?.slug ?? null,
    };
    const secret = process.env.PROOF_INGEST_SECRET ?? '';
    for (const row of rows) {
        const input = {
            oath_id: row.oath_id,
            milestone_id: row.milestone_id,
            kind: 'outcome',
            source: 'github_check_run',
            external_id: `${repo}:${run.id}:${row.milestone_id}`,
            assertion,
            observed_at: run.completed_at ?? new Date().toISOString(),
            adapter_version: 'github-check-run-v1',
        };
        if (run.conclusion === 'success')
            await recordVerifiedAssertion(secret, input);
        else
            await recordRejectedAssertion(secret, input);
    }
    return { accepted: true, matched: rows.length };
}
//# sourceMappingURL=github.js.map