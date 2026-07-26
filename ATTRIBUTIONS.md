# Third-Party Attributions and License Audit

This document records the dependency and interoperability review for Command Center 1.0.2. Command Center itself is distributed under the MIT License; see [`LICENSE`](LICENSE).

> This inventory is informational and is not legal advice. Copyright in each third-party project remains with its respective authors. The authoritative license text shipped by each package is available in that package's source distribution and npm tarball.

## Distributed plugin boundary

The installable Obsidian release directory contains Command Center's compiled `main.js`, `styles.css`, and `manifest.json`. The project license and attribution documents are published at repository level. Obsidian and Pi are **not bundled**:

- `obsidian` and Node/Electron modules are external imports supplied by the host application.
- `@earendil-works/pi-coding-agent` is an optional, separately installed executable invoked through its documented JSONL RPC interface.
- `test/mock-pi-daemon.js` is an original minimal protocol test double. It contains no copied Pi implementation or binary.
- Build, lint, type-definition, and test packages are development-only and are not shipped in `main.js`.

## Runtime hosts and optional companion

| Project | Version reviewed | License | Use | Upstream |
|---|---:|---|---|---|
| Obsidian API | 1.12.3 package metadata | MIT | Compile-time API/types; Obsidian is an external proprietary host application and is not redistributed | <https://github.com/obsidianmd/obsidian-api> |
| Pi coding agent (`@earendil-works/pi-coding-agent`) | 0.82.1 installed companion | MIT | Optional external RPC runner; not an npm dependency and not bundled | <https://github.com/earendil-works/pi/tree/main/packages/coding-agent> |
| Node.js APIs | Host-provided | MIT | External desktop runtime APIs | <https://github.com/nodejs/node> |
| Electron APIs | Host-provided | MIT | External desktop host APIs | <https://github.com/electron/electron> |
| CodeMirror / Lezer APIs | Host-provided | MIT | Marked external by the build and supplied transitively by Obsidian | <https://github.com/codemirror> |

“Obsidian” is a trademark of Dynalist Inc. This plugin is independent and is not endorsed by Dynalist Inc. or the Pi maintainers.

## Direct development dependencies

Versions below are the resolved versions in `package-lock.json` at audit time.

| Package | Resolved version | SPDX license | Upstream |
|---|---:|---|---|
| `@eslint/js` | 9.39.4 | MIT | <https://github.com/eslint/eslint> |
| `@types/node` | 22.19.17 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped> |
| `esbuild` | 0.25.5 | MIT | <https://github.com/evanw/esbuild> |
| `eslint` | 9.39.4 | MIT | <https://github.com/eslint/eslint> |
| `eslint-plugin-obsidianmd` | 0.4.0 | MIT | <https://github.com/obsidianmd/eslint-plugin> |
| `globals` | 17.6.0 | MIT | <https://github.com/sindresorhus/globals> |
| `jiti` | 2.7.0 | MIT | <https://github.com/unjs/jiti> |
| `obsidian` | 1.12.3 | MIT | <https://github.com/obsidianmd/obsidian-api> |
| `typescript` | 5.9.3 | Apache-2.0 | <https://github.com/microsoft/TypeScript> |
| `typescript-eslint` | 8.59.2 | MIT | <https://github.com/typescript-eslint/typescript-eslint> |

## Complete npm lockfile license inventory

The lockfile contains 335 installed package entries (including nested and platform-specific packages):

| Declared license | Entries | Compatibility finding |
|---|---:|---|
| MIT | 285 | Permissive; compatible |
| Apache-2.0 | 24 | Permissive; compatible, with Apache notice/patent terms applying to those packages |
| ISC | 13 | Permissive; compatible |
| BSD-2-Clause | 7 | Permissive; compatible |
| BSD-3-Clause | 2 | Permissive; compatible |
| 0BSD | 1 | Permissive; compatible |
| BlueOak-1.0.0 | 1 | Permissive; compatible |
| Python-2.0 | 1 | Permissive; compatible |
| MPL-2.0 | 1 | File-level weak copyleft; development-only, unmodified, and not distributed |

Non-MIT outliers requiring explicit attention:

- `eslint-plugin-no-unsanitized@4.1.5` — MPL-2.0. This is a transitive lint-only package. It is neither modified nor included in the release bundle, so its file-level copyleft does not apply to Command Center source.
- `typescript@5.9.3` and Apache-licensed ESLint-related transitive packages — Apache-2.0, development-only and not bundled.
- `argparse@2.0.1` — Python-2.0, development-only and not bundled.
- `@typescript-eslint/typescript-estree/node_modules/minimatch@10.2.5` — BlueOak-1.0.0, development-only and not bundled.

No GPL, LGPL, AGPL, SSPL, BUSL, or other strong/restrictive copyleft license was declared by any package in `package-lock.json`. No package entry had a missing license declaration.

The full package-by-package source of truth is `package-lock.json`; npm package tarballs contain their applicable license texts. Because these packages are not redistributed in the plugin release, copying hundreds of development-package license files into the user-installed plugin is not required by this distribution boundary.

## Pi companion dependency review

The locally installed Pi 0.82.1 package declares MIT. A recursive metadata scan of its 122 installed dependency entries found only MIT (50), Apache-2.0 (45), BSD-3-Clause (13), BlueOak-1.0.0 (5), ISC (8), and 0BSD (1). No GPL-family or undeclared license was found. Pi and those dependencies remain a separate installation; users receive their license materials from the Pi npm distribution.

## Build and notice handling

- esbuild emits no third-party runtime package into the plugin beyond Command Center source; host APIs are externalized.
- License and attribution documents remain repository-level publication materials; `release/command-center/` is restricted to Obsidian's three installable production files.
- Package metadata declares `MIT`, matching the repository `LICENSE`.
- Future dependency upgrades should repeat the lockfile scan and update this document when versions, license counts, or the bundle boundary change.

## Audit limitations

This review checks declared package metadata, repository structure, imports, and bundle boundaries. It does not establish trademark rights, audit remote model-provider services, or replace review by qualified counsel for a particular distribution jurisdiction.
