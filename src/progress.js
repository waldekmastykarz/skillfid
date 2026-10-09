import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const IMPORTANT_PATTERN = /(?:operation\s|jobs:|retrying|dataset ready:|evaluation complete:|dataset verification complete:|failed\b|error\b|interrupted)/i;
const IMPORTANT_TYPES = new Set(['checkpoint', 'complete', 'error', 'operation', 'retry', 'warning']);
const RATE_WINDOW_SECONDS = 300;
const MIN_RATE_SAMPLES = 8;

export function createProgressReporter({ mode = 'auto', intervalSeconds = 30, stream = process.stderr, startedAt = performance.now(), clock = () => performance.now() } = {}) {
  const resolvedMode = mode === 'auto' ? (stream.isTTY ? 'human' : 'agent') : mode;
  const options = { stream, startedAt, clock, intervalSeconds };
  if (resolvedMode === 'quiet') return new QuietProgressReporter();
  if (resolvedMode === 'human') return new HumanProgressReporter(options);
  if (resolvedMode === 'agent') return new AgentProgressReporter(options);
  if (resolvedMode === 'json') return new JsonProgressReporter(options);
  throw new Error(`Unknown progress mode: ${mode}`);
}

export class ProgressReporter {
  constructor(options = {}) {
    return createProgressReporter({ ...options, mode: options.mode ?? 'agent' });
  }
}

class BaseProgressReporter {
  constructor({ stream, startedAt, clock }) {
    this.stream = stream;
    this.startedAt = startedAt;
    this.clock = clock;
  }

  elapsedSeconds() {
    return (this.clock() - this.startedAt) / 1000;
  }

  close() {}
}

class HumanProgressReporter extends BaseProgressReporter {
  constructor(options) {
    super(options);
    this.state = { title: 'Working', current: 'Starting' };
    this.eta = new EtaEstimator();
    this.frame = 0;
    this.renderedLines = 0;
    this.timer = setInterval(() => this.render(), 80);
    this.timer.unref();
  }

  report(input) {
    const event = normalizeEvent(input);
    if (!event.phase && !event.current && event.message && !IMPORTANT_TYPES.has(event.type)) event.current = event.message;
    this.state = {
      ...this.state,
      ...pickDefined(event, ['workflow', 'title', 'phase', 'current', 'output', 'progress']),
      metrics: event.metrics ?? this.state.metrics,
    };
    if (event.progress) this.recordProgress(event.progress);
    if (event.type === 'complete') this.complete(event);
    else if (event.type === 'error') this.notice('error', event.message ?? event.current ?? 'Failed');
    else if (event.type === 'retry') this.notice('retry', event.message ?? 'Retrying');
    else if (event.type === 'warning') this.notice('warning', event.message ?? 'Warning');
    else this.render();
  }

  close() {
    clearInterval(this.timer);
    this.clear();
  }

  render() {
    if (this.finished) return;
    const elapsed = this.elapsedSeconds();
    const lines = [`\x1b[36m${SPINNER[this.frame++ % SPINNER.length]}\x1b[0m  \x1b[1m${this.state.title}\x1b[0m`];
    if (this.state.progress) {
      const { done, total, label } = this.state.progress;
      const ratio = total > 0 ? Math.min(1, done / total) : 0;
      const percentageValue = done >= total ? 100 : Math.floor(ratio * 100);
      const percentage = total > 0 ? `  \x1b[2m${percentageValue}%\x1b[0m` : '';
      lines.push(`   \x1b[36m${progressBar(ratio)}\x1b[0m  \x1b[1m${done}/${total}\x1b[0m ${label}${percentage}`);
    } else if (this.state.metrics) {
      lines.push(...Object.entries(this.state.metrics).map(([label, value]) => `   ${label.padEnd(11)} ${value}`));
    }
    if (this.state.progress && this.state.metrics) lines.push(`   \x1b[2m${formatMetrics(this.state.metrics)}\x1b[0m`);
    lines.push(`   \x1b[2m${this.state.current ?? this.state.phase ?? 'Working'}\x1b[0m`);
    lines.push(`   \x1b[2m${formatElapsed(elapsed)} elapsed${formatRemaining(this.remainingSeconds(elapsed))}\x1b[0m`);
    this.clear();
    const width = Number.isInteger(this.stream.columns) ? Math.max(1, this.stream.columns - 1) : Infinity;
    this.stream.write(lines.map((line) => fitTerminalLine(line, width)).join('\n'));
    this.renderedLines = lines.length;
  }

