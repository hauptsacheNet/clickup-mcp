import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * ClickUp lengthened its generated task IDs in August 2026: tasks created before
 * then have 9-character IDs (e.g. 86ey1qwck), tasks created after have 10-character
 * IDs (e.g. z8nrz7c746). Both must be accepted. ClickUp's own API documents task_id
 * only as a string with no length constraint, so the bound here is a sanity check
 * against URLs and prefixed IDs rather than a spec.
 */

test('isTaskId accepts both legacy and current ClickUp task ID lengths', async () => {
  process.env.CLICKUP_API_KEY = 'test-key';
  process.env.CLICKUP_TEAM_ID = 'team1';

  const { isTaskId } = await import('../shared/utils');

  assert.equal(isTaskId('86ey1qwck'), true, '9-character IDs (pre-Aug 2026) must stay valid');
  assert.equal(isTaskId('z8nrz7c746'), true, '10-character IDs (post-Aug 2026) must be valid');
  assert.equal(isTaskId('123yxuagf4a'), true, '11-character IDs (observed late Aug 2026) must be valid');
});

test('isTaskId still rejects strings that are not bare task IDs', async () => {
  process.env.CLICKUP_API_KEY = 'test-key';
  process.env.CLICKUP_TEAM_ID = 'team1';

  const { isTaskId } = await import('../shared/utils');

  assert.equal(isTaskId('abc'), false, 'too short');
  assert.equal(isTaskId('CU-86ey1qwck'), false, 'prefixed IDs are not bare IDs');
  assert.equal(isTaskId('https://app.clickup.com/t/86ey1qwck'), false, 'URLs are not bare IDs');
  assert.equal(isTaskId('a'.repeat(17)), false, 'beyond the upper bound');
});
