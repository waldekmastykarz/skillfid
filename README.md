# skillfid

`skillfid` is a CLI for developers who build agent skills from documentation. It tests whether a skill helps an agent answer questions grounded in that source, revealing missing or imprecise guidance that reviewing the skill alone can miss. Use it to compare skill revisions against a reusable closed-book baseline and identify source-backed improvements.

![Canopy skill evaluation report showing an 83.91% skill-assisted score and actionable diagnoses](examples/canopy/assets/evaluation-report.png)

## Requirements

- Node.js 24 or later
- GitHub Copilot CLI, authenticated for Copilot access

Check them with `node --version` and `copilot --version`. The default model for both
subject and judge is `gpt-5.6-sol`; override either per command.

## Installation

```sh
npm install --global skillfid
```

Using a coding agent? Install the bundled skill with the open
[`skills` CLI](https://github.com/vercel-labs/skills), which supports Copilot,
Claude Code, Codex, Cursor and many other agents:

```sh
npx skills add waldekmastykarz/skillfid --skill skillfid
```

It teaches the agent this workflow, how to monitor long runs, and how to recover
from failures. Add `-g` to install it for all projects.

## Workflow

Run these steps in order. Steps 1-4 prepare reusable inputs; steps 5-6 repeat for
every revision of your skill.

| Step | Command | Run it | Produces |
| --- | --- | --- | --- |
| 1 | `dataset plan` | Optional, before step 2 | Estimated sections, Copilot calls, and minutes, without spending any |
| 2 | `dataset build` | Once per corpus | Immutable dataset of questions, evidence, and verified answers |
| 3 | `dataset verify` | Optional, after step 2 | Local integrity check of the dataset |
| 4 | `eval baseline` | Once per dataset and model configuration | Closed-book answers and judgments, without the skill |
| 5 | `eval run` | Every skill revision | Skill-assisted answers, scores, and diagnoses |
| 6 | `eval report` | After each run | Self-contained HTML report |

After step 6, read the diagnoses, improve the skill, and repeat steps 5 and 6.
Steps 1-4 stay unchanged, so every revision is compared against the same dataset and
baseline.

## Quick start

Commands below use the default output folders (`./datasets`, `./baselines`,
`./runs`). Each model-backed command prints the path it created; use it in the
next step.

### 1–2. Plan and build a dataset

Point `skillfid` at a folder of Markdown files (or a single `.md` file), the ground
truth for your skill. Preview the cost first:

```sh
skillfid dataset plan --corpus ./corpus
skillfid dataset build --corpus ./corpus
```

Every generated question must have an oracle answer that is judged perfect and
stable before the dataset is published. The result is `./datasets/<dataset-id>`.
Builds take tens of minutes for a book-sized corpus; see
[Long runs](#long-runs-and-coding-agents) to run them in the background.

```sh
DATASET=./datasets/<dataset-id>
```

Useful build options: `--include`/`--exclude` globs to choose corpus files,
`--profile quick|standard` (or `--importance high,medium`) to cover only the most
important knowledge while iterating, and `--min-section-chars`/`--max-section-chars`
to control how headings are grouped into inventory units.

### 3. Verify the dataset (optional)

```sh
skillfid dataset verify --dataset "$DATASET"
```

### 4. Measure the closed-book baseline

```sh
skillfid eval baseline --dataset "$DATASET"
```

This measures how well the agent answers without your skill. It is reused by every
later run. One closed-book trial per question is the default because the baseline is
near-deterministic; use `--trials` for more.

### 5. Evaluate your skill

```sh
skillfid eval run --dataset "$DATASET" --skill ./path/to/skill
```

The run uses the latest baseline that exactly matches the dataset, models, reasoning
effort, evaluator version, and Copilot CLI version (any number of skill trials can use
a baseline with at least one trial per question); otherwise it fails
with an actionable message. Set the output folder as `RUN`:

```sh
RUN=./runs/<run-id>
```

To invoke the skill as `/skill-name` in every skill prompt instead of relying on
automatic activation, add `--skill-invocation explicit`. This affects only the
skill condition.

### 6. Generate the report

```sh
skillfid eval report --run "$RUN" --dataset "$DATASET" --title "My skill"
```

The report is written to `$RUN/report.html`. Use `--output <file>` to change that.
This step is local and makes no Copilot calls.

### 7. Improve and repeat

Open the report, apply the recommended changes to your skill, then rerun steps 5
and 6. Compare scores across runs.

## Try it with Canopy

Canopy is a synthetic distributed build cache that demonstrates the complete
workflow. Inspect the included evaluation and trace its findings to the recorded
data without making a model call:

- [Open the self-contained HTML report](examples/canopy/runs/run_1689576d3f9343ce/report.html)
- Inspect the run's [summary](examples/canopy/runs/run_1689576d3f9343ce/summary.json), [diagnoses](examples/canopy/runs/run_1689576d3f9343ce/diagnoses.jsonl), and [recorded answers](examples/canopy/runs/run_1689576d3f9343ce/answers.jsonl)
- Trace findings through the [generated questions](examples/canopy/dataset/ds_7f1bc4dc92fc4b51/questions.jsonl), [evidence](examples/canopy/dataset/ds_7f1bc4dc92fc4b51/evidence.jsonl), and [source corpus](examples/canopy/corpus/cache-operations.md)
- Compare the intentionally compressed [original skill](examples/canopy/skill/SKILL.md) with the source-faithful [v2 skill](examples/canopy/skill-v2/SKILL.md)

The original skill scored **83.91%**, compared with **0%** closed book. After
source-backed improvements, v2 scored **100%** against the same dataset and
baseline. Both results used `gpt-5.6-sol` as subject and judge with three trials per
question. Scores are specific to the dataset and evaluation configuration.

To run the same workflow yourself, set `DATASET` and `RUN` to the paths printed by
the commands:

```sh
skillfid --progress human dataset build \
	--corpus ./examples/canopy/corpus \
	--output-dir ./.work/canopy/datasets \
	--work-dir ./.work/canopy/dataset-work

DATASET=./.work/canopy/datasets/<dataset-id>

skillfid --progress human eval baseline \
	--dataset "$DATASET" \
	--output-dir ./.work/canopy/baselines \
	--work-dir ./.work/canopy/baseline-work

skillfid --progress human eval run \
	--dataset "$DATASET" \
	--skill ./examples/canopy/skill \
	--baseline-dir ./.work/canopy/baselines \
	--skill-invocation explicit \
	--output-dir ./.work/canopy/runs \
	--work-dir ./.work/canopy/eval-work

RUN=./.work/canopy/runs/<run-id>

skillfid eval report \
	--run "$RUN" \
	--dataset "$DATASET" \
	--title "Canopy cache operations"
```

To evaluate the improved skill, rerun `eval run` with
`--skill ./examples/canopy/skill-v2`. See the
[Canopy walkthrough](examples/canopy/README.md) for the checked-in artifacts. For a
minimal model-backed smoke test, use the one-fact
[Arbor example](examples/arbor/README.md).

## Reference

Run `skillfid --help` for the complete command reference, including JSON schemas,
prerequisites, and exit codes. Add `--json` to any command for machine-readable
output. Primary output goes to stdout, while progress and errors go to stderr.

### Dataset calibration

Every generated question must produce an oracle answer that receives a stable,
perfect criterion-level judgment before publication. The same answer is judged
independently three times. Unanimous results are accepted; disagreement triggers
two more judgments, and only a 4/5 result is accepted. A 3/2 split is unstable and
blocks publication.

The dataset stores every judgment and its consensus in `calibrations.jsonl`; the
corpus remains the sole ground truth. Datasets older than schema v6 lack the combined
structural and integrity proof and must be rebuilt.

### Recalibrate a dataset

After changing the Copilot runtime, model, judge, or harness, recalibrate without
repeating corpus inventory or question extraction:

```sh
skillfid dataset recalibrate \
	--dataset ./datasets/<dataset-id> \
	--output-dir ./datasets
```

Recalibration copies documents, knowledge, evidence, questions, verification,
coverage, and audit records unchanged. It reruns only the oracle answer and
independent consensus judgments for each question. The oracle answer is generated
once and held fixed across all judge repeats. Every question must still receive a
stable, perfect calibration before publication.

The result is a new immutable dataset whose manifest records `sourceDatasetId`.
Continue interrupted recalibration with the same command and `--resume`. Rerun
steps 4-6 against the new dataset.

### Evaluation settings

- Oracle calibration is a dataset publication gate, not an evaluation condition or
  model-specific ceiling.
- Baseline and skill runs inherit model settings from the dataset by default;
  both commands may select another model configuration.
- `eval baseline` defaults to one trial per question and `eval run` to three.
  Uplift compares each question's skill mean with its baseline mean.
- When storing baselines outside `./baselines`, use matching `--output-dir` on
  `eval baseline` and `--baseline-dir` on `eval run`.
- `--skill-invocation auto|explicit` changes only the skill condition. The resolved
  mode is recorded in the run manifest; the baseline does not change.

### Iterating on a skill quickly and cheaply

A full run answers every question three times. While improving a skill, spend less:

- `--sample 30 --seed 1` evaluates a deterministic sample stratified by question
  type; `--filter type=procedure,importance=high` evaluates matching questions only
  (keys: `type`, `difficulty`, `importance`, `document`, `section`). Partial runs are
  marked as such in the manifest, summary and report.
- `--adaptive` runs one trial per question first and gives only questions that score
  below 100% the remaining trials.
- `--since ./runs/<previous>` re-runs only questions that previously failed, did not
  load the skill, or read a skill file that changed, and carries the rest forward
  (marked `carriedFrom`). Editing `SKILL.md` itself re-runs everything because every
  trial reads it.
- `skillfid eval compare --base <old run> --head <new run> --dataset "$DATASET"`
  pairs the runs per question and lists improved and regressed questions with a mean
  delta, its 95% confidence interval and a verdict (`improved`, `regressed`, or no
  significant change). `--fail-on-regression` exits with code 5 on a significant
  regression; `eval run --fail-under 0.9` exits with code 5 below a score floor. In
  both cases results are written first.

### Behavior probes

The dataset only contains answerable questions. To check what a skill does when it
should not answer, or whether it follows house rules, pass `--probes probes.jsonl`,
one JSON object per line:

```json
{"id": "p1", "question": "Does the playbook cover pricing?", "expect": "refuse", "behaviors": ["Says the playbook does not cover it", "Labels any general knowledge as not from the playbook"]}
```

Probes run through the same skill condition and trial count and are judged for
refusal, hallucination and each behavior. Results go to `probes.jsonl` and the
`probes` section of `summary.json` and the report (correct-refusal rate,
hallucination rate, behavior pass rate); they never change the accuracy or uplift
numbers.

### Execution and recovery

Copilot calls have a 600-second timeout and one fresh-session retry by default.
Configure them with `--timeout <seconds>` and `--timeout-retries <count>`.

Dataset builds and evaluations run independent work concurrently. The default
is 10; set `--concurrency <count>` to any positive integer. Answers and judgments
are separate recovery checkpoints, so interruption after answering does not
require generating that answer again.

**Resume.** Matching operations reuse completed work by default (`--resume`).
Validated jobs are stored in `<work-dir>/operations.sqlite` using SQLite WAL and
retained after completion. Only settings that change results identify a build:
the corpus, models, reasoning effort, importance tiers, and clean-pass count.
Budgets and runtime knobs (`--max-residual-passes`, `--max-audit-passes`,
`--max-generation-attempts`, timeouts, `--concurrency`) never restart a build, so
raising a budget after a failure repeats only the failed sections. Finished
sections are also reused by a different build with the same settings, for example
over a corpus where only some documents changed. Use `--fresh` to start from
scratch without deleting earlier state.

**One section failing never discards the rest.** A section whose inventory keeps
finding new facts first gets twice the pass budget, then is split in half and each
half is inventoried on its own. If a section still fails, the build keeps going,
reports each failure immediately by file, heading path and line range, and ends with
one summary (exit code 3) and `<work-dir>/failures/<operation>.json` with the
per-pass history. Every failed section also gets
`<work-dir>/failures/<operation>/<section>.jsonl`: a header line plus every prompt
and answer Copilot exchanged for it, so you can see why it never settled.
Nothing partial is ever published, because the 100% coverage gate
is what makes dataset scores meaningful. Re-run the same command to retry only the
failed sections. Pass `--no-escalate` to fail instead of extending and splitting.

**Stopped runs leave nothing locked.** `SIGINT` and `SIGTERM` hand claimed jobs
back before exiting. If a process is killed outright, its jobs are taken over by the
next run immediately (same machine) or when their 90-second heartbeat lease lapses
(another machine); a run that finds a live owner waits for it with a visible
message. Two processes cannot run the same operation: the second fails with exit
code 4 naming the owner. `skillfid operation recover` frees abandoned jobs
explicitly.

When an interactive operation is interrupted, the CLI prints the exact resume
command, so you do not need to reconstruct it.

### Monitoring

```sh
skillfid operation status --work-dir .work/dataset            # stage counts, failures, throughput, next step
skillfid operation status --work-dir .work/dataset --jobs     # also list running jobs by name
skillfid operation status --work-dir .work/dataset --watch    # refresh until the run finishes
skillfid operation wait   --work-dir .work/dataset --json     # block until the next event
skillfid operation recover --work-dir .work/dataset           # free jobs held by stopped processes
```

`operation status --json` returns, per operation, `health` (`running`,
`interrupted`, `failed`, `completed`), job counts overall and per stage, failed and
running jobs by human-readable name, stale lease counts, throughput, an ETA, and
`remedies`. `operation wait` returns when the operation completes, the first job
fails, the run stops, or after `--timeout` seconds (default 120) with
`event: "timeout"`, so a caller polls once per event instead of sleeping blindly.

All commands support `--progress auto|human|agent|json|quiet`. Auto selects an
in-place display on a TTY and bounded agent snapshots otherwise. Human mode shows
current work, a status line (running, failed, stage mix), elapsed time, an estimate
and a compact result. Agent mode prints one line per change with the stage mix,
counts, failures and ETA, for example:

```text
[progress] elapsed=312s workflow=dataset progress="520/812 knowledge items covered" eta=14m05s sections=71/107 running=10 failed=1 stages=inventory:2,calibration:8 items=812 generated=203 calibrated=188 calls=1840 message="Calibrating questions · guide.md › Setup (lines 40–96)"
```

JSON progress is emitted as JSON Lines on stderr without changing final stdout.
Long-running commands also keep `<work-dir>/progress.json` (the latest snapshot) and
`<work-dir>/events.jsonl` (notable events) current, so scripts and agents never need
to open the SQLite journal.

### Long runs and coding agents

```sh
skillfid dataset build --corpus ./corpus --detach --json
# {"status":"started","pid":4242,"operationId":"dataset_…","workDir":".work/dataset",
#  "logPath":".work/dataset/run.log","statusCommand":"…","waitCommand":"…"}
```

`--detach` (build, recalibrate, baseline, run) starts the same command as an
independent process, returns as soon as it has registered its operation, and writes
its log and final JSON result next to the work directory. Poll with
`operation wait`. With `--json`, a failure prints one line
`{"error":{"code","message","remedy","command","details"}}` to stderr and nothing to
stdout. Exit codes: `0` success, `1` failure, `2` usage, `3` incomplete (re-run to
continue), `4` operation already running, `5` quality gate not met, `130`
interrupted.

### Artifacts and scoring

Each baseline stores its closed-book answers and judgments with an exact
compatibility manifest. Each skill run embeds those baseline records alongside
fresh skill answers. You will find the answers in `answers.jsonl`, criterion-level
judgments in `judgments.jsonl`, failure analysis in `diagnoses.jsonl`, and aggregate
scores in `summary.json`.

Embedding baseline records keeps reports self-contained without repeating closed-book
inference. The summary retains build-time calibration metadata for compatibility;
calibration is not an evaluation condition or model call.

HTML reports preserve that separation. Scores come from all recorded trials, and
uplift is shown in percentage points with 95% confidence intervals. Only diagnoses
with concrete file targets appear as recommended work, ranked by how many questions
they affect and the points they could recover; the evidence view retains every trial
answer and its failed-criterion rationale. The report also breaks results down by
question type, difficulty, importance, document and section, draws a corpus heat map
of the weakest sections, and shows failure stages, progressive-disclosure metrics,
latency and token usage.

Every skill answer records a trace of what the agent actually did: whether the skill
was loaded, which files it read (with sizes), its tool calls, turns and tokens.
Failing trials are staged from that trace: `not_discovered` (the skill was never
loaded), `false_refusal` (it refused although the evidence is in the skill),
`retrieval_miss` (it never read a file containing the evidence), `hallucination`
(unsupported claims), `application_error` (the evidence was read but the answer was
wrong). `summary.json` aggregates the stages, progressive-disclosure metrics (files
and bytes read, fraction of the skill loaded, trials that loaded everything),
usage, and `statistics` (confidence intervals, paired uplift, and between-trial
noise). Fix the earliest stage first.

### Isolation and safety

Evaluation runs use an isolated repository-local profile and do not expose
authentication tokens to agent tools. Every question, trial, and condition runs in a fresh non-resumed Copilot SDK session
with its own filesystem workspace. Subject sessions share one client, and judge
sessions share another. Conversation and workspace state are not reused.

Evaluation calls deny shell execution, file writes, and URL access. This stops the
closed-book baseline from searching external sources while preserving local read
access for skill files. Service, authentication, and validation failures surface
immediately while completed journal checkpoints remain resumable.

See [DESIGN.md](DESIGN.md) for the architecture, scheduler behavior, and scoring
model.

## Development

Run the tests:

```sh
npm test
```

Ferryline is the synthetic distributed build-cache scenario from GitHub Next's
Knowledge Compressor article. Reproduce its calibration from a repository checkout;
the extraction script requires internet access to fetch the article:

```sh
npm run calibration:extract
npm start -- dataset build \
	--corpus .work/js-calibration/article/corpus \
	--output-dir .work/js-calibration/datasets \
	--json
npm run calibration:compare -- \
	.work/js-calibration/datasets/<dataset-id> \
	.work/js-calibration/article/reference-questions.json
```

## Support and contributing

Report defects and request features in
[GitHub Issues](https://github.com/waldekmastykarz/knowledge-eval/issues). Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

Licensed under the [MIT License](LICENSE).