  complete(event) {
    this.clear();
    this.finished = true;
    const lines = [`\x1b[32m[ok]\x1b[0m ${event.title ?? this.state.title}  \x1b[2m${formatElapsed(this.elapsedSeconds())}\x1b[0m`];
    for (const line of event.summary ?? []) lines.push(`     ${line}`);
    if (event.output) lines.push(`     Output: ${event.output}`);
    this.stream.write(`${lines.join('\n')}\n`);
    this.state.current = undefined;
  }

  notice(kind, message) {
    this.clear();
    const marker = kind === 'error' ? '\x1b[31m[error]\x1b[0m' : kind === 'warning' ? '\x1b[33m[warn]\x1b[0m' : '\x1b[33m[retry]\x1b[0m';
    this.stream.write(`${marker} ${message}\n`);
    this.render();
  }

  recordProgress(progress) {
    this.eta.record(progress, this.elapsedSeconds());
  }

  remainingSeconds(elapsed) {
    return this.eta.remaining(this.state.progress, elapsed);
  }

  clear() {
    if (!this.renderedLines) return;
    this.stream.write('\r\x1b[2K');
    for (let index = 1; index < this.renderedLines; index += 1) this.stream.write('\x1b[1A\r\x1b[2K');
    this.renderedLines = 0;
  }
}

class AgentProgressReporter extends BaseProgressReporter {
  constructor(options) {
    super(options);
    this.intervalSeconds = options.intervalSeconds;
    this.lastWrittenAt = -Infinity;
    this.lastSignature = undefined;
    this.lastFailed = 0;
    this.eta = new EtaEstimator();
    this.latest = {};
  }

  // Lines carry the workflow, stage mix, counts, failures and ETA, and repeat only when something changed.
  report(input) {
    const event = normalizeEvent(input);
    const elapsed = this.elapsedSeconds();
    if (event.workflow) this.latest.workflow = event.workflow;
    if (event.progress) { this.latest.progress = event.progress; this.eta.record(event.progress, elapsed); }
    if (event.metrics) this.latest.metrics = event.metrics;
    const failed = Number(event.metrics?.failed ?? this.lastFailed);
    const newFailure = failed > this.lastFailed;
    this.lastFailed = failed;
    if (!IMPORTANT_TYPES.has(event.type) && !newFailure) {
      if (elapsed - this.lastWrittenAt < this.intervalSeconds) return;
      if (this.signature() === this.lastSignature && elapsed - this.lastWrittenAt < this.intervalSeconds * 4) return;
    }
    const parts = [`elapsed=${Math.round(elapsed)}s`];
    if (this.latest.workflow) parts.push(`workflow=${this.latest.workflow}`);
    if (event.type !== 'update' && event.type !== 'progress') parts.push(`event=${event.type}`);
    if (event.phase) parts.push(`phase=${formatValue(event.phase)}`);
    const progress = event.type === 'complete' && !event.progress ? undefined : this.latest.progress;
    if (progress && Number.isFinite(progress.total) && progress.total > 0) {
      parts.push(`progress=${formatValue(`${progress.done}/${progress.total} ${progress.label ?? ''}`.trim())}`);
      const remaining = this.eta.remaining(progress, elapsed);
      if (Number.isFinite(remaining)) parts.push(`eta=${compactDuration(remaining)}`);
    }
    for (const [key, value] of Object.entries(this.latest.metrics ?? {})) parts.push(`${key}=${formatValue(value)}`);
    parts.push(`message=${JSON.stringify(event.message ?? event.current ?? event.title ?? event.type)}`);
    this.stream.write(`[progress] ${parts.join(' ')}\n`);
    this.lastWrittenAt = elapsed;
    this.lastSignature = this.signature();
  }

