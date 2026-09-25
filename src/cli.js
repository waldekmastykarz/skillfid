#!/usr/bin/env node

import path from 'node:path';
import { realpathSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { buildDataset, loadDataset, recalibrateDataset } from './dataset.js';
import { evaluateBaseline, evaluateDataset } from './evaluation.js';
import { OperationJournal } from './journal.js';
import { createProgressReporter } from './progress.js';
import { generateEvaluationReport } from './report.js';

const VERSION = '0.6.0';
let activeProgressReporter;

const HELP = `skillfid: evaluate how faithfully agent skills apply their source documentation

Examples:
  skillfid dataset build --corpus ./corpus --json
  skillfid dataset recalibrate --dataset ./datasets/ds_abc123 --json
  skillfid dataset verify --dataset ./datasets/ds_abc123 --json
  skillfid eval baseline --dataset ./datasets/ds_abc123 --json
  skillfid eval run --dataset ./datasets/ds_abc123 --skill ./skill --json
  skillfid eval report --run ./runs/run_abc123 --dataset ./datasets/ds_abc123
  skillfid operation status --work-dir .work/eval --json

Usage:
  skillfid [--json] [--quiet] dataset build --corpus <dir> [options]
  skillfid [--json] [--quiet] dataset recalibrate --dataset <dir> [options]
  skillfid [--json] [--quiet] dataset verify --dataset <dir>
  skillfid [--json] [--quiet] eval baseline --dataset <dir> [options]
  skillfid [--json] [--quiet] eval run --dataset <dir> --skill <dir> [options]
  skillfid [--json] [--quiet] eval report --run <dir> --dataset <dir> [options]
  skillfid [global-options] operation status --work-dir <dir> [--operation-id <id>]

Global options:
  --json                    Print a stable JSON object to stdout
  --quiet                   Suppress progress on stderr
  --agent                   Bounded agent progress (alias: --progress agent)
  --progress <mode>         auto, human, agent, json, or quiet (default: auto)
  --progress-interval <sec> Agent snapshot interval (default: 30)
  -h, --help                Show help; valid after any command
  --version                 Print the version

Build options:
  --corpus <dir>            Markdown corpus directory (required)
  --output-dir <dir>        Dataset output directory (default: datasets)
  --work-dir <dir>          Isolated working directory (default: .work/dataset)
  --model <name>            Copilot model (default: gpt-5.6-sol)
  --judge-model <name>      Oracle calibration judge (default: --model)
  --reasoning-effort <name> Reasoning effort (default: medium)
  --timeout <seconds>       Per-Copilot-call timeout (default: 600)
  --timeout-retries <count> Retries after a session timeout (default: 1)
  --max-attempts <count>    Attempts to repair malformed JSON (default: 3)
  --clean-residual-passes <count> Consecutive clean inventory passes (default: 1)
  --max-residual-passes <count>   Maximum inventory/audit passes (default: 3)
  --concurrency <count>     Parallel Copilot calls (default: 10; no maximum)
  --resume                  Reuse matching work from a prior attempt (default)
  --fresh                   Start from scratch without deleting prior state

Recalibration options:
  --dataset <dir>           Published schema v6 dataset directory (required)
  --output-dir <dir>        Dataset output directory (default: datasets)
  --work-dir <dir>          Isolated working directory (default: .work/recalibrate)
  --model <name>            Oracle model (default: source dataset)
  --judge-model <name>      Calibration judge (default: source dataset)
  --reasoning-effort <name> Reasoning effort (default: source dataset)
  --timeout <seconds>       Per-Copilot-call timeout (default: 600)
  --timeout-retries <count> Retries after a session timeout (default: 1)
  --max-attempts <count>    Attempts to repair malformed JSON (default: 3)
  --concurrency <count>     Parallel Copilot calls (default: 10; no maximum)
  --resume                  Reuse matching work from a prior attempt (default)
  --fresh                   Start from scratch without deleting prior state

Baseline options:
  --dataset <dir>           Published schema v6 dataset directory (required)
  --output-dir <dir>        Baseline output directory (default: baselines)
  --work-dir <dir>          Isolated working directory (default: .work/baseline)
  --model <name>            Subject model (default: dataset calibration)
  --judge-model <name>      Judge model (default: dataset calibration)
  --reasoning-effort <name> Reasoning effort (default: dataset calibration)
  --trials <count>          Trials per question (default: 3)
  --timeout <seconds>       Per-Copilot-call timeout (default: 600)
  --timeout-retries <count> Retries after a session timeout (default: 1)
  --concurrency <count>     Parallel Copilot calls (default: 10; no maximum)
  --resume                  Reuse matching work from a prior attempt (default)
  --fresh                   Start from scratch without deleting prior state

Evaluation options:
  --dataset <dir>           Published schema v6 dataset directory (required)
  --skill <dir>             Skill directory containing SKILL.md (required)
  --baseline-dir <dir>      Reusable baseline directory (default: baselines)
  --output-dir <dir>        Run output directory (default: runs)
  --work-dir <dir>          Isolated working directory (default: .work/eval)
  --model <name>            Subject model (default: dataset calibration)
  --judge-model <name>      Judge model (default: dataset calibration)
  --reasoning-effort <name> Reasoning effort (default: dataset calibration)
  --skill-invocation <mode> Skill invocation: auto or explicit (default: auto)
  --trials <count>          Trials per question and condition (default: 3)
  --timeout <seconds>       Per-Copilot-call timeout (default: 600)
  --timeout-retries <count> Retries after a session timeout (default: 1)
  --concurrency <count>     Parallel Copilot calls (default: 10; no maximum)
  --resume                  Reuse matching work from a prior attempt (default)
  --fresh                   Start from scratch without deleting prior state

Report options:
  --run <dir>               Completed evaluation run directory (required)
  --dataset <dir>           Dataset used by the evaluation run (required)
  -o, --output <file>       HTML output file (default: <run>/report.html)
  --title <text>            Report title (default: Skill evaluation)

Prerequisites:
  Node.js 24+ and GitHub Copilot CLI authenticated for Copilot access.

JSON success schemas:
  dataset build:  {"datasetPath":string,"status":"created"}
  dataset recalibrate: {"datasetPath":string,"sourceDatasetId":string,"status":"created"}
  dataset verify: {"datasetId":string,"evidenceRecords":number,"questions":number,"valid":true}
  eval baseline:  {"baselinePath":string,"status":"completed"}
  eval run:       {"runPath":string,"status":"completed"}
  eval report:    {"reportPath":string,"status":"created"}
  operation status: {"journalPath":string,"operations":[...]}

I/O contract:
  Primary output goes to stdout. Progress and errors go to stderr.

Exit codes:
  0  Success
  1  Runtime, validation, authentication, or Copilot failure
  2  Invalid command or option
  130 Interrupted by Ctrl-C
`;

const commonOptions = {
  json: { type: 'boolean', default: false },
  quiet: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', default: false },
};

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--version')) { process.stdout.write(`${VERSION}\n`); return; }
  if (!argv.length || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') { process.stdout.write(HELP); return; }
  const globals = extractGlobals(argv);
  const progressReporter = createProgressReporter({ mode: globals.progressMode, intervalSeconds: globals.progressInterval });
  activeProgressReporter = progressReporter;
  const progress = (message) => progressReporter.report(message);
  try {
    return await runCommand(globals, progress);
  } finally {
    progressReporter.close();
    if (activeProgressReporter === progressReporter) activeProgressReporter = undefined;
  }
}

async function runCommand(globals, progress) {
  const [group, command, ...commandArgs] = globals.args;
  if (group === 'dataset' && command === 'build') {
    const values = options(commandArgs, { corpus: { type: 'string' }, 'output-dir': stringOption('datasets'), 'work-dir': stringOption('.work/dataset'), model: stringOption('gpt-5.6-sol'), 'judge-model': { type: 'string' }, 'reasoning-effort': stringOption('medium'), timeout: stringOption('600'), 'timeout-retries': stringOption('1'), 'max-attempts': stringOption('3'), 'clean-residual-passes': stringOption('1'), 'max-residual-passes': stringOption('3'), concurrency: stringOption('10'), resume: { type: 'boolean' }, fresh: { type: 'boolean', default: false } });
    required(values, 'corpus', 'dataset build');
    const datasetPath = await buildDataset({ corpusPath: values.corpus, outputRoot: values['output-dir'], workRoot: values['work-dir'], options: { model: values.model, judgeModel: values['judge-model'] ?? values.model, reasoningEffort: values['reasoning-effort'], timeoutSeconds: positiveNumber(values.timeout, '--timeout'), timeoutRetries: nonNegativeInteger(values['timeout-retries'], '--timeout-retries'), maxAttempts: positiveInteger(values['max-attempts'], '--max-attempts'), cleanResidualPasses: positiveInteger(values['clean-residual-passes'], '--clean-residual-passes'), maxResidualPasses: positiveInteger(values['max-residual-passes'], '--max-residual-passes'), concurrency: positiveInteger(values.concurrency, '--concurrency'), resume: resolveResume(values) }, progress });
    output({ datasetPath, status: 'created' }, globals.json, `Output: ${displayPath(datasetPath)}`);
    return;
  }
  if (group === 'dataset' && command === 'recalibrate') {
    const values = options(commandArgs, { dataset: { type: 'string' }, 'output-dir': stringOption('datasets'), 'work-dir': stringOption('.work/recalibrate'), model: { type: 'string' }, 'judge-model': { type: 'string' }, 'reasoning-effort': { type: 'string' }, timeout: stringOption('600'), 'timeout-retries': stringOption('1'), 'max-attempts': stringOption('3'), concurrency: stringOption('10'), resume: { type: 'boolean' }, fresh: { type: 'boolean', default: false } });
    required(values, 'dataset', 'dataset recalibrate');
    const source = await loadDataset(values.dataset);
    const datasetPath = await recalibrateDataset({ datasetPath: values.dataset, outputRoot: values['output-dir'], workRoot: values['work-dir'], options: { model: values.model, judgeModel: values['judge-model'] ?? values.model, reasoningEffort: values['reasoning-effort'], timeoutSeconds: positiveNumber(values.timeout, '--timeout'), timeoutRetries: nonNegativeInteger(values['timeout-retries'], '--timeout-retries'), maxAttempts: positiveInteger(values['max-attempts'], '--max-attempts'), concurrency: positiveInteger(values.concurrency, '--concurrency'), resume: resolveResume(values) }, progress });
    output({ datasetPath, sourceDatasetId: source.datasetId, status: 'created' }, globals.json, `Output: ${displayPath(datasetPath)}`);
    return;
  }
  if (group === 'dataset' && command === 'verify') {
    const values = options(commandArgs, { dataset: { type: 'string' } });
    required(values, 'dataset', 'dataset verify');
    progress({ type: 'start', workflow: 'verification', title: 'Verifying dataset', current: 'Reading manifest', progress: { done: 0, total: 7, label: 'integrity checks passed' } });
    const dataset = await loadDataset(values.dataset, { progress: ({ done, total, current }) => progress({ type: 'update', workflow: 'verification', current, progress: { done, total, label: 'integrity checks passed' } }) });
    progress({ type: 'complete', workflow: 'verification', title: 'Dataset verified', summary: [`${dataset.questions.length} question${dataset.questions.length === 1 ? '' : 's'}, ${dataset.evidence.length} evidence record${dataset.evidence.length === 1 ? '' : 's'}`] });
    output({ datasetId: dataset.datasetId, evidenceRecords: dataset.evidence.length, questions: dataset.questions.length, valid: true }, globals.json, `Dataset is valid\n  Questions: ${dataset.questions.length}\n  Evidence records: ${dataset.evidence.length}`);
    return;
  }
  if (group === 'operation' && command === 'status') {
    const values = options(commandArgs, { 'work-dir': { type: 'string' }, 'operation-id': { type: 'string' } });
    required(values, 'work-dir', 'operation status');
    const journalPath = path.resolve(values['work-dir'], 'operations.sqlite');
    progress({ type: 'start', workflow: 'status', title: 'Reading operation status', current: 'Opening operation journal', progress: { done: 0, total: 1, label: 'journals read' } });
    try { await access(journalPath); }
    catch { throw new Error(`Operation journal not found: ${journalPath}`); }
    const journal = await OperationJournal.open(journalPath, { readOnly: true });
    try {
      const operations = (values['operation-id'] ? [journal.getOperation(values['operation-id'])].filter(Boolean) : journal.listOperations()).map((operation) => {
        const jobs = journal.listJobs(operation.operationId);
        const lastActivityAt = Math.max(operation.updatedAt, ...jobs.map((job) => job.updatedAt));
        const counts = journal.jobCounts(operation.operationId);
        const expiredLeases = jobs.filter((job) => job.status === 'running' && job.leaseExpiresAt <= Date.now()).length;
        const health = operation.status === 'running' && counts.running > 0 && expiredLeases === counts.running ? 'stalled' : operation.status;
        return { ...operation, jobs: counts, lastActivityAt, health };
      });
      if (values['operation-id'] && !operations.length) throw new Error(`Operation not found: ${values['operation-id']}`);
      progress({ type: 'complete', workflow: 'status', title: 'Operation status ready', summary: [`${operations.length} operation${operations.length === 1 ? '' : 's'} found`] });
      output({ journalPath, operations }, globals.json, formatOperationStatus(operations));
      return;
    } finally { journal.close(); }
  }
  if (group === 'eval' && command === 'report') {
    const values = options(commandArgs, { run: { type: 'string' }, dataset: { type: 'string' }, output: { type: 'string', short: 'o' }, title: stringOption('Skill evaluation') });
    required(values, 'run', 'eval report'); required(values, 'dataset', 'eval report');
    progress({ type: 'start', workflow: 'report', title: 'Generating report', current: 'Reading evaluation artifacts', progress: { done: 0, total: 1, label: 'reports generated' } });
    const reportPath = await generateEvaluationReport({ runPath: values.run, datasetPath: values.dataset, outputPath: values.output, title: values.title });
    progress({ type: 'complete', workflow: 'report', title: 'Report generated', summary: [displayPath(reportPath)] });
    output({ reportPath, status: 'created' }, globals.json, `Output: ${displayPath(reportPath)}`);
    return;
  }
  if (group === 'eval' && command === 'baseline') {
    const values = options(commandArgs, { dataset: { type: 'string' }, 'output-dir': stringOption('baselines'), 'work-dir': stringOption('.work/baseline'), model: { type: 'string' }, 'judge-model': { type: 'string' }, 'reasoning-effort': { type: 'string' }, trials: stringOption('3'), timeout: stringOption('600'), 'timeout-retries': stringOption('1'), concurrency: stringOption('10'), resume: { type: 'boolean' }, fresh: { type: 'boolean', default: false } });
    required(values, 'dataset', 'eval baseline');
    const baselinePath = await evaluateBaseline({ datasetPath: values.dataset, outputRoot: values['output-dir'], workRoot: values['work-dir'], options: { model: values.model, judgeModel: values['judge-model'], reasoningEffort: values['reasoning-effort'], trialsPerQuestion: positiveInteger(values.trials, '--trials'), timeoutSeconds: positiveNumber(values.timeout, '--timeout'), timeoutRetries: nonNegativeInteger(values['timeout-retries'], '--timeout-retries'), concurrency: positiveInteger(values.concurrency, '--concurrency'), resume: resolveResume(values) }, progress });
    output({ baselinePath, status: 'completed' }, globals.json, `Output: ${displayPath(baselinePath)}`);
    return;
  }
  if (group === 'eval' && command === 'run') {
    const values = options(commandArgs, { dataset: { type: 'string' }, skill: { type: 'string' }, 'baseline-dir': stringOption('baselines'), 'output-dir': stringOption('runs'), 'work-dir': stringOption('.work/eval'), model: { type: 'string' }, 'judge-model': { type: 'string' }, 'reasoning-effort': { type: 'string' }, 'skill-invocation': stringOption('auto'), trials: stringOption('3'), timeout: stringOption('600'), 'timeout-retries': stringOption('1'), concurrency: stringOption('10'), resume: { type: 'boolean' }, fresh: { type: 'boolean', default: false } });
    required(values, 'dataset', 'eval run'); required(values, 'skill', 'eval run');
    const runPath = await evaluateDataset({ datasetPath: values.dataset, skillPath: values.skill, baselineRoot: values['baseline-dir'], outputRoot: values['output-dir'], workRoot: values['work-dir'], options: { model: values.model, judgeModel: values['judge-model'], reasoningEffort: values['reasoning-effort'], skillInvocation: choice(values['skill-invocation'], '--skill-invocation', ['auto', 'explicit']), trialsPerQuestion: positiveInteger(values.trials, '--trials'), timeoutSeconds: positiveNumber(values.timeout, '--timeout'), timeoutRetries: nonNegativeInteger(values['timeout-retries'], '--timeout-retries'), concurrency: positiveInteger(values.concurrency, '--concurrency'), resume: resolveResume(values) }, progress });
    output({ runPath, status: 'completed' }, globals.json, `Output: ${displayPath(runPath)}`);
    return;
  }
  throw new UsageError(`Unknown command: ${[group, command].filter(Boolean).join(' ') || '(none)'}. Valid commands: dataset build, dataset recalibrate, dataset verify, eval baseline, eval run, eval report, operation status.`);
}

class UsageError extends Error { constructor(message) { super(message); this.exitCode = 2; } }

function extractGlobals(argv) {
  const args = [];
  let json = false; let quiet = false; let agent = false; let progressMode; let progressInterval = 30;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') json = true;
    else if (arg === '--quiet') quiet = true;
    else if (arg === '--agent') agent = true;
    else if (arg === '--progress' || arg === '--progress-interval') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new UsageError(`Option ${arg} requires a value.`);
      index += 1;
      if (arg === '--progress') progressMode = value;
      else progressInterval = positiveNumber(value, '--progress-interval');
    }
    else if (arg.startsWith('--progress=')) progressMode = arg.slice('--progress='.length);
    else if (arg.startsWith('--progress-interval=')) progressInterval = positiveNumber(arg.slice('--progress-interval='.length), '--progress-interval');
    else args.push(arg);
  }
  if (!['auto', 'human', 'agent', 'json', 'quiet'].includes(progressMode ?? 'auto')) throw new UsageError(`Invalid --progress value ${JSON.stringify(progressMode)}. Valid values: auto, human, agent, json, quiet.`);
  if (quiet && progressMode && progressMode !== 'quiet') throw new UsageError('--quiet conflicts with a non-quiet --progress mode.');
  if (agent && progressMode && progressMode !== 'agent') throw new UsageError('--agent conflicts with a non-agent --progress mode.');
  return { args, json, progressMode: quiet ? 'quiet' : agent ? 'agent' : progressMode ?? 'auto', progressInterval };
}

