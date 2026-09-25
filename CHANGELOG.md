# Changelog

## 0.1.1 (2026-09-25)

### Features

- Initial release of `skillfid`, a CLI for evaluating how faithfully agent skills apply their source documentation

### Bug fixes

- Fixed the CLI exiting silently when invoked through a symlink, such as after `npm link` or a global install
- `--version` now reports the package version

### Maintenance

- Updated `@github/copilot-sdk` to 1.0.14
