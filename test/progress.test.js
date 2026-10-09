import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { afterEach, test } from 'node:test';

import { createFileSink, createProgressHub, createProgressReporter } from '../src/progress.js';

const root = '.work/js-tests/progress';
afterEach(async () => rm(root, { recursive: true, force: true }));

function agentReporter(intervalSeconds = 30) {
  let now = 0;
  const lines = [];
  const reporter = createProgressReporter({ mode: 'agent', intervalSeconds, stream: { write: (text) => lines.push(text.trimEnd()) }, startedAt: 0, clock: () => now * 1000 });
  return { reporter, lines, at: (seconds) => { now = seconds; } };
}

const update = (overrides = {}) => ({ type: 'update', workflow: 'dataset', current: 'Calibrating questions · doc.md › Intro (lines 1–9)', progress: { done: 10, total: 100, label: 'knowledge items covered', eta: { done: 20, total: 200 } }, metrics: { sections: '3/40', running: 10, failed: 0, stages: 'inventory:2,calibration:8', calls: 20 }, ...overrides });

test('agent lines carry the workflow, stage mix, counts, ETA and a human message instead of "update"', () => {
  const { reporter, lines, at } = agentReporter(10);
  at(0); reporter.report(update({ progress: { done: 0, total: 100, label: 'knowledge items covered', eta: { done: 0, total: undefined } }, metrics: { sections: '0/40', running: 10, failed: 0, stages: 'inventory:10', calls: 0 } }));
  for (let step = 1; step <= 10; step += 1) {
    at(step * 10);
    reporter.report(update({ progress: { done: step, total: 100, label: 'knowledge items covered', eta: { done: step * 20, total: 400 } }, metrics: { sections: `${step}/40`, running: 10, failed: 0, stages: 'inventory:2,calibration:8', calls: step * 20 } }));
  }
  const last = lines.at(-1);
  assert.match(last, /^\[progress\] elapsed=100s workflow=dataset progress="10\/100 knowledge items covered" eta=\d+m\d+s /);
  assert.match(last, /sections=10\/40 running=10 failed=0 stages=inventory:2,calibration:8 calls=200/);
  assert.match(last, /message="Calibrating questions · doc\.md › Intro \(lines 1–9\)"/);
  assert.doesNotMatch(lines.join('\n'), /message="update"/);
});

test('unchanged state is not repeated every interval, but a heartbeat still appears eventually', () => {
  const { reporter, lines, at } = agentReporter(10);
  at(0); reporter.report(update());
  at(11); reporter.report(update());
  at(22); reporter.report(update());
  assert.equal(lines.length, 1);
  at(41); reporter.report(update());
  assert.equal(lines.length, 2);
  at(55); reporter.report(update({ metrics: { sections: '4/40', running: 10, failed: 0, stages: 'inventory:2,calibration:8', calls: 25 } }));
  assert.equal(lines.length, 3);
});

test('failures and warnings are reported immediately with their message, not on the next interval', () => {
  const { reporter, lines, at } = agentReporter(30);
  at(0); reporter.report(update());
  at(1); reporter.report(update({ metrics: { sections: '3/40', running: 9, failed: 1, stages: 'calibration:9', calls: 21 } }));
  at(2); reporter.report({ type: 'error', workflow: 'dataset', message: 'Section failed: doc.md › Hard (lines 5–90): Inventory did not converge' });
  at(3); reporter.report({ type: 'warning', workflow: 'dataset', message: 'doc.md › Big did not settle in 3 passes; extending to 6' });
  assert.equal(lines.length, 4);
  assert.match(lines[1], /failed=1/);
  assert.match(lines[2], /event=error .*message="Section failed: doc\.md › Hard \(lines 5–90\): Inventory did not converge"/);
  assert.match(lines[3], /event=warning/);
});

test('the file sink mirrors the latest state to progress.json and notable events to events.jsonl', async () => {
  let now = 1_000_000;
  const sink = createFileSink({ directory: root, pid: 4242, startedAt: now, now: () => now, command: 'skillfid dataset build --corpus c --resume' });
  sink.report({ type: 'operation', workflow: 'dataset', message: 'Dataset operation x', details: { operationId: 'dataset_abc', journalPath: 'j' } });
  now += 6000;
  sink.report(update());
  now += 2000;
  sink.report({ type: 'error', workflow: 'dataset', message: 'Section failed: doc.md › Hard' });
  sink.finish('failed', 'Build failed');
  const snapshot = JSON.parse(await readFile(sink.snapshotPath, 'utf8'));
  assert.equal(snapshot.pid, 4242);
  assert.equal(snapshot.state, 'failed');
  assert.equal(snapshot.operationId, 'dataset_abc');
  assert.equal(snapshot.workflow, 'dataset');
  assert.equal(snapshot.command, 'skillfid dataset build --corpus c --resume');
  assert.deepEqual(snapshot.progress, { done: 10, total: 100, label: 'knowledge items covered' });
  assert.equal(snapshot.metrics.stages, 'inventory:2,calibration:8');
  assert.deepEqual(snapshot.failures, ['Section failed: doc.md › Hard']);
  assert.equal(snapshot.current, 'Build failed');
  const events = (await readFile(sink.eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.type), ['operation', 'update', 'error']);
});

test('the file sink estimates time in the progress ETA unit, not the displayed measure', async () => {
  let now = 0;
  const sink = createFileSink({ directory: root, pid: 1, startedAt: 0, now: () => now });
  for (const [seconds, calls] of [[0, 10], [10, 20], [20, 30]]) {
    now = seconds * 1000;
    sink.report({ type: 'update', workflow: 'dataset', progress: { done: 1, total: 100, label: 'knowledge items covered', eta: { done: calls, total: 1000 } } });
  }
  now = 20_000;
  sink.finish('running');
  const snapshot = JSON.parse(await readFile(sink.snapshotPath, 'utf8'));
  // 970 calls remain at one call per second.
  assert.ok(snapshot.etaSeconds > 900 && snapshot.etaSeconds < 1000, `etaSeconds was ${snapshot.etaSeconds}`);
  assert.deepEqual(Object.keys(snapshot.progress).sort(), ['done', 'label', 'total']);
});

test('the hub forwards events to the console reporter and the attached sink', async () => {
  const { reporter, lines } = agentReporter(1);
  const hub = createProgressHub(reporter);
  hub.report({ type: 'complete', workflow: 'dataset', title: 'Before attach' });
  hub.attach(createFileSink({ directory: root, pid: 1 }));
  hub.report({ type: 'operation', workflow: 'dataset', message: 'Dataset operation x', details: { operationId: 'dataset_hub' } });
  hub.finish('completed');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(await readFile(`${root}/progress.json`, 'utf8')).operationId, 'dataset_hub');
  hub.close();
});
