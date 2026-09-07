# skillfid

`skillfid` is a CLI for developers who build agent skills from documentation. It tests whether a skill helps an agent answer questions grounded in that source, revealing missing or imprecise guidance that reviewing the skill alone can miss. Use it to compare skill revisions against a reusable closed-book baseline and identify source-backed improvements.

![Canopy skill evaluation report showing an 83.91% skill-assisted score and actionable diagnoses](examples/canopy/assets/evaluation-report.png)

## Explore the Canopy result

> Canopy, is a synthetic distributed build cache used to demonstrate the complete workflow.

Inspect the included evaluation and trace its findings to the recorded data without
making a model call:

- [Open the self-contained HTML report](examples/canopy/runs/run_1689576d3f9343ce/report.html)
- Inspect the run's [summary](examples/canopy/runs/run_1689576d3f9343ce/summary.json), [diagnoses](examples/canopy/runs/run_1689576d3f9343ce/diagnoses.jsonl), and [recorded answers](examples/canopy/runs/run_1689576d3f9343ce/answers.jsonl)
- Trace findings through the [generated questions](examples/canopy/dataset/ds_7f1bc4dc92fc4b51/questions.jsonl), [evidence](examples/canopy/dataset/ds_7f1bc4dc92fc4b51/evidence.jsonl), and [source corpus](examples/canopy/corpus/cache-operations.md)
- Compare the intentionally compressed [original skill](examples/canopy/skill/SKILL.md) with the source-faithful [v2 skill](examples/canopy/skill-v2/SKILL.md)

The original skill scored **83.91%**, compared with **0%** closed book. After
source-backed improvements, v2 scored **100%** against the same dataset and
baseline. Both results used `gpt-5.6-sol` as subject and judge with three trials per
question. Scores are specific to the dataset and evaluation configuration.

## Run the complete Canopy flow

