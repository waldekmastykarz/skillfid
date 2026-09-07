---
name: bump-version
description: 'Use when asked to bump the version, prepare or create a release, update the version number, or determine a semantic version increment from recent commits.'
---

# Bump Version

Analyze unreleased commits, recommend a semantic version bump, and apply it with
`npm version` only after the user confirms.

## Workflow

Follow these steps in order.

### 1. Identify the release range

Run `git tag --list 'v*' --sort=-v:refname | head -1`. If a tag exists, inspect
`git log <latest-tag>..HEAD --oneline`. Otherwise, inspect `git log --oneline` and
treat this as the initial release.

Stop if there are no unreleased commits.

### 2. Recommend the bump

Choose the highest applicable level:

- **major**: a breaking change, including `BREAKING CHANGE`, `BREAKING:`, or `!`
  after a conventional commit type
- **minor**: new functionality, including `feat:` or `feat(scope):`
- **patch**: fixes, documentation, dependencies, maintenance, refactoring, tests,
  CI, or performance improvements

Read the current version from `package.json` and calculate the proposed version.

### 3. Confirm with the user

**STOP. Do not modify files, commit, or tag without confirmation.**

Show the unreleased commits, recommended bump with reasoning, and current and
proposed versions. Ask the user to confirm or choose another bump type.

### 4. Update the changelog

After confirmation, read `CHANGELOG.md` if it exists and preserve its style. If it
does not exist, create it with a `# Changelog` heading.

Add the new release below the heading using today's date. Include only applicable
sections from **Features**, **Bug fixes**, and **Maintenance**. Describe user-facing
changes rather than copying commit messages. Skip internal changes unless they
affect users.

When a previous tag exists, link the version heading to:

`https://github.com/waldekmastykarz/knowledge-eval/compare/vPREVIOUS...vNEW`

Stage `CHANGELOG.md`.

### 5. Apply the version bump

Commit the changelog, then run `npm version`:

```sh
git commit -m "docs: update changelog for vX.Y.Z"
npm version <patch|minor|major>
```

`npm version` requires a clean working tree. Do not discard unrelated changes to
make it clean; stop and explain what must be committed first.

### 6. Publish

Remind the user to push the commits and tag:

```sh
git push && git push --tags
```

The tag triggers `.github/workflows/publish.yml`, which publishes to npm.