# Contributing

Thanks for contributing to skillfid.

## Before you start

Open an issue before substantial changes so the approach can be agreed before implementation. For small fixes, a pull request is welcome directly.

## Development

Requirements:

- Node.js 24 or later
- GitHub Copilot CLI authenticated for Copilot access for live evaluation workflows

Install dependencies and run the test suite:

```sh
npm install
npm test
```

Tests should not require live Copilot calls. Keep generated datasets, runs, workspaces, credentials, and dependency directories out of commits; the repository `.gitignore` excludes them.

## Pull requests

Keep changes focused and include tests for behavior changes. Update public documentation when commands or data contracts change, and confirm `npm test` passes before opening the pull request.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
