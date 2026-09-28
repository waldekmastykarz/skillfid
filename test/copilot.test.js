import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createProgressReporter, ProgressReporter } from '../src/progress.js';

test('legacy progress reporter uses bounded agent output', () => {
  let output = '';
  const reporter = new ProgressReporter({ stream: { write: (value) => { output += value; } }, startedAt: 10_000, clock: () => 12_500 });
  reporter.report('Evaluating question 1/3');
  assert.equal(output, '[progress] elapsed=3s message="Evaluating question 1/3"\n');
});

test('agent progress throttles routine events but always reports checkpoints', () => {
  let output = '';
  let now = 0;
  const reporter = createProgressReporter({ mode: 'agent', intervalSeconds: 30, stream: { write: (value) => { output += value; } }, startedAt: 0, clock: () => now });
  reporter.report('Starting work');
  now = 5_000; reporter.report('Routine detail');
  now = 6_000; reporter.report('Evaluation jobs: completed 1, running 2, pending 3, failed 0');
  assert.equal(output.split('\n').filter(Boolean).length, 2);
  assert.match(output, /suppressed=1/);
  assert.match(output, /Evaluation jobs/);
});

test('JSON progress emits structured JSON Lines', () => {
  let output = '';
  const reporter = createProgressReporter({ mode: 'json', stream: { write: (value) => { output += value; } }, startedAt: 0, clock: () => 1_500 });
  reporter.report('Copilot transient 429 failure; retrying job');
  assert.deepEqual(JSON.parse(output), { type: 'retry', elapsedSeconds: 1.5, message: 'Copilot transient 429 failure; retrying job' });
});

