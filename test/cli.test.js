import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';

import { interruptionMessage, resumeCommand } from '../src/cli.js';
import { operationId, OperationJournal } from '../src/journal.js';

test('help is self-contained for agent callers', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Examples:/);
  assert.match(result.stdout, /Prerequisites:/);
  assert.match(result.stdout, /JSON success schemas:/);
  assert.match(result.stdout, /Exit codes:/);
  assert.match(result.stdout, /--skill-invocation <mode>/);
  assert.match(result.stdout, /auto or explicit \(default: auto\)/);
  assert.match(result.stdout, /--concurrency <count>/);
  assert.match(result.stdout, /default: 10; no maximum/);
  assert.match(result.stdout, /--timeout-retries <count>/);
  assert.match(result.stdout, /Retries after a session timeout \(default: 1\)/);
  assert.match(result.stdout, /Attempts to repair malformed JSON \(default: 3\)/);
  assert.match(result.stdout, /dataset recalibrate --dataset/);
  assert.match(result.stdout, /--fresh/);
  assert.doesNotMatch(result.stdout, /--no-resume/);
  assert.match(result.stdout, /--progress <mode>/);
  assert.match(result.stdout, /operation status/);
  assert.match(result.stdout, /eval report --run/);
  assert.match(result.stdout, /eval baseline --dataset/);
  assert.match(result.stdout, /--baseline-dir <dir>/);
  assert.match(result.stdout, /--output <file>/);
  assert.doesNotMatch(result.stdout, /\bspike\b/);
});

test('removed spike command is rejected', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'spike'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command: spike/);
  assert.doesNotMatch(result.stderr, /Valid commands:.*spike/);
});

test('concurrency has no artificial maximum', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'dataset', 'build', '--corpus', 'missing', '--concurrency', '1000'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Invalid --concurrency/);
});

test('timeout retries allow zero but reject negative values', () => {
  const disabled = spawnSync(process.execPath, ['src/cli.js', 'dataset', 'build', '--corpus', 'missing', '--timeout-retries', '0'], { encoding: 'utf8' });
  assert.equal(disabled.status, 1);
  assert.doesNotMatch(disabled.stderr, /Invalid --timeout-retries/);

  const invalid = spawnSync(process.execPath, ['src/cli.js', 'dataset', 'build', '--corpus', 'missing', '--timeout-retries=-1'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Invalid --timeout-retries/);
});

test('reuse and fresh flags are mutually exclusive', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'dataset', 'build', '--corpus', 'missing', '--resume', '--fresh'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot be used together/);
});

test('no-resume is rejected', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'dataset', 'build', '--corpus', 'missing', '--no-resume'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option '--no-resume'/);
});

test('interruption output provides the exact command needed to resume', () => {
  const args = ['--progress', 'human', 'dataset', 'build', '--corpus', 'docs and notes', '--work-dir', '.work/build', '--fresh'];
  const command = "npm start -- --progress human dataset build --corpus 'docs and notes' --work-dir .work/build --resume";
  assert.equal(resumeCommand(args), command);
  assert.equal(interruptionMessage(args), `Extraction interrupted\nAny completed work was saved.\n\nRun this command to continue:\n${command}\n`);
  const recalibrationArgs = ['dataset', 'recalibrate', '--dataset', 'datasets/source', '--work-dir', '.work/recalibrate', '--fresh'];
  const recalibrationCommand = 'npm start -- dataset recalibrate --dataset datasets/source --work-dir .work/recalibrate --resume';
  assert.equal(resumeCommand(recalibrationArgs), recalibrationCommand);
  assert.equal(interruptionMessage(recalibrationArgs), `Recalibration interrupted\nAny completed work was saved.\n\nRun this command to continue:\n${recalibrationCommand}\n`);
  const baselineArgs = ['eval', 'baseline', '--dataset', 'datasets/source', '--work-dir', '.work/baseline', '--fresh'];
  const baselineCommand = 'npm start -- eval baseline --dataset datasets/source --work-dir .work/baseline --resume';
  assert.equal(resumeCommand(baselineArgs), baselineCommand);
  assert.equal(interruptionMessage(baselineArgs), `Baseline interrupted\nAny completed work was saved.\n\nRun this command to continue:\n${baselineCommand}\n`);
  assert.equal(resumeCommand(['dataset', 'verify', '--dataset', 'example']), undefined);
});

