---
name: skillfid
description: Use when asked to measure, evaluate, benchmark or improve a knowledge-based agent skill (a skill built from documentation), to build a question dataset from a Markdown corpus, to run closed-book baselines and skill evaluations, or to monitor, resume or troubleshoot a running or failed skillfid build, baseline or evaluation. Triggers include "skillfid", "evaluate this skill", "how good is my skill", "build a dataset from the docs", "skill uplift", "resume the build" and "why did the dataset build fail".
---

# skillfid

skillfid scores how faithfully a skill answers questions from its source documentation. It builds a dataset of source-grounded questions from a corpus, measures a closed-book baseline, then measures the skill against the same questions and reports uplift, failure causes and fixes. It needs Node.js 24+ and an authenticated GitHub Copilot CLI. Every command accepts `--json`.

## Workflow

1. **Corpus.** Point `--corpus` at the original source documents (a directory of Markdown or one `.md` file), never at the skill's own reference files; the dataset must not depend on the skill it judges. Use `--include`/`--exclude` globs to narrow it.
2. **Plan before spending.** `skillfid dataset plan --corpus <dir>` prints sections, estimated Copilot calls and minutes. For quick iteration add `--profile quick` (high-importance knowledge only) or `--profile standard`.
3. **Build the dataset in the background.** `skillfid dataset build --corpus <dir> --detach --json` returns at once with `operationId`, `workDir`, `statusCommand` and `waitCommand`. A full build of a 13k-word document takes roughly 15–40 minutes.
4. **Wait without polling blindly.** Repeat `skillfid operation wait --work-dir <workDir> --json`. It returns on `completed`, `job_failed`, `failed`, `interrupted`, or after `--timeout` seconds with `timeout`; on `timeout` just call it again. Do not query `operations.sqlite` and do not sleep for minutes: `<workDir>/progress.json` always has the latest stage mix, counts, failures and ETA, and the agent progress lines (`--agent`) carry the same fields.
5. **Verify.** `skillfid dataset verify --dataset <datasetPath>`.
6. **Baseline once per dataset and model.** `skillfid eval baseline --dataset <datasetPath>` (one closed-book trial per question by default).
7. **Evaluate the skill.** `skillfid eval run --dataset <datasetPath> --skill <skill dir>`; then `skillfid eval report --run <runPath> --dataset <datasetPath>` for the HTML report.
8. **Iterate cheaply.** Edit the skill, then re-run with `--since <previous run>` (only questions touched by the change and previous failures re-run), `--sample 30 --seed 1` or `--filter type=procedure` for smoke runs, `--adaptive` to spend extra trials only on questions that fail, and `skillfid eval compare --base <old run> --head <new run> --dataset <datasetPath>` to see improved and regressed questions with a verdict. `--fail-under 0.9` gates CI.
9. **Check behaviors the dataset cannot.** `--probes probes.jsonl` runs unanswerable questions and behavior checks (citations, labeled fallbacks) and reports hallucination and refusal rates separately from accuracy.

## Reading results

- Headline numbers come with confidence intervals; trust paired uplift over raw scores.
- Failures are staged: `not_discovered` (skill never loaded), `retrieval_miss` (loaded, but never read the file holding the evidence), `false_refusal`, `hallucination`, `application_error`. Fix the earliest stage first. The report ranks fix targets by expected impact.
- `progressiveDisclosure` metrics show how much of the skill each answer loaded; `loadedEverythingRate` near 1 means the skill is not fragmenting its knowledge.

## When something goes wrong

Failures print one JSON line `{"error":{"code","message","remedy","command","details"}}` to stderr under `--json`, and nothing is lost: finished work is cached.

| Exit | Code | Meaning and action |
| --- | --- | --- |
| 3 | `SECTIONS_FAILED` | Some sections did not settle. The message names each section by file, heading and line range and writes `<workDir>/failures/<operation>.json`. Re-run the same command; only failed sections repeat. Raise `--max-residual-passes` or lower `--max-section-chars` if they fail again (changing a budget never restarts the build). A section that does not settle is automatically given more passes and then split in half. |
| 3 | `QUESTIONS_NOT_CONVERGED` | Questions for a section never passed calibration; the source text may be ambiguous. Raise `--max-generation-attempts` or fix the text. |
| 3 | interrupted/failed run | `operation status` shows `interrupted`; re-run the same command (`--resume` is the default). Jobs of a stopped run are taken over immediately; `operation recover` frees them explicitly. |
| 4 | `OPERATION_LOCKED` | Another live process owns this operation. Use `operation wait` or `operation status`; start an independent run with `--fresh`. |
| 1 | `RUNNER_UNAVAILABLE` | Copilot calls fail before any section finishes: check Copilot CLI authentication and connectivity, then re-run. |
| 5 | quality gate | `--fail-under` was not met; results are still written. |

Other tips: run `skillfid operation status --work-dir <dir> --jobs` for failed and running jobs by name; use `--fresh` only to deliberately discard prior reuse; changing the model, judge model, reasoning effort or importance tiers is a different build, everything else resumes.