test('auto progress uses human rendering for a TTY and clears it on close', () => {
  let output = '';
  const stream = { isTTY: true, write: (value) => { output += value; } };
  const reporter = createProgressReporter({ mode: 'auto', stream, startedAt: 0, clock: () => 2_000 });
  reporter.report('Working');
  reporter.close();
  assert.match(output, /Working/);
  assert.match(output, /\x1b\[2K/);
});

test('human progress renders aggregate metrics and a compact completion summary', () => {
  let output = '';
  const reporter = createProgressReporter({ mode: 'human', stream: { write: (value) => { output += value; } }, startedAt: 0, clock: () => 2_000 });
  reporter.report({ type: 'start', workflow: 'dataset', title: 'Building dataset', phase: 'Inventorying knowledge', metrics: { Corpus: '1 document, 2 sections', Sections: '1/2 complete', Results: '3 knowledge items, 1 question' } });
  reporter.report({ type: 'complete', title: 'Dataset built', summary: ['2 sections, 3 knowledge items, 2 questions', 'Coverage 100%, calibration passed'], output: 'datasets/example' });
  const completedOutput = output;
  reporter.render();
  reporter.close();
  assert.equal(output, completedOutput);
  assert.match(output, /Building dataset/);
  assert.match(output, /Sections\s+1\/2 complete/);
  assert.match(output, /\[ok\].*Dataset built/);
  assert.match(output, /Coverage 100%, calibration passed/);
  assert.match(output, /Output: datasets\/example/);
  assert.doesNotMatch(output, /operation_|operations\.sqlite/);
});

test('human progress renders one primary measure, current work, and ETA', () => {
  let output = '';
  let now = 0;
  const reporter = createProgressReporter({ mode: 'human', stream: { write: (value) => { output += value; } }, startedAt: 0, clock: () => now });
  reporter.report({ type: 'start', title: 'Evaluating skill', current: 'Preparing evaluations', progress: { done: 0, total: 10, label: 'evaluations complete' } });
  now = 10_000;
  reporter.report({ type: 'update', current: 'Answering 4 · judging 2', progress: { done: 2, total: 10, label: 'evaluations complete' } });
  now = 20_000;
  reporter.report({ type: 'update', current: 'Answering 3 · judging 3', progress: { done: 4, total: 10, label: 'evaluations complete' } });
  reporter.close();
  assert.match(output, /4\/10.*evaluations complete.*40%/);
  assert.match(output, /Answering 3 · judging 3/);
  assert.match(output, /20s elapsed · about 30s remaining/);
});

test('human progress keeps repeated frames within narrow terminal rows', () => {
  let output = '';
  const stream = { columns: 32, write: (value) => { output += value; } };
  const reporter = createProgressReporter({ mode: 'human', stream, startedAt: 0, clock: () => 10_000 });
  reporter.report({ type: 'start', title: 'Evaluating skill', current: 'A long status that would otherwise wrap', progress: { done: 1, total: 291, label: 'questions evaluated' } });
  reporter.report({ type: 'update', current: 'Another long status that would otherwise wrap', progress: { done: 2, total: 291, label: 'questions evaluated' } });
  reporter.close();
  const renderedLines = output.split('\n').filter((line) => !line.includes('\x1b[1A'));
  assert.ok(renderedLines.every((line) => line.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').length <= 31));
  assert.equal(output.match(/\x1b\[1A/g)?.length, 6);
});

test('human progress counts ETA down between completion updates', () => {
  let output = '';
  let now = 0;
  const reporter = createProgressReporter({ mode: 'human', stream: { write: (value) => { output += value; } }, startedAt: 0, clock: () => now });
  reporter.report({ type: 'update', current: 'Working', progress: { done: 0, total: 10, label: 'jobs complete' } });
  now = 10_000;
  reporter.report({ type: 'update', current: 'Working', progress: { done: 2, total: 10, label: 'jobs complete' } });
  assert.match(output, /about 40s remaining/);
  now = 15_000;
  reporter.render();
  reporter.close();
  assert.match(output, /15s elapsed · about 35s remaining/);
});

test('human progress estimates time in explicit ETA units', () => {
  let output = '';
  let now = 0;
  const reporter = createProgressReporter({ mode: 'human', stream: { write: (value) => { output += value; } }, startedAt: 0, clock: () => now });
  reporter.report({ type: 'update', current: 'Working', progress: { done: 0, total: 0, eta: { done: 0, total: undefined }, label: 'knowledge items covered' } });
  now = 10_000;
  reporter.report({ type: 'update', current: 'Working', progress: { done: 0, total: 50, eta: { done: 5, total: undefined }, label: 'knowledge items covered' } });
  assert.match(output, /estimating remaining time/);
  now = 20_000;
  reporter.report({ type: 'update', current: 'Working', progress: { done: 0, total: 50, eta: { done: 10, total: 40 }, label: 'knowledge items covered' } });
  reporter.close();
  assert.match(output, /0\/50.*knowledge items covered/);
  assert.match(output, /20s elapsed · about 1m 00s remaining/);
});

test('human progress keeps incomplete work below 100% and expires stale ETA', () => {
  let output = '';
  let now = 0;
  const reporter = createProgressReporter({ mode: 'human', stream: { write: (value) => { output += value; } }, startedAt: 0, clock: () => now });
  reporter.report({ type: 'update', current: 'Working', progress: { done: 0, total: 1055, label: 'knowledge items covered' } });
  now = 10_000;
  reporter.report({ type: 'update', current: 'Working', progress: { done: 1051, total: 1055, label: 'knowledge items covered' } });
  now = 11_000;
  reporter.render();
  reporter.close();
  assert.match(output, /1051\/1055.*knowledge items covered.*99%/);
  assert.doesNotMatch(output, /1051\/1055.*100%/);
  assert.match(output, /remaining time uncertain/);
});

test('quiet progress emits nothing', () => {
  let output = '';
  const reporter = createProgressReporter({ mode: 'quiet', stream: { write: (value) => { output += value; } } });
  reporter.report('Ignored');
  reporter.close();
  assert.equal(output, '');
});
