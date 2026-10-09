import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { approveAll } from '@github/copilot-sdk';

import { CopilotSdkRunner } from '../src/copilot-sdk.js';

const root = path.resolve('.work/js-tests/copilot-sdk');
afterEach(async () => rm(root, { recursive: true, force: true }));

test('reuses one SDK client across isolated concurrent sessions', async () => {
  const closedWorkspace = path.join(root, 'closed');
  const skillWorkspace = path.join(root, 'skill');
  const skillDirectory = path.join(skillWorkspace, '.github', 'skills', 'ax-practitioner');
  await Promise.all([mkdir(closedWorkspace, { recursive: true }), mkdir(skillDirectory, { recursive: true })]);
  const created = [];
  let clientOptions;
  let starts = 0;
  let stops = 0;
  const client = {
    async start() { starts += 1; },
    async createSession(config) {
      created.push(config);
      return {
        async sendAndWait({ prompt }) { return { data: { content: config.agent ? `skill:${prompt}` : `closed:${prompt}` } }; },
        async disconnect() {},
      };
    },
    async forceStop() { stops += 1; },
  };
  const runner = new CopilotSdkRunner({}, { createClient: (options) => { clientOptions = options; return client; } });

  const [closed, skill] = await Promise.all([
    runner.run(closedWorkspace, 'Question'),
    runner.run(skillWorkspace, '/ax-practitioner\n\nQuestion'),
  ]);
  await runner.close();

  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(Object.hasOwn(clientOptions, 'gitHubToken'), false);
  assert.equal(Object.hasOwn(clientOptions, 'useLoggedInUser'), false);
  assert.equal(closed.answer, 'closed:Question');
  assert.equal(skill.answer, 'skill:Question');
  assert.equal(created[0].skillDirectories.length, 0);
  assert.deepEqual(created[1].skillDirectories, [skillDirectory]);
  assert.equal(created[1].agent, 'skillfid-explicit');
  assert.deepEqual(created[1].customAgents[0].skills, ['ax-practitioner']);
  assert.equal(created[1].onPermissionRequest, approveAll);
  assert.deepEqual(created[1].excludedTools, ['shell', 'write', 'url']);
  assert.equal(created[1].enableConfigDiscovery, false);
  assert.equal(created[1].enableSessionStore, false);
});

test('lists configured skills as project skills and formats the runtime version', async () => {
  const workspace = path.join(root, 'workspace');
  const skillDirectory = path.join(workspace, '.github', 'skills', 'ax-practitioner');
  await mkdir(skillDirectory, { recursive: true });
  const client = {
    async start() {},
    async createSession() {
      return {
        rpc: { skills: { async list() { return { skills: [{ name: 'ax-practitioner', path: path.join(skillDirectory, 'SKILL.md'), source: 'custom' }] }; } } },
        async disconnect() {},
      };
    },
    async getStatus() { return { version: '1.0.80', protocolVersion: 3 }; },
    async forceStop() {},
  };
  const runner = new CopilotSdkRunner({}, { createClient: () => client });

  const skills = await runner.listSkills(workspace);

  assert.equal(skills[0].source, 'project');
  assert.equal(await runner.version(), 'GitHub Copilot CLI 1.0.80.');
  await runner.close();
});

test('retries a timed-out SDK session without restarting the client', async () => {
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  let sessions = 0;
  let starts = 0;
  const progress = [];
  const client = {
    async start() { starts += 1; },
    async createSession() {
      sessions += 1;
      const attempt = sessions;
      return {
        async sendAndWait() {
          if (attempt === 1) throw new Error('Timeout after 10ms waiting for session.idle');
          return { data: { content: 'answer' } };
        },
        async disconnect() {},
      };
    },
    async forceStop() {},
  };
  const runner = new CopilotSdkRunner({ maxTimeoutRetries: 1, progress: (event) => progress.push(event) }, { createClient: () => client });

  const result = await runner.run(workspace, 'Question');

  assert.equal(result.answer, 'answer');
  assert.equal(starts, 1);
  assert.equal(sessions, 2);
  assert.match(progress[0].message, /timeout retry 1\/1/);
  await runner.close();
});
test('returns a trace built from session events', async () => {
  const workspace = path.join(root, 'trace-workspace');
  const skillDirectory = path.join(workspace, '.github', 'skills', 'ax-practitioner');
  await mkdir(path.join(skillDirectory, 'references'), { recursive: true });
  await writeFile(path.join(skillDirectory, 'SKILL.md'), 'Skill body');
  await writeFile(path.join(skillDirectory, 'references', 'a.md'), '12345');
  const handlers = new Set();
  let unsubscribed = 0;
  const emit = (event) => handlers.forEach((handler) => handler(event));
  const client = {
    async start() {},
    async createSession() {
      return {
        on(handler) { handlers.add(handler); return () => { handlers.delete(handler); unsubscribed += 1; }; },
        async sendAndWait() {
          emit({ type: 'assistant.turn_start', data: {} });
          emit({ type: 'skill.invoked', data: { name: 'ax-practitioner', path: path.join(skillDirectory, 'SKILL.md') } });
          emit({ type: 'tool.execution_start', data: { toolCallId: '1', toolName: 'view', arguments: { path: path.join(skillDirectory, 'references', 'a.md') } } });
          emit({ type: 'assistant.usage', data: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 4 } });
          return { data: { content: 'answer' } };
        },
        async disconnect() {},
      };
    },
    async forceStop() {},
  };
  const runner = new CopilotSdkRunner({}, { createClient: () => client });

  const result = await runner.run(workspace, 'Question');

  assert.equal(result.answer, 'answer');
  assert.deepEqual(result.trace, {
    skillLoaded: true,
    skillName: 'ax-practitioner',
    filesRead: [{ path: '.github/skills/ax-practitioner/SKILL.md', bytes: 10 }, { path: '.github/skills/ax-practitioner/references/a.md', bytes: 5 }],
    toolCalls: [{ name: 'view', target: path.join(skillDirectory, 'references', 'a.md') }],
    turns: 1, inputTokens: 10, outputTokens: 3, cachedTokens: 4,
  });
  assert.equal(unsubscribed, 1);
  await runner.close();
});

test('traces a closed-book run and a preloaded explicit skill without session events', async () => {
  const closed = path.join(root, 'trace-closed');
  const skilled = path.join(root, 'trace-skilled');
  await mkdir(closed, { recursive: true });
  await mkdir(path.join(skilled, '.github', 'skills', 'ax'), { recursive: true });
  await writeFile(path.join(skilled, '.github', 'skills', 'ax', 'SKILL.md'), 'abc');
  const client = { async start() {}, async createSession() { return { async sendAndWait() { return { data: { content: 'x' } }; }, async disconnect() {} }; }, async forceStop() {} };
  const runner = new CopilotSdkRunner({}, { createClient: () => client });
  assert.equal((await runner.run(closed, 'Q')).trace.skillLoaded, null);
  assert.equal((await runner.run(skilled, 'Q')).trace.skillLoaded, false);
  const explicit = (await runner.run(skilled, '/ax\n\nQ')).trace;
  assert.equal(explicit.skillLoaded, true);
  assert.deepEqual(explicit.filesRead, [{ path: '.github/skills/ax/SKILL.md', bytes: 3 }]);
  await runner.close();
});
