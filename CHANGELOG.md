# Changelog

## [0.2.0](https://github.com/waldekmastykarz/knowledge-eval/compare/v0.1.2...v0.2.0) (2026-10-09)

### Features

- A single failing section no longer discards a dataset build. Failures are reported immediately by file, heading and line range, the other sections are kept, and a section that does not settle gets a larger pass budget and is then split in half. Failed sections save a transcript of every prompt and answer
- Raising `--max-residual-passes` (or any other budget) resumes the same build instead of restarting it, and finished sections are reused by later builds with the same settings
- Jobs from a stopped run are taken over immediately: `SIGINT` and `SIGTERM` release claimed jobs, leases are short with heartbeats, and two runs can no longer work on the same operation at once
- Progress shows the stage, section counts, failures and an ETA in agent mode, and `progress.json` and `events.jsonl` mirror the state in the work directory
- New `operation wait`, `operation recover` and richer `operation status` (`--jobs`, `--watch`), `--detach` for background runs, and structured `--json` errors with distinct exit codes
- New `dataset plan` previews the cost of a build, and `--profile`, `--importance`, `--include`, `--exclude`, `--min-section-chars`, `--max-audit-passes` and `--max-generation-attempts` control its scope and budgets. A corpus can be a single file
- Fewer Copilot calls per build: small sections are merged, judgments run in parallel, and prompts put the source first so it can be cached
- Skill answers record a trace of what the agent did. Failures are staged (not discovered, retrieval miss, false refusal, hallucination, application error), and progressive-disclosure metrics show how much of the skill each answer loaded
- New `eval run` options: `--sample`, `--seed`, `--filter`, `--adaptive`, `--since`, `--probes` and `--fail-under`, plus `eval compare` for paired run comparisons
- Reports and summaries add confidence intervals, breakdowns by section, importance and difficulty, a corpus heat map, usage and latency
- A bundled agent skill in `skills/skillfid` teaches coding agents the workflow and can be installed with `npx skills add`

### Bug fixes

- Perfect oracle answers are no longer failed because rubric weights summed to slightly less than 1
- Operations whose run stopped no longer appear as running indefinitely

### Breaking changes

- `eval baseline` defaults to one trial per question, and existing baselines no longer match the new compatibility rules and must be recreated
- The printed resume command is now `skillfid …` instead of `npm start -- …`
- `--max-residual-passes` now limits residual passes per section only, and `--max-audit-passes` limits the completeness audit

### Maintenance

- Updated `@github/copilot-sdk` to 1.0.16
- Restructured the README around the step-by-step workflow

## [0.1.2](https://github.com/waldekmastykarz/knowledge-eval/compare/v0.1.1...v0.1.2) (2026-09-28)

### Bug fixes

- Improved dataset build progress reporting with steadier completion updates and more accurate time estimates
- Isolated temporary workspaces so concurrent dataset builds no longer interfere with each other

## 0.1.1 (2026-09-25)

### Features

- Initial release of `skillfid`, a CLI for evaluating how faithfully agent skills apply their source documentation

### Bug fixes

- Fixed the CLI exiting silently when invoked through a symlink, such as after `npm link` or a global install
- `--version` now reports the package version

### Maintenance

- Updated `@github/copilot-sdk` to 1.0.14
