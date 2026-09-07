import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AsyncLimiter, limitRunner, mapConcurrent } from '../src/concurrency.js';

test('limits concurrent work and drains queued tasks', async () => {
  const limiter = new AsyncLimiter(2);
  let active = 0;
  let peak = 0;
  const releases = [];
  const tasks = Array.from({ length: 5 }, (_, index) => limiter.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return index;
  }));

  await Promise.resolve();
  assert.equal(limiter.stats.active, 2);
  assert.equal(limiter.stats.queued, 3);
  let released = 0;
  while (released < 5) {
    if (!releases.length) await new Promise((resolve) => setImmediate(resolve));
    const wave = releases.splice(0);
    released += wave.length;
    wave.forEach((release) => release());
  }
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.deepEqual(limiter.stats, { limit: 2, active: 0, queued: 0, completed: 5, failed: 0 });
});

test('releases permits when work fails', async () => {
  const limiter = new AsyncLimiter(1);
  await assert.rejects(limiter.run(async () => { throw new Error('failed'); }), /failed/);
  assert.equal(await limiter.run(async () => 'next'), 'next');
  assert.deepEqual(limiter.stats, { limit: 1, active: 0, queued: 0, completed: 1, failed: 1 });
});

test('maps a bounded number of items without admitting more work after failure', async () => {
  const started = [];
  let releaseSecond;
  const second = new Promise((resolve) => { releaseSecond = resolve; });
  const result = mapConcurrent([0, 1, 2, 3], 2, async (item) => {
    started.push(item);
    if (item === 0) throw new Error('failed');
    if (item === 1) await second;
    return item;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]);
  releaseSecond();
  await assert.rejects(result, /failed/);
  assert.deepEqual(started, [0, 1]);
});

test('reports active and queued work when limiter state changes', async () => {
  const states = [];
  const limiter = new AsyncLimiter(1, (state) => states.push(state));
  let release;
  const blocked = limiter.run(() => new Promise((resolve) => { release = resolve; }));
  const queued = limiter.run(async () => 'queued');
  assert.deepEqual(states.at(-1), { limit: 1, active: 1, queued: 1, completed: 0, failed: 0 });
  await Promise.resolve();
  release('blocked');
  await Promise.all([blocked, queued]);
  assert.deepEqual(states.at(-1), { limit: 1, active: 0, queued: 0, completed: 2, failed: 0 });
});

test('applies one limiter to all runner methods', async () => {
  const calls = [];
  const runner = {
    async run(value) { calls.push(['run', value]); return value; },
    async listSkills(value) { calls.push(['listSkills', value]); return []; },
    async version() { calls.push(['version']); return 'test'; },
  };
  const limited = limitRunner(runner, new AsyncLimiter(10));
  assert.equal(await limited.run('answer'), 'answer');
  assert.deepEqual(await limited.listSkills('workspace'), []);
  assert.equal(await limited.version(), 'test');
  assert.deepEqual(calls, [['run', 'answer'], ['listSkills', 'workspace'], ['version']]);
});
