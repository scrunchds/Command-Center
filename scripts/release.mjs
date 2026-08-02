/**
 * release.mjs — one-command release automation
 *
 * Usage:
 *   node scripts/release.mjs <version> [--push]
 *
 * Example:
 *   node scripts/release.mjs 1.2.0 --push
 *
 * Order of operations:
 *   1. Validate semver, version > current, version sync
 *   2. Run pre-flight checks (lint, typecheck, sanitize, tests)
 *   3. Bump version in all files
 *   4. Update README version reference AND test badge (from actual test count)
 *   5. Generate CHANGELOG entry from git log between current tag and HEAD
 *   6. Build production bundle + release package
 *   7. Commit all changes
 *   8. Create annotated tag (no 'v' prefix — matches workflow pattern)
 *   9. Push commit + tag (if --push)
 *
 * Exit code 0 on success.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ─── Helpers ───────────────────────────────────────────── */

function run(cmd, cwd = ROOT) {
	console.log(`\n$ ${Array.isArray(cmd) ? cmd.join(' ') : cmd}`);
	try {
		if (Array.isArray(cmd)) {
			execSync(cmd[0], cmd.slice(1), { cwd, stdio: 'inherit', timeout: 180_000 });
		} else {
			execSync(cmd, { cwd, stdio: 'inherit', timeout: 180_000 });
		}
	} catch {
		console.error(`\n❌ Command failed: ${Array.isArray(cmd) ? cmd.join(' ') : cmd}`);
		process.exit(1);
	}
}

function readJSON(p) {
	return JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));
}

function writeJSON(p, data) {
	writeFileSync(resolve(ROOT, p), JSON.stringify(data, null, '\t') + '\n');
}

/* ─── Validate arguments ────────────────────────────────── */

const [,, targetVersion, pushFlag] = process.argv;
if (!targetVersion || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(targetVersion)) {
	console.error('Usage: node scripts/release.mjs <version> [--push]');
	console.error('  <version>  Strict semver (e.g. 1.2.0, no "v" prefix)');
	console.error('  --push     Push commit and tag to origin');
	process.exit(1);
}

const manifest = readJSON('manifest.json');
const currentVersion = manifest.version;
if (currentVersion === targetVersion) {
	console.error(`❌ Version ${targetVersion} is already current.`);
	process.exit(1);
}

// Version must be strictly greater
const [cMajor, cMinor, cPatch] = currentVersion.split('.').map(Number);
const [tMajor, tMinor, tPatch] = targetVersion.split('.').map(Number);
if ((tMajor - cMajor) * 1_000_000 + (tMinor - cMinor) * 1_000 + (tPatch - cPatch) <= 0) {
	console.error(`❌ ${targetVersion} <= ${currentVersion}. Bump to a higher version.`);
	process.exit(1);
}

console.log(`\n═══════════════════════════════════════════`);
console.log(`  Release: ${currentVersion} → ${targetVersion}`);
console.log(`═══════════════════════════════════════════\n`);

/* ─── Step 1: Pre-flight checks (must pass before any mutations) ── */

console.log('─── 1. Pre-flight checks ───');

// Version sync
console.log('\n─── 1a. Version sync ───');
execSync('node scripts/verify-version-sync.mjs', { cwd: ROOT, stdio: 'inherit' });

console.log('\n─── 1b. Sanitize ───');
run('npm run sanitize');

console.log('\n─── 1c. TypeScript ───');
run('npx tsc --noEmit');

console.log('\n─── 1d. Lint ───');
run('npm run lint');

