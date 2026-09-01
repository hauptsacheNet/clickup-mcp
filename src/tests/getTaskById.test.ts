import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';

// Helper to register tool and call handler

test('getTaskById makes correct API calls', async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = 'test-key';
  process.env.CLICKUP_TEAM_ID = 'team1';

  const { registerTaskToolsRead } = await import('../tools/task-tools');

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get('https://api.clickup.com');

  client.intercept({ path: '/api/v2/team', method: 'GET' })
    .reply(200, { teams: [{ id: 'team1', members: [] }] });

  client.intercept({ path: /\/api\/v2\/task\/task123.*/, method: 'GET' })
    .reply(200, {
      id: 'task123',
      name: 'Test Task',
      markdown_description: '',
      attachments: [],
      creator: { username: 'creator', id: '1' },
      assignees: [],
      list: { id: 'list1', name: 'List' },
      space: { id: 'space1', name: 'Space' },
      status: { status: 'open', type: 'open' },
      url: 'https://app.clickup.com/t/task123',
      date_created: '0',
      date_updated: '0'
    });

  client.intercept({ path: /\/api\/v2\/task\/task123\/comment.*/, method: 'GET' })
    .reply(200, { comments: [] });

  client.intercept({ path: '/api/v2/task/task123/time_in_status', method: 'GET' })
    .reply(200, { status_history: [], current_status: null });

  client.intercept({ path: /\/api\/v2\/team\/team1\/time_entries.*/, method: 'GET' })
    .reply(200, { data: [] });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    }
  } as any;

  registerTaskToolsRead(serverStub, { user: { username: 'me', id: 'u1' } });

  const result = await tools.getTaskById({ id: 'task123' });
  assert.ok(result.content.some((block: any) =>
    typeof block.text === 'string' && block.text.includes('task_id: task123')
  ));

  (mockAgent as any).assertNoPendingInterceptors();
  await mockAgent.close();
  t.mock.timers.reset();
});


test('getTaskById renders dependencies and linked tasks', async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = 'test-key';
  process.env.CLICKUP_TEAM_ID = 'team1';

  const { registerTaskToolsRead } = await import('../tools/task-tools');

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get('https://api.clickup.com');

  // No /api/v2/team interceptor: the team lookup is memoized by the module and
  // was already resolved by the first test in this file.

  client.intercept({ path: /\/api\/v2\/task\/task123.*/, method: 'GET' })
    .reply(200, {
      id: 'task123',
      name: 'Test Task',
      markdown_description: '',
      attachments: [],
      creator: { username: 'creator', id: '1' },
      assignees: [],
      list: { id: 'list1', name: 'List' },
      space: { id: 'space1', name: 'Space' },
      status: { status: 'open', type: 'open' },
      url: 'https://app.clickup.com/t/task123',
      date_created: '0',
      date_updated: '0',
      // Single flat array for both directions, as the API returns it
      dependencies: [
        { task_id: 'task123', depends_on: 'blocker1', type: 1 },
        { task_id: 'blocked1', depends_on: 'task123', type: 1 }
      ],
      linked_tasks: [{ task_id: 'task123', link_id: 'related1' }]
    });

  client.intercept({ path: /\/api\/v2\/task\/task123\/comment.*/, method: 'GET' })
    .reply(200, { comments: [] });

  client.intercept({ path: '/api/v2/task/task123/time_in_status', method: 'GET' })
    .reply(200, { status_history: [], current_status: null });

  client.intercept({ path: /\/api\/v2\/team\/team1\/time_entries.*/, method: 'GET' })
    .reply(200, { data: [] });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    }
  } as any;

  registerTaskToolsRead(serverStub, { user: { username: 'me', id: 'u1' } });

  const result = await tools.getTaskById({ id: 'task123' });
  const text = result.content
    .filter((block: any) => typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n');

  assert.match(text, /^waiting_on: blocker1$/m);
  assert.match(text, /^blocking: blocked1$/m);
  assert.match(text, /^linked_tasks: related1$/m);

  (mockAgent as any).assertNoPendingInterceptors();
  await mockAgent.close();
  t.mock.timers.reset();
});

test('getTaskById omits dependency lines when there are none', async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = 'test-key';
  process.env.CLICKUP_TEAM_ID = 'team1';

  const { registerTaskToolsRead } = await import('../tools/task-tools');

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get('https://api.clickup.com');

  // No /api/v2/team interceptor: the team lookup is memoized by the module and
  // was already resolved by the first test in this file.

  client.intercept({ path: /\/api\/v2\/task\/task123.*/, method: 'GET' })
    .reply(200, {
      id: 'task123',
      name: 'Test Task',
      markdown_description: '',
      attachments: [],
      creator: { username: 'creator', id: '1' },
      assignees: [],
      list: { id: 'list1', name: 'List' },
      space: { id: 'space1', name: 'Space' },
      status: { status: 'open', type: 'open' },
      url: 'https://app.clickup.com/t/task123',
      date_created: '0',
      date_updated: '0',
      dependencies: [],
      linked_tasks: []
    });

  client.intercept({ path: /\/api\/v2\/task\/task123\/comment.*/, method: 'GET' })
    .reply(200, { comments: [] });

  client.intercept({ path: '/api/v2/task/task123/time_in_status', method: 'GET' })
    .reply(200, { status_history: [], current_status: null });

  client.intercept({ path: /\/api\/v2\/team\/team1\/time_entries.*/, method: 'GET' })
    .reply(200, { data: [] });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    }
  } as any;

  registerTaskToolsRead(serverStub, { user: { username: 'me', id: 'u1' } });

  const result = await tools.getTaskById({ id: 'task123' });
  const text = result.content
    .filter((block: any) => typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n');

  assert.doesNotMatch(text, /^waiting_on:/m);
  assert.doesNotMatch(text, /^blocking:/m);
  assert.doesNotMatch(text, /^linked_tasks:/m);

  (mockAgent as any).assertNoPendingInterceptors();
  await mockAgent.close();
  t.mock.timers.reset();
});