  signature() {
    const progress = this.latest.progress;
    return JSON.stringify([progress?.done, progress?.total, this.latest.metrics]);
  }
}

class JsonProgressReporter extends BaseProgressReporter {
  report(input) {
    const event = normalizeEvent(input);
    this.stream.write(`${JSON.stringify({ ...event, elapsedSeconds: Number(this.elapsedSeconds().toFixed(1)) })}\n`);
  }
}

class QuietProgressReporter {
  report() {}
  close() {}
}

function eventType(message) {
  if (/retrying/i.test(message)) return 'retry';
  if (/jobs:/i.test(message)) return 'checkpoint';
  if (/failed|error|interrupted/i.test(message)) return 'error';
  if (/dataset ready:|evaluation complete:|dataset verification complete:/i.test(message)) return 'complete';
  if (/operation\s/i.test(message)) return 'operation';
  return 'progress';
}

export function normalizeEvent(input) {
  if (typeof input === 'string') return { type: eventType(input), message: input };
  if (!input || typeof input !== 'object') throw new TypeError('Progress events must be strings or objects');
  return { type: 'update', ...input };
}

function pickDefined(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function formatElapsed(seconds) {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes ? `${minutes}m ${String(remainder).padStart(2, '0')}s` : `${remainder}s`;
}

function formatRemaining(seconds) {
  if (seconds === undefined) return '';
  if (seconds === null) return ' · estimating remaining time';
  if (!Number.isFinite(seconds)) return ' · remaining time uncertain';
  return ` · about ${formatElapsed(seconds)} remaining`;
}

function progressBar(ratio, width = 16) {
  const filled = ratio >= 1 ? width : Math.floor(ratio * width);
  return `${'━'.repeat(filled)}${'─'.repeat(width - filled)}`;
}

function fitTerminalLine(line, width) {
  if (!Number.isFinite(width)) return line;
  const tokens = line.match(/\x1b\[[0-?]*[ -/]*[@-~]|./gu) ?? [];
  let visible = 0;
  let output = '';
  for (const token of tokens) {
    if (token.startsWith('\x1b[')) output += token;
    else if (visible < width) { output += token; visible += 1; }
    else return `${output}\x1b[0m`;
  }
  return output;
}

function formatValue(value) {
  const text = String(value);
  return /^[\w.:,/%+-]+$/.test(text) ? text : JSON.stringify(text);
}

function formatMetrics(metrics) {
  return Object.entries(metrics).map(([key, value]) => `${key} ${value}`).join(' · ');
}

function compactDuration(seconds) {
  const rounded = Math.max(0, Math.round(seconds));
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  return minutes < 60 ? `${minutes}m${String(rounded % 60).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

// Estimates remaining time from the recent completion rate of the job's steadiest work unit.
export class EtaEstimator {
  constructor() { this.samples = []; }

  record(progress, elapsed) {
    if (!Number.isFinite(progress.done) || !Number.isFinite(progress.total)) return;
    const estimateDone = progress.eta?.done ?? progress.etaDone ?? progress.done;
    const last = this.samples.at(-1);
    if (!last || estimateDone > last.done) {
      this.samples.push({ done: estimateDone, elapsed });
      // Keep a few minutes of history so bursts of concurrent completions do not swing the rate.
      const recent = this.samples.filter((sample) => elapsed - sample.elapsed <= RATE_WINDOW_SECONDS);
      this.samples = recent.length >= MIN_RATE_SAMPLES ? recent : this.samples.slice(-MIN_RATE_SAMPLES);
    }
  }

  remaining(progress, elapsed) {
    if (!progress || progress.done >= progress.total || progress.total <= 0) return undefined;
    const samples = this.samples;
    if (samples.length < 2 || elapsed < 5) return null;
    // An explicit ETA unit lets callers estimate in steadier work than the displayed measure.
    if (progress.eta && !Number.isFinite(progress.eta.total)) return null;
    const first = samples[0];
    const last = samples.at(-1);
    const rate = (last.done - first.done) / (last.elapsed - first.elapsed);
    if (rate <= 0) return null;
    const remainingWork = progress.eta ? progress.eta.total - progress.eta.done : progress.total - progress.done;
    const remainingAtLastSample = remainingWork / rate;
    const remaining = remainingAtLastSample - (elapsed - last.elapsed);
    return remaining > 0 ? remaining : Number.NaN;
  }
}

// Mirrors progress to <work-dir>/progress.json (latest snapshot) and events.jsonl (important events) so agents can read
// state without opening the SQLite journal. Write failures never affect the run.
export function createFileSink({ directory, pid = process.pid, startedAt = Date.now(), now = () => Date.now(), command }) {
  const snapshotPath = path.join(directory, 'progress.json');
  const eventsPath = path.join(directory, 'events.jsonl');
  const eta = new EtaEstimator();
  const state = { pid, state: 'running', startedAt: new Date(startedAt).toISOString(), ...(command ? { command } : {}), warnings: [], failures: [] };
  let lastSnapshotAt = 0;
  let lastEventAt = 0;
  let ready = false;
  // The estimator needs the full progress (including its ETA unit); the snapshot only exposes the displayed measure.
  let latestProgress;
  const prepare = () => {
    if (ready) return true;
    try {
      mkdirSync(directory, { recursive: true });
      try { if (statSync(eventsPath).size > 2_000_000) writeFileSync(eventsPath, ''); } catch { /* no events file yet */ }
      ready = true;
    } catch { /* observability is best effort */ }
    return ready;
  };
  const writeSnapshot = () => {
    if (!prepare()) return;
    const elapsedSeconds = Math.round((now() - startedAt) / 1000);
    const remaining = eta.remaining(latestProgress, elapsedSeconds);
    const snapshot = { ...state, updatedAt: new Date(now()).toISOString(), elapsedSeconds, ...(Number.isFinite(remaining) ? { etaSeconds: Math.round(remaining) } : {}) };
    try {
      const temporary = `${snapshotPath}.${pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
      renameSync(temporary, snapshotPath);
    } catch { /* best effort */ }
    lastSnapshotAt = now();
  };
  return {
    snapshotPath,
    eventsPath,
    report(input) {
      let event;
      try { event = normalizeEvent(input); } catch { return; }
      if (event.workflow) state.workflow = event.workflow;
      if (event.title) state.title = event.title;
      if (event.details?.operationId) state.operationId = event.details.operationId;
      if (event.details?.journalPath) state.journalPath = event.details.journalPath;
      if (event.current || event.message) state.current = event.current ?? event.message;
      if (event.progress) {
        state.progress = { done: event.progress.done, total: event.progress.total, label: event.progress.label };
        latestProgress = event.progress;
        eta.record(event.progress, Math.round((now() - startedAt) / 1000));
      }
      if (event.metrics) state.metrics = event.metrics;
      if (event.type === 'warning') state.warnings = [...state.warnings, event.message].slice(-5);
      if (event.type === 'error') { state.lastError = event.message; state.failures = [...state.failures, event.message].slice(-20); }
      const important = IMPORTANT_TYPES.has(event.type);
      if (important || now() - lastSnapshotAt >= 1000) writeSnapshot();
      if (important || now() - lastEventAt >= 5000) {
        if (prepare()) {
          try { appendFileSync(eventsPath, `${JSON.stringify({ at: new Date(now()).toISOString(), pid, ...event })}\n`); } catch { /* best effort */ }
        }
        lastEventAt = now();
      }
    },
    finish(status, message) {
      state.state = status;
      if (message) state.current = message;
      writeSnapshot();
    },
    close() {},
  };
}

// Lets the CLI create the console reporter before it knows which work directory the command uses.
export function createProgressHub(reporter) {
  let sink;
  return {
    report(event) { reporter.report(event); sink?.report(event); },
    attach(newSink) { sink = newSink; },
    finish(status, message) { sink?.finish(status, message); },
    close() { reporter.close(); sink?.close(); },
  };
}