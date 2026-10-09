import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import { planDataset } from '../src/plan.js';

const root = '.work/js-tests/cli-operations';
afterEach(async () => rm(root, { recursive: true, force: true }));

const run = (...args) => spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });

async function corpus(files) {
  await mkdir(`${root}/corpus`, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(`${root}/corpus/${name}`, content);
  return `${root}/corpus`;
}

const chapter = (title) => `## ${title}\n\n${'The service rejects uploads above the configured limit. '.repeat(30)}\n\n`;

test('dataset plan estimates sections, calls and time before anything is spent', async () => {
  const dir = await corpus({ 'guide.md': `# Guide\n\n${chapter('One')}${chapter('Two')}${chapter('Three')}` });
  const plan = await planDataset({ corpusPath: dir, options: { concurrency: 5 } });
  assert.equal(plan.documents, 1);
  assert.equal(plan.sections, 3);
  assert.equal(plan.concurrency, 5);
  assert.ok(plan.characters > 4000 && plan.estimatedTokens === Math.round(plan.characters / 4));
  assert.ok(plan.estimate.copilotCalls > 0 && plan.estimate.minutes.low <= plan.estimate.minutes.high);
  assert.match(plan.warnings.join(' '), /Only 3 sections for concurrency 5/);
  const quick = await planDataset({ corpusPath: dir, options: { concurrency: 5, importance: ['high'] } });
  assert.ok(quick.estimate.knowledgeItems < plan.estimate.knowledgeItems);
  assert.match(plan.largestSections[0].label, /^guide\.md › Guide/);
});

test('dataset plan works through the CLI in human and JSON form and honors --exclude', async () => {
  const dir = await corpus({ 'a.md': `# A\n\n${chapter('Alpha')}`, 'skip.md': `# Skip\n\n${chapter('Skipped')}` });
  const human = run('--quiet', 'dataset', 'plan', '--corpus', dir, '--exclude', 'skip.md');
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Corpus: 1 document, \d+ sections?/);
  assert.match(human.stdout, /Time at concurrency 10: roughly/);
  const json = JSON.parse(run('--quiet', '--json', 'dataset', 'plan', '--corpus', dir, '--profile', 'quick').stdout);
  assert.deepEqual(json.importance, ['high']);
  assert.equal(json.documents, 2);
});

test('invalid build options fail as usage errors', () => {
  assert.equal(run('--quiet', 'dataset', 'plan', '--corpus', 'x', '--profile', 'fast').status, 2);
  assert.equal(run('--quiet', 'dataset', 'plan', '--corpus', 'x', '--profile', 'quick', '--importance', 'high').status, 2);
  assert.equal(run('--quiet', 'dataset', 'plan', '--corpus', 'x', '--importance', 'urgent').status, 2);
  assert.equal(run('--quiet', 'dataset', 'plan', '--corpus', 'x', '--max-section-chars', '100').status, 2);
});

test('--detach reports an immediate failure of the background run with its structured error', () => {
  const result = run('--json', 'dataset', 'build', '--corpus', `${root}/missing`, '--work-dir', `${root}/work`, '--detach');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const { error } = JSON.parse(result.stderr);
  assert.match(error.message, /Corpus directory does not exist/);
});

test('--detach is limited to long-running commands', () => {
  const result = run('operation', 'status', '--work-dir', root, '--detach');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--detach is only valid for/);
});

test('the agent skill in skills/skillfid has the frontmatter that `npx skills add` needs to discover it', async () => {
  const skill = await readFile('skills/skillfid/SKILL.md', 'utf8');
  assert.match(skill, /^---\nname: skillfid\ndescription: .{40,}\n---\n/);
});