function options(args, commandOptions) {
  try { return parseArgs({ args, options: { ...commonOptions, ...commandOptions }, strict: true, allowPositionals: false }).values; }
  catch (error) { throw new UsageError(`${error.message}. Run 'skillfid --help' for valid options.`); }
}

function stringOption(defaultValue) { return { type: 'string', default: defaultValue }; }
function required(values, name, command) { if (!values[name]) throw new UsageError(`Missing required option --${name} for '${command}'.`); }
function positiveInteger(value, name) { const number = Number(value); if (!Number.isInteger(number) || number < 1) throw new UsageError(`Invalid ${name} value ${JSON.stringify(value)}. Expected a positive integer.`); return number; }
function nonNegativeInteger(value, name) { const number = Number(value); if (!Number.isInteger(number) || number < 0) throw new UsageError(`Invalid ${name} value ${JSON.stringify(value)}. Expected a non-negative integer.`); return number; }
function positiveNumber(value, name) { const number = Number(value); if (!Number.isFinite(number) || number <= 0) throw new UsageError(`Invalid ${name} value ${JSON.stringify(value)}. Expected a positive number.`); return number; }
function choice(value, name, validValues) { if (!validValues.includes(value)) throw new UsageError(`Invalid ${name} value ${JSON.stringify(value)}. Valid values: ${validValues.join(', ')}.`); return value; }
function resolveResume(values) { if (values.resume && values.fresh) throw new UsageError('Options --resume and --fresh cannot be used together.'); return !values.fresh; }

