# Contributing to Command Center

Thank you for helping improve Command Center. Contributions that are focused, secure, tested, and compatible with Obsidian desktop are welcome.

## Before opening an issue

- Search existing issues and discussions first.
- Use [GitHub Discussions](https://github.com/scrunchds/Command-Center/discussions) for usage questions and early design proposals.
- Use the relevant issue form for reproducible bugs or actionable feature requests.
- Never post API keys, vault contents, personal information, local paths, private URLs, or diagnostic bundles containing private data.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Development setup

Requirements:

- Node.js 20, 22, or 24
- npm
- Obsidian desktop for manual integration testing

```bash
git clone https://github.com/scrunchds/Command-Center.git
cd Command-Center
npm ci
npm test
```

For manual testing, clone or link the repository to `<vault>/.obsidian/plugins/command-center`, run `npm run dev`, reload Obsidian, and enable Command Center.

## Making a change

1. Fork the repository and create a short branch from `main`.
2. Keep the change narrowly scoped; open a discussion before large architectural work.
3. Follow existing TypeScript style and preserve strict typing and least-privilege boundaries.
4. Add or update tests for behavior changes.
5. Update README or CHANGELOG documentation when user-visible behavior changes.
6. Do not commit generated runtime state, credentials, vault data, logs, benchmark output, or release directories.
7. Run all required checks:

```bash
npm run sanitize
npm run typecheck
npm run lint
npm test
npm run benchmark
npm run benchmark:check
npm run package
npm audit
```

## Release process

When cutting a new release, follow these exact steps:

1. Update the version in `manifest.json`, `package.json`, and `versions.json`.
2. Run `npm run package` to build and sanitize release assets.
3. Commit the version bump and release assets.
4. Create a **git tag matching the version number exactly** (no prefix):
   ```bash
   git tag 1.1.12
   git push origin 1.1.12
   ```
5. Create a GitHub Release from the tag, attaching the three files from `release/command-center/`:
   - `main.js`
   - `manifest.json`
   - `styles.css`

> [!IMPORTANT]
> Obsidian's community plugin updater requires git tags to match the version string **exactly** — no `v` prefix, no leading or trailing characters. A tag like `v1.1.12` will be rejected and users will not receive the update.

## Pull requests

A pull request should:

- Explain the problem, solution, scope, and user impact.
- Link related issues with `Fixes #123` where appropriate.
- Describe testing performed and any manual Obsidian verification.
- Include screenshots or recordings for visible UI changes, with private vault content removed.
- Identify security, privacy, migration, performance, and compatibility implications.
- Avoid unrelated formatting or generated-file churn.
- Pass CI on Node.js 20/22/24 across Linux, macOS, and Windows.

Maintainers may request changes or close proposals that are unsafe, out of scope, insufficiently tested, or incompatible with the project's direction. By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).

## Community expectations

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Be constructive, assume good intent, and critique ideas rather than people.
