#!/usr/bin/env node

import path from 'node:path';
import { spawn } from 'node:child_process';
import { closeSync, openSync, realpathSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { buildDataset, loadDataset, recalibrateDataset } from './dataset.js';
import { compareRuns, formatComparison } from './compare.js';
import { readJson } from './files.js';
import { IMPORTANCE_PROFILES } from './dataset-core.js';
import { EXIT_CODES, errorPayload, SkillfidError, UsageError } from './errors.js';
import { evaluateBaseline, evaluateDataset } from './evaluation.js';
import { releaseAllJournals } from './journal.js';
import { formatOperationStatus, readOperations, recoverOperations, waitForOperation } from './operations.js';
import { planDataset } from './plan.js';
import { createFileSink, createProgressHub, createProgressReporter } from './progress.js';
import { generateEvaluationReport } from './report.js';
import packageJson from '../package.json' with { type: 'json' };

const VERSION = packageJson.version;
let activeProgressReporter;
let jsonErrors = false;

const HELP = `skillfid: evaluate how faithfully agent skills apply their source documentation

Examples:
  skillfid dataset plan --corpus ./corpus
  skillfid dataset build --corpus ./corpus --json
  skillfid dataset build --corpus ./corpus --detach --json
  skillfid operation wait --work-dir .work/dataset --json
  skillfid dataset recalibrate --dataset ./datasets/ds_abc123 --json
  skillfid dataset verify --dataset ./datasets/ds_abc123 --json
  skillfid eval baseline --dataset ./datasets/ds_abc123 --json
  skillfid eval run --dataset ./datasets/ds_abc123 --skill ./skill --json
  skillfid eval run --dataset ./datasets/ds_abc123 --skill ./skill --sample 30 --adaptive --fail-under 0.9
  skillfid eval run --dataset ./datasets/ds_abc123 --skill ./skill --since ./runs/run_abc123 --probes probes.jsonl
  skillfid eval compare --base ./runs/run_abc123 --head ./runs/run_def456 --dataset ./datasets/ds_abc123 --fail-on-regression
  skillfid eval report --run ./runs/run_abc123 --dataset ./datasets/ds_abc123
  skillfid operation status --work-dir .work/eval --json

Usage:
  skillfid [--json] [--quiet] dataset build --corpus <dir> [options]
  skillfid [--json] [--quiet] dataset recalibrate --dataset <dir> [options]
  skillfid [--json] [--quiet] dataset verify --dataset <dir>
  skillfid [--json] [--quiet] dataset plan --corpus <dir> [options]
  skillfid [--json] [--quiet] eval baseline --dataset <dir> [options]
  skillfid [--json] [--quiet] eval run --dataset <dir> --skill <dir> [options]
  skillfid [--json] [--quiet] eval compare --base <dir> --head <dir> --dataset <dir> [--fail-on-regression]
  skillfid [--json] [--quiet] eval report --run <dir> --dataset <dir> [options]
  skillfid [global-options] operation status --work-dir <dir> [--operation-id <id>] [--jobs] [--watch]
  skillfid [global-options] operation wait --work-dir <dir> [--operation-id <id>] [--timeout <sec>]
  skillfid [global-options] operation recover --work-dir <dir> [--operation-id <id>]

Global options:
  --json                    Print a stable JSON object to stdout
  --quiet                   Suppress progress on stderr
  --agent                   Bounded agent progress (alias: --progress agent)
  --progress <mode>         auto, human, agent, json, or quiet (default: auto)
  --progress-interval <sec> Agent snapshot interval (default: 30)
  --detach                  Start build/recalibrate/baseline/run in the background and return immediately
  -h, --help                Show help; valid after any command
  --version                 Print the version

Build options:
  --corpus <dir|file>       Markdown corpus directory or a single .md file (required)
  --include <glob>          Only include matching corpus files (repeatable; relative paths)
  --exclude <glob>          Skip matching corpus files (repeatable)
  --output-dir <dir>        Dataset output directory (default: datasets)
  --work-dir <dir>          Isolated working directory (default: .work/dataset)
  --model <name>            Copilot model (default: gpt-5.6-sol)
  --judge-model <name>      Oracle calibration judge (default: --model)
  --reasoning-effort <name> Reasoning effort (default: medium)
  --profile <name>          Knowledge scope: full (default), standard (high+medium importance), quick (high only)
  --importance <tiers>      Comma-separated importance tiers to cover (overrides --profile)
  --timeout <seconds>       Per-Copilot-call timeout (default: 600)
  --timeout-retries <count> Retries after a session timeout (default: 1)
  --max-attempts <count>    Attempts to repair malformed JSON (default: 3)
  --clean-residual-passes <count> Consecutive clean inventory passes (default: 1)
  --max-residual-passes <count>   Inventory passes per section before it escalates (default: 3; a section that
                            does not settle gets twice this budget, then is split in half). A budget, not an
                            identity: changing it resumes the same build
  --max-audit-passes <count>      Completeness audit passes per section (default: 3)
  --max-generation-attempts <count> Question regeneration rounds per section (default: 8)
  --max-section-chars <count> Largest section sent to one inventory call (default: 12000)
  --min-section-chars <count> Merge adjacent small sections up to this size (default: 1500; 0 disables)
  --no-escalate             Fail a non-converging section instead of extending its budget and splitting it
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
  --trials <count>          Trials per question (default: 1; the closed-book baseline is near-deterministic,
                            and any skill run, with any --trials, can reuse a baseline with at least 1 trial)
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
  --sample <n>              Evaluate a deterministic sample of n questions, stratified by question type
                            (proportional, at least one per type when n allows). Marks the run partial.
  --seed <int>              Seed for --sample (default: 0)
  --filter <k=v[,k=v]>      Evaluate only matching questions. Keys: type, difficulty, importance (highest
                            importance of the mapped knowledge items), document, section (section id prefix or
                            heading text). Different keys combine with AND, repeated keys with OR. Marks the run partial.
  --adaptive                Run trial 1 for every question; only questions scoring below 100% get the remaining trials
  --since <run-dir>         Incremental: re-run only questions that scored below 100%, did not load the skill, or read a
                            skill file that changed since <run-dir>; carry the rest forward (marked carriedFrom).
                            The previous run must use the same dataset and model settings.
  --probes <file.jsonl>     Also run behavior probes, one JSON object per line:
                            {"id":"p1","question":"...","expect":"refuse"|"answer","behaviors":["Cites the playbook chapter"]}
                            Results go to probes.jsonl and summary.json "probes"; they never change the accuracy scores.
  --fail-under <0..1>       Exit with code 5 when the skill mean score is below this threshold (results are still written)

Compare options:
  --base <dir>              Run directory to compare from (required)
  --head <dir>              Run directory to compare to (required)
  --dataset <dir>           Dataset both runs used (required)
  --fail-on-regression      Exit with code 5 when the paired comparison shows a significant regression

Report options:
  --run <dir>               Completed evaluation run directory (required)
  --dataset <dir>           Dataset used by the evaluation run (required)
  -o, --output <file>       HTML output file (default: <run>/report.html)
  --title <text>            Report title (default: Skill evaluation)

Operation options:
  --work-dir <dir>          Work directory of the run (required)
  --operation-id <id>       Operation to inspect (default: the newest unfinished one)
  --jobs                    status: also list running jobs
  --watch                   status: refresh until the operation is no longer running
  --interval <seconds>      status --watch refresh interval (default: 5)
  --timeout <seconds>       wait: return after this long with event "timeout" (default: 120)

Prerequisites:
  Node.js 24+ and GitHub Copilot CLI authenticated for Copilot access.

Long runs (for agents and scripts):
  Start with --detach --json to get {operationId, pid, workDir, logPath, statusCommand, waitCommand} at once.
  Then call 'operation wait --work-dir <dir> --json' repeatedly: it returns on completion, the first failed job,
  an interrupted run, or after --timeout seconds with event "timeout". <work-dir>/progress.json always holds the
  latest snapshot (stage mix, counts, failures, ETA) and <work-dir>/events.jsonl the notable events. A failed or
  stopped run keeps everything it finished: re-run the same command (the default --resume) to continue.

JSON success schemas:
  dataset build:  {"datasetPath":string,"status":"created"}
  dataset plan:   {"documents":number,"sections":number,"estimate":{...},"warnings":[...]}
  dataset recalibrate: {"datasetPath":string,"sourceDatasetId":string,"status":"created"}
  dataset verify: {"datasetId":string,"evidenceRecords":number,"questions":number,"valid":true}
  eval baseline:  {"baselinePath":string,"status":"completed"}
  eval run:       {"runPath":string,"status":"completed","scores":{"closedBook":number,"skill":number,"uplift":number},"questions":number,"partial"?:true,"subset"?:{...},"failureStages":{...},"probes"?:{...},"gate"?:{"passed":boolean,"threshold":number,"score":number}}
  eval compare:   {"datasetId":string,"base":{...},"head":{...},"questions":{"compared":number,...},"counts":{"improved","regressed","unchanged"},"meanDelta":{"mean","low","high",...},"verdict":"improved|regressed|no significant change","improved":[...],"regressed":[...],"stageChanges":[...],"progressiveDisclosure":{...}}
  eval report:    {"reportPath":string,"status":"created"}
  operation status: {"journalPath":string,"operations":[{"operationId","kind","health","jobs","stages","failedJobs","remedies",...}]}
  operation wait: {"event":"completed|failed|interrupted|job_failed|timeout","operation":{...}}
  operation recover: {"journalPath":string,"recovered":number}
  --detach:       {"status":"started","pid":number,"operationId":string,"workDir":string,"logPath":string,...}

I/O contract:
  Primary output goes to stdout. Progress and errors go to stderr. With --json a failure prints one JSON line
  {"error":{"code","message","remedy","command","details"}} to stderr and nothing to stdout.

Exit codes:
  0  Success
  1  Runtime, validation, authentication, or Copilot failure
  2  Invalid command or option
  3  Incomplete: some work failed or was interrupted; re-run the same command to continue
  4  Another process is already running this operation
  5  Quality gate not met (results are still written)
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
  jsonErrors = globals.json;
  if (globals.detach) return detachCommand(argv, globals);
  const hub = createProgressHub(createProgressReporter({ mode: globals.progressMode, intervalSeconds: globals.progressInterval }));
  activeProgressReporter = hub;
  const progress = (message) => hub.report(message);
  const attachSink = (workDir) => hub.attach(createFileSink({ directory: path.resolve(workDir), command: resumeCommand(argv) }));
  try {
    const result = await runCommand({ ...globals, argv, attachSink }, progress);
    hub.finish('completed');
    return result;
  } catch (error) {
    hub.finish(error.exitCode === EXIT_CODES.locked ? 'locked' : 'failed', error.message);
    throw error;
  } finally {
    hub.close();
    if (activeProgressReporter === hub) activeProgressReporter = undefined;
  }
}

// Commands that run long enough to need a progress snapshot on disk, with their default work directories.
const LONG_RUNNING_COMMANDS = { 'dataset build': '.work/dataset', 'dataset recalibrate': '.work/recalibrate', 'eval baseline': '.work/baseline', 'eval run': '.work/eval' };

function workDirOption(args, fallback) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--work-dir' && args[index + 1]) return args[index + 1];
    if (args[index].startsWith('--work-dir=')) return args[index].slice('--work-dir='.length);
  }
  return fallback;
}

async function runCommand(globals, progress) {
  const [group, command, ...commandArgs] = globals.args;
  const workDirDefault = LONG_RUNNING_COMMANDS[`${group} ${command}`];
  if (workDirDefault) globals.attachSink(workDirOption(commandArgs, workDirDefault));
  if (group === 'dataset' && command === 'build') {
    const values = options(commandArgs, BUILD_OPTIONS);
    required(values, 'corpus', 'dataset build');
    const datasetPath = await buildDataset({ corpusPath: values.corpus, outputRoot: values['output-dir'], workRoot: values['work-dir'], options: buildSettings(values), progress });
    output({ datasetPath, status: 'created' }, globals.json, `Output: ${displayPath(datasetPath)}`);
    return;
  }
  if (group === 'dataset' && command === 'plan') {
    const values = options(commandArgs, BUILD_OPTIONS);
    required(values, 'corpus', 'dataset plan');
    const plan = await planDataset({ corpusPath: values.corpus, options: buildSettings(values) });
    output(plan, globals.json, formatPlan(plan));
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
    const values = options(commandArgs, { 'work-dir': { type: 'string' }, 'operation-id': { type: 'string' }, jobs: { type: 'boolean', default: false }, watch: { type: 'boolean', default: false }, interval: stringOption('5') });
    required(values, 'work-dir', 'operation status');
    progress({ type: 'start', workflow: 'status', title: 'Reading operation status', current: 'Opening operation journal', progress: { done: 0, total: 1, label: 'journals read' } });
    const read = () => readOperations({ workDir: values['work-dir'], operationId: values['operation-id'], jobs: values.jobs });
    let snapshot = await read();
    progress({ type: 'complete', workflow: 'status', title: 'Operation status ready', summary: [`${snapshot.operations.length} operation${snapshot.operations.length === 1 ? '' : 's'} found`] });
    const intervalMs = positiveNumber(values.interval, '--interval') * 1000;
    while (values.watch && snapshot.operations.some((operation) => operation.health === 'running')) {
      output(snapshot, globals.json, formatOperationStatus(snapshot.operations, { detail: values.jobs }));
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      snapshot = await read();
    }
    output(snapshot, globals.json, formatOperationStatus(snapshot.operations, { detail: values.jobs }));
    return;
  }
  if (group === 'operation' && command === 'wait') {
    const values = options(commandArgs, { 'work-dir': { type: 'string' }, 'operation-id': { type: 'string' }, timeout: stringOption('120'), poll: stringOption('2') });
    required(values, 'work-dir', 'operation wait');
    const result = await waitForOperation({ workDir: values['work-dir'], operationId: values['operation-id'], timeoutSeconds: positiveNumber(values.timeout, '--timeout'), pollSeconds: positiveNumber(values.poll, '--poll') });
    output({ journalPath: result.journalPath, event: result.event, operation: result.operation }, globals.json, `${result.event}\n${formatOperationStatus([result.operation], { detail: true })}`);
    process.exitCode = result.exitCode;
    return;
  }
  if (group === 'operation' && command === 'recover') {
    const values = options(commandArgs, { 'work-dir': { type: 'string' }, 'operation-id': { type: 'string' } });
    required(values, 'work-dir', 'operation recover');
    const result = await recoverOperations({ workDir: values['work-dir'], operationId: values['operation-id'] });
    output(result, globals.json, `Freed ${result.recovered} job${result.recovered === 1 ? '' : 's'} held by stopped processes.`);
    return;
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
    const values = options(commandArgs, { dataset: { type: 'string' }, 'output-dir': stringOption('baselines'), 'work-dir': stringOption('.work/baseline'), model: { type: 'string' }, 'judge-model': { type: 'string' }, 'reasoning-effort': { type: 'string' }, trials: stringOption('1'), timeout: stringOption('600'), 'timeout-retries': stringOption('1'), concurrency: stringOption('10'), resume: { type: 'boolean' }, fresh: { type: 'boolean', default: false } });
    required(values, 'dataset', 'eval baseline');
    const baselinePath = await evaluateBaseline({ datasetPath: values.dataset, outputRoot: values['output-dir'], workRoot: values['work-dir'], options: { model: values.model, judgeModel: values['judge-model'], reasoningEffort: values['reasoning-effort'], trialsPerQuestion: positiveInteger(values.trials, '--trials'), timeoutSeconds: positiveNumber(values.timeout, '--timeout'), timeoutRetries: nonNegativeInteger(values['timeout-retries'], '--timeout-retries'), concurrency: positiveInteger(values.concurrency, '--concurrency'), resume: resolveResume(values) }, progress });
    output({ baselinePath, status: 'completed' }, globals.json, `Output: ${displayPath(baselinePath)}`);
    return;
  }
  if (group === 'eval' && command === 'run') {
    const values = options(commandArgs, { dataset: { type: 'string' }, skill: { type: 'string' }, 'baseline-dir': stringOption('baselines'), 'output-dir': stringOption('runs'), 'work-dir': stringOption('.work/eval'), model: { type: 'string' }, 'judge-model': { type: 'string' }, 'reasoning-effort': { type: 'string' }, 'skill-invocation': stringOption('auto'), trials: stringOption('3'), timeout: stringOption('600'), 'timeout-retries': stringOption('1'), concurrency: stringOption('10'), resume: { type: 'boolean' }, fresh: { type: 'boolean', default: false }, sample: { type: 'string' }, seed: { type: 'string' }, filter: { type: 'string' }, adaptive: { type: 'boolean', default: false }, since: { type: 'string' }, probes: { type: 'string' }, 'fail-under': { type: 'string' } });
    required(values, 'dataset', 'eval run'); required(values, 'skill', 'eval run');
    const failUnder = values['fail-under'] === undefined ? undefined : unitInterval(values['fail-under'], '--fail-under');
    const runPath = await evaluateDataset({ datasetPath: values.dataset, skillPath: values.skill, baselineRoot: values['baseline-dir'], outputRoot: values['output-dir'], workRoot: values['work-dir'], options: { model: values.model, judgeModel: values['judge-model'], reasoningEffort: values['reasoning-effort'], skillInvocation: choice(values['skill-invocation'], '--skill-invocation', ['auto', 'explicit']), trialsPerQuestion: positiveInteger(values.trials, '--trials'), timeoutSeconds: positiveNumber(values.timeout, '--timeout'), timeoutRetries: nonNegativeInteger(values['timeout-retries'], '--timeout-retries'), concurrency: positiveInteger(values.concurrency, '--concurrency'), resume: resolveResume(values), sample: values.sample === undefined ? undefined : positiveInteger(values.sample, '--sample'), seed: values.seed === undefined ? undefined : integerOption(values.seed, '--seed'), filter: values.filter, adaptive: values.adaptive, since: values.since, probesPath: values.probes, failUnder }, progress });
    const summary = await readJson(path.join(runPath, 'summary.json'));
    const result = { runPath, status: 'completed', scores: { closedBook: summary.conditionScores.closedBook, skill: summary.conditionScores.skill, uplift: summary.skillUplift }, questions: summary.questions, ...(summary.partial ? { partial: true, subset: summary.subset } : {}), failureStages: summary.failureStages, ...(summary.probes ? { probes: summary.probes } : {}), ...(summary.gate ? { gate: summary.gate } : {}) };
    output(result, globals.json, formatRunResult(result, summary));
    if (summary.gate && !summary.gate.passed) process.exitCode = EXIT_CODES.gate;
    return;
  }
  if (group === 'eval' && command === 'compare') {
    const values = options(commandArgs, { base: { type: 'string' }, head: { type: 'string' }, dataset: { type: 'string' }, 'fail-on-regression': { type: 'boolean', default: false } });
    required(values, 'base', 'eval compare'); required(values, 'head', 'eval compare'); required(values, 'dataset', 'eval compare');
    const result = await compareRuns({ basePath: values.base, headPath: values.head, datasetPath: values.dataset });
    output(result, globals.json, formatComparison(result));
    if (values['fail-on-regression'] && result.verdict === 'regressed') process.exitCode = EXIT_CODES.gate;
    return;
  }
  throw new UsageError(`Unknown command: ${[group, command].filter(Boolean).join(' ') || '(none)'}. Valid commands: dataset build, dataset plan, dataset recalibrate, dataset verify, eval baseline, eval run, eval report, eval compare, operation status, operation wait, operation recover.`);
}

const BUILD_OPTIONS = {
  corpus: { type: 'string' }, include: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
  'output-dir': stringOption('datasets'), 'work-dir': stringOption('.work/dataset'), model: stringOption('gpt-5.6-sol'), 'judge-model': { type: 'string' },
  'reasoning-effort': stringOption('medium'), profile: { type: 'string' }, importance: { type: 'string' }, timeout: stringOption('600'), 'timeout-retries': stringOption('1'),
  'max-attempts': stringOption('3'), 'clean-residual-passes': stringOption('1'), 'max-residual-passes': stringOption('3'), 'max-audit-passes': stringOption('3'),
  'max-generation-attempts': stringOption('8'), 'max-section-chars': stringOption('12000'), 'min-section-chars': stringOption('1500'),
  'no-escalate': { type: 'boolean', default: false },
  concurrency: stringOption('10'), resume: { type: 'boolean' }, fresh: { type: 'boolean', default: false },
};

function buildSettings(values) {
  if (values.profile && values.importance) throw new UsageError('--profile and --importance cannot be used together.');
  const importance = values.importance
    ? values.importance.split(',').map((tier) => tier.trim()).filter(Boolean)
    : IMPORTANCE_PROFILES[choice(values.profile ?? 'full', '--profile', Object.keys(IMPORTANCE_PROFILES))];
  for (const tier of importance) choice(tier, '--importance', IMPORTANCE_PROFILES.full);
  const maxSectionChars = positiveInteger(values['max-section-chars'], '--max-section-chars');
  if (maxSectionChars < 500) throw new UsageError('Invalid --max-section-chars value. Expected at least 500.');
  return {
    model: values.model, judgeModel: values['judge-model'] ?? values.model, reasoningEffort: values['reasoning-effort'], importance,
    include: values.include ?? [], exclude: values.exclude ?? [],
    timeoutSeconds: positiveNumber(values.timeout, '--timeout'), timeoutRetries: nonNegativeInteger(values['timeout-retries'], '--timeout-retries'),
    maxAttempts: positiveInteger(values['max-attempts'], '--max-attempts'), cleanResidualPasses: positiveInteger(values['clean-residual-passes'], '--clean-residual-passes'),
    maxResidualPasses: positiveInteger(values['max-residual-passes'], '--max-residual-passes'), maxAuditPasses: positiveInteger(values['max-audit-passes'], '--max-audit-passes'),
    maxGenerationAttempts: positiveInteger(values['max-generation-attempts'], '--max-generation-attempts'),
    maxSectionChars, minSectionChars: nonNegativeInteger(values['min-section-chars'], '--min-section-chars'),
    escalate: !values['no-escalate'], concurrency: positiveInteger(values.concurrency, '--concurrency'), resume: resolveResume(values),
  };
}

function formatPlan(plan) {
  const { estimate } = plan;
  const lines = [
    `Corpus: ${plan.documents} document${plan.documents === 1 ? '' : 's'}, ${plan.sections} section${plan.sections === 1 ? '' : 's'}, ${plan.characters.toLocaleString('en-US')} characters (~${plan.estimatedTokens.toLocaleString('en-US')} tokens)`,
    `Section sizes: median ${plan.sectionChars.median}, largest ${plan.sectionChars.max} characters`,
    `Estimate: ~${estimate.knowledgeItems} knowledge items, ~${estimate.questions} questions, ~${estimate.copilotCalls.toLocaleString('en-US')} Copilot calls`,
    `Time at concurrency ${plan.concurrency}: roughly ${estimate.minutes.low}–${estimate.minutes.high} minutes`,
  ];
  for (const warning of plan.warnings) lines.push(`Warning: ${warning}`);
  lines.push('This is a heuristic from earlier builds; run `dataset build --detach` to start.');
  return lines.join('\n');
}

function extractGlobals(argv) {
  const args = [];
  let json = false; let quiet = false; let agent = false; let detach = false; let progressMode; let progressInterval = 30;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') json = true;
    else if (arg === '--quiet') quiet = true;
    else if (arg === '--agent') agent = true;
    else if (arg === '--detach') detach = true;
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
  return { args, json, detach, progressMode: quiet ? 'quiet' : agent ? 'agent' : progressMode ?? 'auto', progressInterval };
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
function integerOption(value, name) { const number = Number(value); if (value === '' || !Number.isInteger(number)) throw new UsageError(`Invalid ${name} value ${JSON.stringify(value)}. Expected an integer.`); return number; }
function unitInterval(value, name) { const number = Number(value); if (value === '' || !Number.isFinite(number) || number < 0 || number > 1) throw new UsageError(`Invalid ${name} value ${JSON.stringify(value)}. Expected a number from 0 to 1.`); return number; }

function formatRunResult(result, summary) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  const interval = summary.statistics?.skill;
  const lines = [
    `Output: ${displayPath(result.runPath)}`,
    `Skill ${percent(result.scores.skill)}${interval?.halfWidth === null || interval?.halfWidth === undefined ? '' : ` (95% CI ${percent(Math.max(0, interval.low))}–${percent(Math.min(1, interval.high))})`} · closed book ${percent(result.scores.closedBook)} · uplift ${result.scores.uplift >= 0 ? '+' : ''}${(result.scores.uplift * 100).toFixed(1)} pp`,
  ];
  if (summary.partial) lines.push(`Partial run: ${summary.subset.questions} of ${summary.subset.of} questions evaluated`);
  const stages = Object.entries(summary.failureStages ?? {}).filter(([, count]) => count).map(([stage, count]) => `${stage.replaceAll('_', ' ')} ${count}`);
  if (stages.length) lines.push(`Failure stages: ${stages.join(', ')}`);
  if (summary.gate) lines.push(`Gate: ${summary.gate.passed ? 'passed' : 'FAILED'} (skill ${percent(summary.gate.score)} vs threshold ${percent(summary.gate.threshold)})`);
  return lines.join('\n');
}

function output(value, json, plain = undefined) {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${plain ?? JSON.stringify(value, null, 2)}\n`);
}

