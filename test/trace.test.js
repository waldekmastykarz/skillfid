import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { inventorySkill, skillDisclosure, skillFileHashes, skillFilesRead, summarizeDisclosure, TraceCollector } from '../src/trace.js';

const root = path.resolve('.work/js-tests/trace');
afterEach(async () => rm(root, { recursive: true, force: true }));

async function workspaceWithSkill() {
  const skill = path.join(root, 'ws', '.github', 'skills', 'canopy');
  await mkdir(path.join(skill, 'references'), { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '# Canopy\n12345');
  await writeFile(path.join(skill, 'references', 'limits.md'), '1234567890');
  return { workspace: path.join(root, 'ws'), skill };
}

test('collects tool calls, file reads, turns and usage from session events', async () => {
  const { workspace, skill } = await workspaceWithSkill();
  const collector = new TraceCollector({ workspace, skillsAvailable: true });
  for (const event of [
    { type: 'assistant.turn_start', data: {} },
    { type: 'assistant.usage', data: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 40 } },
    { type: 'tool.execution_start', data: { toolCallId: 'a', toolName: 'skill', arguments: { skill: 'canopy' } } },
    { type: 'skill.invoked', data: { name: 'canopy', path: path.join(skill, 'SKILL.md'), content: 'x' } },
    { type: 'assistant.turn_start', data: {} },
    { type: 'tool.execution_start', data: { toolCallId: 'b', toolName: 'view', arguments: { path: path.join(skill, 'references', 'limits.md') } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'b', success: true } },
    { type: 'tool.execution_start', data: { toolCallId: 'c', toolName: 'view', arguments: { path: path.join(skill, 'references', 'missing.md') } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'c', success: false } },
    { type: 'tool.execution_start', data: { toolCallId: 'd', toolName: 'view', arguments: { path: '/etc/hosts' } } },
    { type: 'tool.execution_start', data: { toolCallId: 'e', toolName: 'grep', arguments: { pattern: 'limit' } } },
    { type: 'assistant.usage', data: { inputTokens: 50, outputTokens: 7 } },
    { type: 'something.unknown', data: { surprise: true } },
    undefined,
    { type: 'tool.execution_start' },
  ]) collector.handle(event);

  const trace = await collector.finalize();

  assert.equal(trace.skillLoaded, true);
  assert.equal(trace.skillName, 'canopy');
  assert.deepEqual(trace.filesRead, [{ path: '.github/skills/canopy/SKILL.md', bytes: 14 }, { path: '.github/skills/canopy/references/limits.md', bytes: 10 }]);
  assert.deepEqual(trace.toolCalls.map((call) => call.name), ['skill', 'view', 'view', 'view', 'grep']);
  assert.equal(trace.toolCalls[4].target, 'limit');
  assert.equal(trace.turns, 2);
  assert.equal(trace.inputTokens, 150);
  assert.equal(trace.outputTokens, 12);
  assert.equal(trace.cachedTokens, 40);
});

test('a skill whose frontmatter name differs from its directory is not counted as two files', async () => {
  const { workspace, skill } = await workspaceWithSkill();
  const collector = new TraceCollector({ workspace, skillsAvailable: true });
  collector.handle({ type: 'tool.execution_start', data: { toolCallId: 'a', toolName: 'skill', arguments: { skill: 'arbor-cache-policy' } } });
  collector.handle({ type: 'skill.invoked', data: { name: 'arbor-cache-policy', path: path.join(skill, 'SKILL.md') } });
  const trace = await collector.finalize();
  assert.deepEqual(trace.filesRead, [{ path: '.github/skills/canopy/SKILL.md', bytes: 14 }]);
  assert.equal(trace.skillName, 'arbor-cache-policy');
  const disclosure = skillDisclosure(trace, [{ path: 'SKILL.md', bytes: 14 }]);
  assert.equal(disclosure.filesRead, 1);
  assert.equal(disclosure.fractionOfSkillLoaded, 1);
  const nameOnly = new TraceCollector({ workspace, skillsAvailable: true });
  nameOnly.handle({ type: 'tool.execution_start', data: { toolCallId: 'a', toolName: 'skill', arguments: { skill: 'ghost' } } });
  assert.deepEqual((await nameOnly.finalize()).filesRead, []);
});