test('usage failures are actionable and return exit code 2', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'dataset', 'build'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing required option --corpus/);
});

test('recalibration requires a source dataset', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'dataset', 'recalibrate'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing required option --dataset for 'dataset recalibrate'/);
});

test('baseline evaluation requires a dataset', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'eval', 'baseline'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing required option --dataset for 'eval baseline'/);
});

test('report requires run and dataset inputs', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'eval', 'report', '--run', 'run'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Missing required option --dataset for 'eval report'/);
});

test('version prints only the version', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '0.6.0\n');
});

test('invalid skill invocation mode lists valid values', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', 'eval', 'run', '--dataset', 'dataset', '--skill', 'skill', '--skill-invocation', 'forced'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid --skill-invocation value "forced"/);
  assert.match(result.stderr, /Valid values: auto, explicit/);
});

test('progress aliases conflict with explicit incompatible modes', () => {
  const quiet = spawnSync(process.execPath, ['src/cli.js', '--quiet', '--progress', 'human', 'unknown'], { encoding: 'utf8' });
  assert.equal(quiet.status, 2);
  assert.match(quiet.stderr, /--quiet conflicts/);
  const agent = spawnSync(process.execPath, ['src/cli.js', '--agent', '--progress=json', 'unknown'], { encoding: 'utf8' });
  assert.equal(agent.status, 2);
  assert.match(agent.stderr, /--agent conflicts/);
});

test('progress JSON Lines stay on stderr while final JSON stays on stdout', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', '--json', '--progress', 'json', 'operation', 'status', '--work-dir', 'missing'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /"type":"start"/);
  assert.match(result.stderr, /Operation journal not found/);
});

test('quiet suppresses progress but not command errors', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', '--quiet', 'operation', 'status', '--work-dir', 'missing'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /\[progress\]/);
  assert.match(result.stderr, /Operation journal not found/);
});

test('progress interval must be positive', () => {
  const result = spawnSync(process.execPath, ['src/cli.js', '--progress-interval', '0', 'unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Invalid --progress-interval value/);
});

test('human operation status is concise and contains no internal identifiers or JSON', async () => {
  const workDir = '.work/js-tests/cli-status';
  const journal = await OperationJournal.open(`${workDir}/operations.sqlite`);
  const id = operationId('evaluation', { test: true });
  journal.startOperation({ operationId: id, kind: 'evaluation', inputs: { test: true } });
  journal.close();
  try {
    const result = spawnSync(process.execPath, ['src/cli.js', '--quiet', 'operation', 'status', '--work-dir', workDir], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Operations\n  evaluation  running  0\/0 jobs complete · last activity \d+s ago\n$/);
    assert.doesNotMatch(result.stdout, /operationId|operations\.sqlite|\{|\}/);
  } finally { await rm(workDir, { recursive: true, force: true }); }
});

test('human operation status identifies expired work as stalled', async () => {
  const workDir = '.work/js-tests/cli-stalled-status';
  const journal = await OperationJournal.open(`${workDir}/operations.sqlite`, { clock: () => 0, leaseMs: 1 });
  const id = operationId('evaluation', { stale: true });
  journal.startOperation({ operationId: id, kind: 'evaluation', inputs: { stale: true } });
  const job = journal.ensureJob({ operationId: id, stage: 'condition', entityId: 'one', inputs: {} });
  journal.claimJob(job.jobId, 'abandoned-worker');
  journal.close();
  try {
    const result = spawnSync(process.execPath, ['src/cli.js', '--quiet', 'operation', 'status', '--work-dir', workDir], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /evaluation  stalled  0\/1 jobs complete · last activity/);
  } finally { await rm(workDir, { recursive: true, force: true }); }
});