function displayPath(value) {
  const relative = path.relative(process.cwd(), value);
  return relative && !relative.startsWith('..') ? relative : value;
}

export function resumeCommand(argv) {
  if (!isResumableCommand(argv)) return undefined;
  const args = argv.filter((arg) => !['--fresh', '--detach', '--json', '--agent'].includes(arg) && !arg.startsWith('--fresh='));
  if (!args.includes('--resume')) args.push('--resume');
  return `skillfid ${args.map(shellArgument).join(' ')}`;
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

// Starts the same command as an independent background process and returns as soon as it has registered its operation.
async function detachCommand(argv, globals) {
  const [group, command] = globals.args;
  const defaultWorkDir = LONG_RUNNING_COMMANDS[`${group} ${command}`];
  if (!defaultWorkDir) throw new UsageError('--detach is only valid for dataset build, dataset recalibrate, eval baseline, and eval run.');
  const workDir = path.resolve(workDirOption(globals.args.slice(2), defaultWorkDir));
  await mkdir(workDir, { recursive: true });
  const childArgs = argv.filter((arg) => arg !== '--detach');
  if (!childArgs.includes('--json')) childArgs.unshift('--json');
  if (!childArgs.some((arg) => arg === '--agent' || arg === '--quiet' || arg === '--progress' || arg.startsWith('--progress='))) childArgs.unshift('--agent');
  const logPath = path.join(workDir, 'run.log');
  const resultPath = path.join(workDir, 'result.json');
  const progressPath = path.join(workDir, 'progress.json');
  const logFd = openSync(logPath, 'a');
  const resultFd = openSync(resultPath, 'w');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...childArgs], { detached: true, stdio: ['ignore', resultFd, logFd], cwd: process.cwd(), env: process.env });
  closeSync(logFd); closeSync(resultFd);
  let exitCode;
  child.once('exit', (code) => { exitCode = code ?? 1; });
  child.unref();
  let operationId;
  for (let waited = 0; waited < 30_000 && exitCode === undefined && !operationId; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const snapshot = JSON.parse(await readFile(progressPath, 'utf8'));
      if (snapshot.pid === child.pid && snapshot.operationId) operationId = snapshot.operationId;
    } catch { /* the child has not written a snapshot yet */ }
  }
  if (exitCode !== undefined) {
    if (exitCode === 0) {
      // The run finished before it ever looked "in progress", for example a resume where everything was already done.
      const result = JSON.parse(await readFile(resultPath, 'utf8').catch(() => 'null'));
      const completed = { status: 'completed', pid: child.pid, workDir, logPath, resultPath, progressPath, result };
      output(completed, globals.json, `Completed in the background (pid ${child.pid}).\nResult: ${displayPath(resultPath)}`);
      return;
    }
    const log = await readFile(logPath, 'utf8').catch(() => '');
    const errorLine = log.split('\n').reverse().find((line) => line.startsWith('{"error"'));
    const payload = errorLine ? JSON.parse(errorLine).error : { code: 'DETACH_FAILED', message: `The background run exited immediately with code ${exitCode}. See ${logPath}.` };
    throw new SkillfidError(payload.message, { code: payload.code, exitCode: exitCode || 1, remedy: payload.remedy, command: payload.command, details: payload.details });
  }
  const dir = shellArgument(displayPath(workDir));
  const started = {
    status: 'started', pid: child.pid, operationId: operationId ?? null, workDir, logPath, resultPath, progressPath,
    statusCommand: `skillfid operation status --work-dir ${dir} --json`,
    waitCommand: `skillfid operation wait --work-dir ${dir} --json`,
  };
  output(started, globals.json, `Started in the background (pid ${child.pid}).\nProgress: ${displayPath(progressPath)}\nLog: ${displayPath(logPath)}\nCheck: ${started.statusCommand}\nWait:  ${started.waitCommand}`);
}