function output(value, json, plain = undefined) {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${plain ?? JSON.stringify(value, null, 2)}\n`);
}

function displayPath(value) {
  const relative = path.relative(process.cwd(), value);
  return relative && !relative.startsWith('..') ? relative : value;
}

function formatOperationStatus(operations) {
  if (!operations.length) return 'No operations found.';
  return ['Operations', ...operations.map((operation) => {
    const jobs = operation.jobs;
    const total = jobs.pending + jobs.running + jobs.completed + jobs.failed;
    const activity = operation.health === 'completed' ? `finished ${formatAge(operation.updatedAt)}` : `last activity ${formatAge(operation.lastActivityAt)}`;
    return `  ${operation.kind}  ${operation.health}  ${jobs.completed}/${total} jobs complete${jobs.failed ? `, ${jobs.failed} failed` : ''} · ${activity}`;
  })].join('\n');
}

function formatAge(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

export function resumeCommand(argv) {
  if (!isResumableCommand(argv)) return undefined;
  const args = argv.filter((arg) => arg !== '--fresh' && !arg.startsWith('--fresh='));
  if (!args.includes('--resume')) args.push('--resume');
  return `npm start -- ${args.map(shellArgument).join(' ')}`;
}

export function interruptionMessage(argv) {
  const command = resumeCommand(argv);
  if (!command) return 'Interrupted.\n';
  const title = argv.some((arg, index) => arg === 'dataset' && argv[index + 1] === 'recalibrate') ? 'Recalibration interrupted' : argv.some((arg, index) => arg === 'eval' && argv[index + 1] === 'baseline') ? 'Baseline interrupted' : argv.includes('dataset') ? 'Extraction interrupted' : 'Evaluation interrupted';
  return `${title}\nAny completed work was saved.\n\nRun this command to continue:\n${command}\n`;
}

function isResumableCommand(argv) {
  return argv.some((arg, index) => (arg === 'dataset' && ['build', 'recalibrate'].includes(argv[index + 1])) || (arg === 'eval' && ['baseline', 'run'].includes(argv[index + 1])));
}

function shellArgument(value) {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    // Resolve symlinks so the check works when invoked via npm link or a global install.
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  let interrupted = false;
  process.once('SIGINT', () => { interrupted = true; activeProgressReporter?.close(); process.stderr.write(interruptionMessage(process.argv.slice(2))); process.exitCode = 130; });
  main().catch((error) => {
    if (interrupted) return;
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  });
}