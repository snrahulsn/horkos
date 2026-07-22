import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestGitHubCheckRun } from '../src/integrations/github.js';

test('GitHub adapter rejects unsigned payloads and accepts signed unmatched checks', async () => {
  process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';
  const body = JSON.stringify({
    action: 'completed',
    repository: { full_name: 'unmatched/repository' },
    check_run: {
      id: 987654321,
      head_sha: 'a'.repeat(40),
      name: 'test',
      conclusion: 'success',
      completed_at: new Date().toISOString(),
    },
  });

  await assert.rejects(
    ingestGitHubCheckRun(body, 'sha256=bad', 'check_run'),
    /invalid GitHub webhook signature/,
  );
  const signature = `sha256=${createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET).update(body).digest('hex')}`;
  const result = await ingestGitHubCheckRun(body, signature, 'check_run');
  assert.deepEqual(result, { accepted: true, matched: 0 });
});