export function formatError(error, argv, json) {
  const payload = errorPayload(error);
  if (error?.exitCode === EXIT_CODES.incomplete && !payload.command) payload.command = resumeCommand(argv);
  if (json) return `${JSON.stringify({ error: payload })}\n`;
  const lines = [`Error: ${payload.message}`];
  if (payload.remedy) lines.push('', payload.remedy);
  if (payload.command) lines.push('', 'Continue with:', `  ${payload.command}`);
  return `${lines.join('\n')}\n`;
}

// Hands claimed jobs back on SIGINT/SIGTERM so the next run can take them immediately instead of waiting for leases to expire.
export function installShutdownHandlers({ stderr = process.stderr, argv = process.argv.slice(2) } = {}) {
  const state = { interrupted: false };
  const onSignal = (signal) => {
    if (state.interrupted) process.exit(EXIT_CODES.interrupted);
    state.interrupted = true;
    releaseAllJournals();
    activeProgressReporter?.finish('interrupted', `Interrupted by ${signal}`);
    activeProgressReporter?.close();
    stderr.write(interruptionMessage(argv));
    process.exitCode = EXIT_CODES.interrupted;
    setTimeout(() => process.exit(EXIT_CODES.interrupted), 200);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  return state;
}

if (isEntryPoint()) {
  const shutdown = installShutdownHandlers();
  main().catch((error) => {
    if (shutdown.interrupted) return;
    process.stderr.write(formatError(error, process.argv.slice(2), jsonErrors));
    process.exitCode = error.exitCode ?? 1;
  });
}