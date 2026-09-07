export class AsyncLimiter {
  constructor(limit = 10, onChange = undefined) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency must be a positive integer');
    if (onChange !== undefined && typeof onChange !== 'function') throw new Error('onChange must be a function');
    this.limit = limit;
    this.onChange = onChange;
    this.active = 0;
    this.queue = [];
    this.completed = 0;
    this.failed = 0;
  }

  get stats() {
    return { limit: this.limit, active: this.active, queued: this.queue.length, completed: this.completed, failed: this.failed };
  }

  run(task) {
    if (typeof task !== 'function') throw new Error('Limited task must be a function');
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.#drain();
      this.#notify();
    });
  }

  #drain() {
    while (this.active < this.limit && this.queue.length) {
      const { task, resolve, reject } = this.queue.shift();
      this.active += 1;
      Promise.resolve().then(task).then((value) => {
        this.completed += 1;
        this.active -= 1;
        this.#drain();
        this.#notify();
        resolve(value);
      }, (error) => {
        this.failed += 1;
        this.active -= 1;
        this.#drain();
        this.#notify();
        reject(error);
      });
    }
  }

  #notify() {
    this.onChange?.(this.stats);
  }
}

export async function mapConcurrent(items, limit, task) {
  if (!Array.isArray(items)) throw new TypeError('Concurrent items must be an array');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency must be a positive integer');
  if (typeof task !== 'function') throw new TypeError('Concurrent task must be a function');
  const results = new Array(items.length);
  let nextIndex = 0;
  let failure;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try { results[index] = await task(items[index], index); }
      catch (error) { failure ??= error; }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return results;
}

export function limitRunner(runner, limiter) {
  return {
    run: (...args) => limiter.run(() => runner.run(...args)),
    listSkills: (...args) => limiter.run(() => runner.listSkills(...args)),
    version: (...args) => limiter.run(() => runner.version(...args)),
  };
}