Complete the [requirements](#requirements) and [installation](#installation) first.
Then build an immutable dataset from the Canopy corpus:

```sh
skillfid --progress human dataset build \
	--corpus ./examples/canopy/corpus \
	--output-dir ./.work/canopy/datasets \
	--work-dir ./.work/canopy/dataset-work
```

Set `DATASET` to the published path printed by the command, then verify it locally:

```sh
DATASET=./.work/canopy/datasets/<dataset-id>

skillfid dataset verify --dataset "$DATASET"
```

Create the reusable closed-book baseline:

```sh
skillfid --progress human eval baseline \
	--dataset "$DATASET" \
	--output-dir ./.work/canopy/baselines \
	--work-dir ./.work/canopy/baseline-work
```

Evaluate the original skill with explicit invocation. The run reuses the compatible
baseline automatically:

```sh
skillfid --progress human eval run \
	--dataset "$DATASET" \
	--skill ./examples/canopy/skill \
	--baseline-dir ./.work/canopy/baselines \
	--skill-invocation explicit \
	--output-dir ./.work/canopy/runs \
	--work-dir ./.work/canopy/eval-work
```

Set `RUN` to the output path, then generate the report locally:

```sh
RUN=./.work/canopy/runs/<run-id>

skillfid eval report \
	--run "$RUN" \
	--dataset "$DATASET" \
	--title "Canopy cache operations"
```

To evaluate the improved skill, rerun `eval run` with
`--skill ./examples/canopy/skill-v2`. See the
[Canopy walkthrough](examples/canopy/README.md) for the checked-in artifacts and
reproduction paths. If a model-backed command is interrupted, use the resume command
printed by the CLI.

## Requirements

Before running `skillfid`, make sure that you have:

- Node.js 24 or later
- GitHub Copilot CLI authenticated for Copilot access

Check them with `node --version` and `copilot --version`. The default model for both
subject and judge is `gpt-5.6-sol`; you can override either per command. Evaluation
runs use an isolated repository-local profile and do not expose authentication
tokens to agent tools.

## Installation

Install `skillfid` from npm:

```sh
npm install --global skillfid
```

For a minimal model-backed smoke test, use the one-fact
[Arbor example](examples/arbor/README.md).

## Command reference

Build an immutable, oracle-calibrated dataset from a Markdown corpus:

```sh
skillfid dataset build --corpus ./corpus --json
```

Every generated question must produce an oracle answer that receives a stable,
perfect criterion-level judgment before publication. The same answer is judged
independently three times. Unanimous results are accepted; disagreement triggers
two more judgments, and only a 4/5 result is accepted. A 3/2 split is unstable and
blocks publication.

The dataset stores every judgment and its consensus in `calibrations.jsonl`; the
corpus remains the sole ground truth. Datasets older than schema v6 lack the combined
structural and integrity proof and must be rebuilt.

After changing the Copilot runtime, model, judge, or harness, recalibrate without
repeating corpus inventory or question extraction:

```sh
skillfid dataset recalibrate \
	--dataset ./datasets/<dataset-id> \
	--output-dir ./datasets \
	--json
```

Recalibration copies documents, knowledge, evidence, questions, verification,
coverage, and audit records unchanged. It reruns only the oracle answer and
independent consensus judgments for each question. The oracle answer is generated
once and held fixed across all judge repeats. Every question must still receive a
stable, perfect calibration before publication.

The result is a new immutable dataset whose manifest records `sourceDatasetId`.
Continue interrupted recalibration with the same command and `--resume`.

Verify a dataset locally without rerunning extraction:

```sh
skillfid dataset verify --dataset ./datasets/<dataset-id> --json
```

Measure the reusable closed-book baseline:

```sh
skillfid eval baseline \
	--dataset ./datasets/<dataset-id> \
	--json
```

Evaluate a skill using the latest exactly compatible baseline:

```sh
skillfid eval run \
	--dataset ./datasets/<dataset-id> \
	--skill ./path/to/skill \
	--json
```

Skill activation is automatic by default. To invoke the discovered project skill as
`/skill-name` in every skill-condition prompt, use explicit invocation:

```sh
skillfid eval run \
	--dataset ./datasets/<dataset-id> \
	--skill ./path/to/skill \
	--skill-invocation explicit \
	--json
```

`--skill-invocation` accepts `auto` or `explicit`. It changes only the skill
condition. The resolved mode is recorded in the run manifest; the baseline does not
change.

Oracle calibration is a dataset publication gate, not an evaluation condition or
model-specific ceiling. Baseline and skill model settings inherit from the dataset
by default, but both commands may select another model configuration.

A compatible baseline must match the dataset ID, subject model, judge model,
reasoning effort, trial count, evaluator version, and Copilot CLI version exactly.
Evaluation fails with an actionable message when none exists.

Both commands default to three trials per question. Use `--trials <count>`
consistently to override that default. When storing baselines outside
`./baselines`, use matching `--output-dir` on `eval baseline` and `--baseline-dir`
on `eval run`.

Generate a self-contained HTML report:

```sh
skillfid eval report \
	--run ./runs/<run-id> \
	--dataset ./datasets/<dataset-id> \
	--title "My skill"
```

The report defaults to `<run>/report.html`. Use `--output <file>` to choose another
location. Report generation is local and makes no Copilot calls.

## Execution and recovery

Run `skillfid --help` for the complete command reference, including JSON
schemas, prerequisites, and exit codes. Primary output goes to stdout, while
progress and errors go to stderr.

Copilot calls have a 600-second timeout and one fresh-session retry by default.
Configure them with `--timeout <seconds>` and `--timeout-retries <count>`.

Dataset builds and evaluations run independent work concurrently. The default
is 10; set `--concurrency <count>` to any positive integer. Answers and judgments
are separate recovery checkpoints, so interruption after answering does not
require generating that answer again.

Matching operations reuse completed work by default. Resume selects the latest
matching incomplete operation, including one originally started with `--fresh`.
Validated jobs are stored in
`<work-dir>/operations.sqlite` using SQLite WAL and retained after completion.

Use `--fresh` to start from scratch without deleting earlier state. When an
interactive operation is interrupted, the CLI prints the exact resume command, so
you do not need to reconstruct it.

Inspect retained operations without modifying the journal:

```sh
skillfid operation status --work-dir .work/eval --json
skillfid operation status --work-dir .work/eval --operation-id <id> --json
```

All commands support `--progress auto|human|agent|json|quiet`. Auto selects an
in-place display on a TTY and bounded agent snapshots otherwise. Human mode shows
current work and elapsed time, followed by an estimate and a compact result. JSON
progress is emitted as JSON Lines on stderr without changing final stdout.

## Artifacts and scoring

Each baseline stores its closed-book answers and judgments with an exact
compatibility manifest. Each skill run embeds those baseline records alongside
fresh skill answers. You will find the answers in `answers.jsonl`, criterion-level
judgments in `judgments.jsonl`, failure analysis in `diagnoses.jsonl`, and aggregate
scores in `summary.json`.

Embedding baseline records keeps reports self-contained without repeating closed-book
inference. The summary retains build-time calibration metadata for compatibility;
calibration is not an evaluation condition or model call.

HTML reports preserve that separation. Scores come from all recorded trials, and
uplift is shown in percentage points. Only diagnoses with concrete file targets
appear as recommended work; the evidence view retains every trial answer and its
failed-criterion rationale.

## Isolation and safety

Every question, trial, and condition runs in a fresh non-resumed Copilot SDK session
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