console.log('\n─── 1e. Core tests ───');
// Capture the test count from verify.mjs output
let coreTestCount = 0;
try {
	const coreOut = execSync('npx tsx test/verify.mjs', { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
	const coreMatch = coreOut.match(/(\d+) passed/);
	coreTestCount = coreMatch ? parseInt(coreMatch[1], 10) : 0;
	console.log(coreOut.split('\n').slice(-3).join('\n'));
} catch {
	console.error('❌ Core tests failed.');
	process.exit(1);
}

console.log('\n─── 1f. React tests ───');
let reactTestCount = 0;
try {
	const reactOut = execSync('npx tsx test/react-suite.mjs', { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
	const reactMatch = reactOut.match(/(\d+) passed/);
	reactTestCount = reactMatch ? parseInt(reactMatch[1], 10) : 0;
	console.log(reactOut.split('\n').slice(-3).join('\n'));
} catch {
	console.error('❌ React tests failed.');
	process.exit(1);
}

const totalTests = coreTestCount + reactTestCount;
console.log(`\n  ✅ Tests: ${coreTestCount} core + ${reactTestCount} react = ${totalTests} total`);

/* ─── Step 2: Bump version files ────────────────────────── */

console.log('\n─── 2. Bumping version files ───');

const pkg = readJSON('package.json');
pkg.version = targetVersion;
writeJSON('package.json', pkg);

manifest.version = targetVersion;
writeJSON('manifest.json', manifest);

const versions = readJSON('versions.json');
if (!(targetVersion in versions)) {
	versions[targetVersion] = manifest.minAppVersion;
	writeJSON('versions.json', versions);
}

const lock = readJSON('package-lock.json');
lock.version = targetVersion;
if (lock.packages?.['']?.version) lock.packages[''].version = targetVersion;
writeJSON('package-lock.json', lock);

console.log('  ✅ package.json, manifest.json, versions.json, package-lock.json');

/* ─── Step 3: Update README ─────────────────────────────── */

console.log('\n─── 3. Updating README ───');

const readmePath = resolve(ROOT, 'README.md');
let readme = readFileSync(readmePath, 'utf8');
let readmeChanged = false;

// Update version reference
readme = readme.replace(
	/(currently )`(\d+\.\d+\.\d+)`/,
	(_m, pre) => `${pre}\`${targetVersion}\``,
);
readmeChanged = true;

// Update test badge to actual total count
readme = readme.replace(
	/(tests-)\d+(%20passing-brightgreen)/,
	(_m, pre, suf) => `${pre}${totalTests}${suf}`,
);
readmeChanged = true;

if (readmeChanged) {
	writeFileSync(readmePath, readme, 'utf8');
	console.log(`  ✅ Version: ${targetVersion}`);
	console.log(`  ✅ Test badge: ${totalTests} passing`);
}

/* ─── Step 4: Generate CHANGELOG entry ──────────────────── */

console.log('\n─── 4. Generating CHANGELOG entry ───');

const changelogPath = resolve(ROOT, 'CHANGELOG.md');
let changelog = readFileSync(changelogPath, 'utf8');

// Collect commit subjects between the last tag and HEAD
let logEntries = '';
try {
	const lastTag = execSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: ROOT, encoding: 'utf8' }).trim();
	const log = execSync('git', ['log', `${lastTag}..HEAD`, '--oneline', '--no-decorate'], { cwd: ROOT, encoding: 'utf8' }).trim();
	if (log) {
		logEntries = '\n' + log.split('\n')
			.map(line => {
				// Strip commit hash and prefix
				const msg = line.replace(/^[0-9a-f]+\s+/, '');
				return `- ${msg}`;
			})
			.join('\n') + '\n';
	}
} catch { /* first release with no prior tag */ }

const today = new Date().toISOString().slice(0, 10);
const entry = `## [${targetVersion}] - ${today}\n\n### Changed\n${logEntries || '- Release ${targetVersion}.\n'}\n`;

// Insert before the first existing version entry
const firstEntry = changelog.indexOf('\n## [');
if (firstEntry !== -1) {
	changelog = changelog.slice(0, firstEntry + 1) + entry + changelog.slice(firstEntry + 1);
	writeFileSync(changelogPath, changelog, 'utf8');
	console.log(`  ✅ Entry added for ${targetVersion}`);
} else {
	console.warn('  ⚠️  Could not insert CHANGELOG entry. Add manually.');
}

/* ─── Step 5: Build + package ───────────────────────────── */

console.log('\n─── 5. Building release package ───');
run('npm run package');

/* ─── Step 6: Commit ────────────────────────────────────── */

console.log('\n─── 6. Committing release ───');

const status = execSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (status) {
	run(['git', 'add', '-A']);
	run(['git', 'commit', '-m', `chore(release): ${targetVersion}`]);
	console.log(`  ✅ Committed: chore(release): ${targetVersion}`);
} else {
	console.log('  ℹ️  Nothing to commit.');
}

/* ─── Step 7: Tag ───────────────────────────────────────── */

console.log('\n─── 7. Tagging release ───');
try {
	execSync('git', ['tag', '-d', targetVersion], { cwd: ROOT, stdio: 'pipe' });
} catch { /* ok */ }
run(['git', 'tag', '-a', targetVersion, '-m', targetVersion]);

/* ─── Step 8: Push ──────────────────────────────────────── */

if (pushFlag === '--push') {
	console.log('\n─── 8. Pushing to origin ───');
	try {
		execSync('git', ['pull', '--rebase', 'origin', 'main'], { cwd: ROOT, stdio: 'inherit', timeout: 30_000 });
	} catch {
		console.error('⚠️  git pull --rebase failed. Push manually:');
		console.error('   git push origin main --tags');
		process.exit(1);
	}
	run(['git', 'push', 'origin', 'main']);
	run(['git', 'push', 'origin', targetVersion]);
	console.log(`\n  ✅ Pushed main + ${targetVersion} to origin.`);
} else {
	console.log('\n─── 8. Skipping push (no --push flag) ───');
	console.log('  Run manually:');
	console.log(`   git push origin main`);
	console.log(`   git push origin ${targetVersion}`);
}

console.log(`\n═══════════════════════════════════════════`);
console.log(`  ✅ Release ${targetVersion} ready.`);
console.log(`═══════════════════════════════════════════`);