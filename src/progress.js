import { performance } from 'node:perf_hooks';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const IMPORTANT_PATTERN = /(?:operation\s|jobs:|retrying|dataset ready:|evaluation complete:|dataset verification complete:|failed\b|error\b|interrupted)/i;
const IMPORTANT_TYPES = new Set(['checkpoint', 'complete', 'error', 'operation', 'retry']);

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
    this.estimate = { samples: [] };
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
      metrics: event.metrics,
    };
    if (event.progress) this.recordProgress(event.progress);
    if (event.type === 'complete') this.complete(event);
    else if (event.type === 'error') this.notice('error', event.message ?? event.current ?? 'Failed');
    else if (event.type === 'retry') this.notice('retry', event.message ?? 'Retrying');
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
    const marker = kind === 'error' ? '\x1b[31m[error]\x1b[0m' : '\x1b[33m[retry]\x1b[0m';
    this.stream.write(`${marker} ${message}\n`);
    this.render();
  }

  recordProgress(progress) {
    if (!Number.isFinite(progress.done) || !Number.isFinite(progress.total)) return;
    const elapsed = this.elapsedSeconds();
    const estimateDone = progress.etaDone ?? progress.done;
    const last = this.estimate.samples.at(-1);
    if (!last || estimateDone > last.done) {
      this.estimate.samples.push({ done: estimateDone, elapsed });
      this.estimate.samples = this.estimate.samples.slice(-8);
    }
  }

  remainingSeconds(elapsed) {
    const progress = this.state.progress;
    if (!progress || progress.done >= progress.total || progress.total <= 0) return undefined;
    const samples = this.estimate.samples;
    if (samples.length < 2 || elapsed < 5) return null;
    const first = samples[0];
    const last = samples.at(-1);
    const rate = (last.done - first.done) / (last.elapsed - first.elapsed);
    if (rate <= 0) return null;
    const remainingAtLastSample = (progress.total - progress.done) / rate;
    const remaining = remainingAtLastSample - (elapsed - last.elapsed);
    return remaining > 0 ? remaining : Number.NaN;
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
    this.suppressed = 0;
  }

  report(input) {
    const event = normalizeEvent(input);
    const elapsed = this.elapsedSeconds();
    const important = IMPORTANT_TYPES.has(event.type);
    if (!important && elapsed - this.lastWrittenAt < this.intervalSeconds) { this.suppressed += 1; return; }
    const suppressed = this.suppressed ? ` suppressed=${this.suppressed}` : '';
    const phase = event.phase ? ` phase=${JSON.stringify(event.phase)}` : '';
    const metrics = event.metrics && Object.keys(event.metrics).length ? ` metrics=${JSON.stringify(event.metrics)}` : '';
    const message = event.message ?? event.current ?? event.title ?? event.type;
    this.stream.write(`[progress] elapsed=${Math.round(elapsed)}s${suppressed}${phase}${metrics} message=${JSON.stringify(message)}\n`);
    this.lastWrittenAt = elapsed;
    this.suppressed = 0;
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

function normalizeEvent(input) {
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