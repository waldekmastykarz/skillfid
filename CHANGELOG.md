# Changelog

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