test('distinguishes unused skills from closed-book runs', async () => {
  const { workspace } = await workspaceWithSkill();
  const unused = await new TraceCollector({ workspace, skillsAvailable: true }).finalize();
  assert.equal(unused.skillLoaded, false);
  assert.equal('skillName' in unused, false);
  const closedBook = await new TraceCollector({ workspace, skillsAvailable: false }).finalize();
  assert.equal(closedBook.skillLoaded, null);
  assert.equal('cachedTokens' in closedBook, false);
});

test('treats a direct SKILL.md read or a preloaded skill as loaded', async () => {
  const { workspace, skill } = await workspaceWithSkill();
  const read = new TraceCollector({ workspace, skillsAvailable: true });
  read.handle({ type: 'tool.execution_start', data: { toolCallId: '1', toolName: 'view', arguments: { path: path.join(skill, 'SKILL.md') } } });
  assert.equal((await read.finalize()).skillLoaded, true);
  const preloaded = await new TraceCollector({ workspace, skillsAvailable: true, preloadedSkill: { name: 'canopy', path: path.join(skill, 'SKILL.md') } }).finalize();
  assert.equal(preloaded.skillLoaded, true);
  assert.deepEqual(preloaded.filesRead, [{ path: '.github/skills/canopy/SKILL.md', bytes: 14 }]);
  const toolOnly = new TraceCollector({ workspace, skillsAvailable: true });
  toolOnly.handle({ type: 'tool.execution_start', data: { toolCallId: '1', toolName: 'skill', arguments: { skill: 'canopy' } } });
  assert.deepEqual((await toolOnly.finalize()).filesRead, [{ path: '.github/skills/canopy/SKILL.md', bytes: 14 }]);
});

test('inventories a skill directory with sizes, hashes and text content', async () => {
  const { skill } = await workspaceWithSkill();
  await writeFile(path.join(skill, 'logo.png'), Buffer.from([1, 2, 3]));
  const files = await inventorySkill(skill);
  assert.deepEqual(files.map((file) => [file.path, file.bytes]), [['logo.png', 3], ['references/limits.md', 10], ['SKILL.md', 14]]);
  assert.equal(files[2].content, '# Canopy\n12345');
  assert.equal(files[0].content, undefined);
  assert.match(skillFileHashes(files)['SKILL.md'], /^[0-9a-f]{64}$/);
});

test('computes progressive-disclosure metrics per answer and in aggregate', () => {
  const files = [{ path: 'SKILL.md', bytes: 10 }, { path: 'a.md', bytes: 30 }, { path: 'b.md', bytes: 60 }];
  const trace = (...paths) => ({ skillLoaded: true, filesRead: paths.map((file) => ({ path: `.github/skills/s/${file}`, bytes: 1 })) });
  assert.deepEqual(skillFilesRead(trace('SKILL.md', 'a.md')).map((file) => file.path), ['SKILL.md', 'a.md']);
  const partial = skillDisclosure(trace('SKILL.md', 'a.md'), files);
  assert.deepEqual(partial, { skillLoaded: true, filesRead: 2, bytesRead: 40, fractionOfSkillLoaded: 0.4, loadedEverything: false });
  const everything = skillDisclosure(trace('SKILL.md', 'a.md', 'b.md', 'unknown.md'), files);
  assert.equal(everything.fractionOfSkillLoaded, 1);
  assert.equal(everything.filesRead, 3);
  assert.equal(everything.loadedEverything, true);
  // 90% of the bytes in only two files is not "everything"
  assert.equal(skillDisclosure(trace('SKILL.md', 'b.md'), files).loadedEverything, false);
  assert.equal(skillDisclosure({ skillLoaded: null, filesRead: [] }, files), undefined);
  assert.deepEqual(skillDisclosure({ skillLoaded: false, filesRead: [] }, files), { skillLoaded: false, filesRead: 0, bytesRead: 0, fractionOfSkillLoaded: 0, loadedEverything: false });
  assert.deepEqual(summarizeDisclosure([partial, everything, skillDisclosure({ skillLoaded: false, filesRead: [] }, files), undefined]), {
    meanFilesRead: 5 / 3, meanBytesRead: 140 / 3, meanFractionLoaded: 1.4 / 3, loadedEverythingRate: 1 / 3, skillLoadedRate: 2 / 3,
  });
  assert.equal(summarizeDisclosure([]).skillLoadedRate, null);
});
