/**
 * release.mjs — one-command release automation
 *
 * Usage:
 *   node scripts/release.mjs <version> [--push]
 *
 * Example:
 *   node scripts/release.mjs 1.1.17 --push
 *
 * What it does:
 *   1. Validates semver format and that version > current
 *   2. Bumps version in: package.json, manifest.json, versions.json,
 *      package-lock.json, README.md, CHANGELOG.md
 *   3. Runs pre-flight checks: lint, typecheck, sanitize, tests
 *   4. Builds production bundle + release package
 *   5. Commits all changes
 *   6. Creates an annotated tag (without 'v' prefix, matching
 *      .github/workflows/release.yml trigger pattern [0-9]+.[0-9]+.[0-9]+)
 *   7. If --push is set, pushes commit + tag to origin
 *
 * Exit code 0 on success, non-zero with error details on failure.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ─── Helpers ───────────────────────────────────────────── */

function run(cmd, cwd = ROOT) {
	console.log(`\n$ ${cmd}`);
	try {
		execSync(cmd, { cwd, stdio: 'inherit', timeout: 120_000 });
	} catch (err) {
		console.error(`\n❌ Command failed: ${cmd}`);
		process.exit(1);
	}
}

function read(path) {
	return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
}

function write(path, data) {
	writeFileSync(resolve(ROOT, path), JSON.stringify(data, null, '\t') + '\n');
}

/* ─── Validate arguments ────────────────────────────────── */

const [,, targetVersion, pushFlag] = process.argv;
if (!targetVersion) {
	console.error('Usage: node scripts/release.mjs <version> [--push]');
	console.error('  <version>  Semver version to release (e.g. 1.1.17)');
	console.error('  --push     Push commit and tag to origin');
	process.exit(1);
}

// Strict SemVer without a leading 'v' — the release workflow tag pattern
// must match exactly.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
if (!SEMVER.test(targetVersion)) {
	console.error(`❌ Invalid version: "${targetVersion}". Must be strict semver like 1.1.17 (no "v" prefix).`);
	process.exit(1);
}

/* ─── Step 0: Read current state ────────────────────────── */

const manifest = read('manifest.json');
const currentVersion = manifest.version;
if (currentVersion === targetVersion) {
	console.error(`❌ Version ${targetVersion} is already the current version. Bump to a higher version.`);
	process.exit(1);
}

// Simple comparator — assumes all three parts are non-negative integers
const [cMajor, cMinor, cPatch] = currentVersion.split('.').map(Number);
const [tMajor, tMinor, tPatch] = targetVersion.split('.').map(Number);
const cmp = (tMajor - cMajor) * 1_000_000 + (tMinor - cMinor) * 1_000 + (tPatch - cPatch);
if (cmp <= 0) {
	console.error(`❌ Target version ${targetVersion} is not greater than current version ${currentVersion}.`);
	process.exit(1);
}

console.log(`\n═══════════════════════════════════════════`);
console.log(`  Release: ${currentVersion} → ${targetVersion}`);
console.log(`═══════════════════════════════════════════\n`);

/* ─── Step 1: Bump all version files ────────────────────── */

console.log('─── 1. Bumping version files ───');

// package.json
const pkg = read('package.json');
pkg.version = targetVersion;
write('package.json', pkg);

// manifest.json
manifest.version = targetVersion;
write('manifest.json', manifest);

// versions.json
const versions = read('versions.json');
if (!(targetVersion in versions)) {
	versions[targetVersion] = manifest.minAppVersion;
	write('versions.json', versions);
}

// package-lock.json
const lock = read('package-lock.json');
lock.version = targetVersion;
if (lock.packages?.['']?.version) {
	lock.packages[''].version = targetVersion;
}
write('package-lock.json', lock);

console.log('  ✅ package.json, manifest.json, versions.json, package-lock.json →', targetVersion);

/* ─── Step 2: Update README version reference ───────────── */

console.log('─── 2. Updating README version reference ───');

const readmePath = resolve(ROOT, 'README.md');
let readme = readFileSync(readmePath, 'utf8');
const readmeRegex = /currently `(\d+\.\d+\.\d+)`/;
const readmeMatch = readme.match(readmeRegex);
if (readmeMatch) {
	readme = readme.replace(readmeRegex, `currently \`${targetVersion}\``);
	writeFileSync(readmePath, readme, 'utf8');
	console.log(`  ✅ README version reference: ${readmeMatch[1]} → ${targetVersion}`);
} else {
	console.warn('  ⚠️  Could not find "currently `x.y.z`" pattern in README. Update manually.');
}

/* ─── Step 3: Add CHANGELOG entry ───────────────────────── */

console.log('─── 3. Adding CHANGELOG entry ───');

const changelogPath = resolve(ROOT, 'CHANGELOG.md');
let changelog = readFileSync(changelogPath, 'utf8');
const today = new Date().toISOString().slice(0, 10);
const entry = `## [${targetVersion}] - ${today}\n\n### Fixed\n\n- No changelog entry provided. Edit CHANGELOG.md to describe changes.\n\n`;
// Insert before the first existing version entry (## [x.y.z]) or append
const firstEntry = changelog.indexOf('\n## [');
if (firstEntry !== -1) {
	changelog = changelog.slice(0, firstEntry + 1) + entry + changelog.slice(firstEntry + 1);
	writeFileSync(changelogPath, changelog, 'utf8');
	console.log(`  ✅ CHANGELOG entry placeholder added for ${targetVersion}.`);
	console.log('  ⚠️  Edit CHANGELOG.md to describe your changes before pushing!');
} else {
	console.warn('  ⚠️  Unexpected CHANGELOG format. Add entry manually.');
}

/* ─── Step 4: Pre-flight checks ─────────────────────────── */

console.log('\n─── 4. Running pre-flight checks ───');

console.log('\n─── 4a. Sanitize (PII/secret audit) ───');
run('npm run sanitize');

console.log('\n─── 4b. TypeScript type-check ───');
run('npx tsc --noEmit');

console.log('\n─── 4c. Lint ───');
run('npm run lint');

console.log('\n─── 4d. Core tests ───');
run('npx tsx test/verify.mjs');

console.log('\n─── 4e. React tests ───');
run('npx tsx test/react-suite.mjs');

/* ─── Step 5: Build + package ───────────────────────────── */

console.log('\n─── 5. Building release package ───');
run('npm run package');

/* ─── Step 6: Git commit ────────────────────────────────── */

console.log('\n─── 6. Committing release ───');

// Check that no uncommitted changes remain (should be clean after version bumps)
const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
if (status) {
	run(`git add -A`);
	run(`git commit -m "chore(release): ${targetVersion}"`);
	console.log(`  ✅ Committed: chore(release): ${targetVersion}`);
} else {
	console.log('  ℹ️  No uncommitted changes to commit.');
}

/* ─── Step 7: Create tag ────────────────────────────────── */

console.log('\n─── 7. Tagging release ───');

// Delete local tag if it already exists (stale from a previous attempt)
try {
	execSync(`git tag -d ${targetVersion}`, { cwd: ROOT, stdio: 'pipe' });
} catch { /* tag didn't exist locally */ }

run(`git tag -a ${targetVersion} -m "${targetVersion}: see CHANGELOG for details"`);

/* ─── Step 8: Push (optional) ───────────────────────────── */

if (pushFlag === '--push') {
	console.log('\n─── 8. Pushing to origin ───');

	// Pull first with rebase to avoid remote divergence
	try {
		execSync('git pull --rebase origin main', { cwd: ROOT, stdio: 'inherit', timeout: 30_000 });
	} catch {
		console.error('⚠️  git pull --rebase failed. Resolve conflicts manually, then push.');
		console.error('   git push origin main --tags');
		process.exit(1);
	}

	run('git push origin main');
	run(`git push origin ${targetVersion}`);
	console.log(`\n  ✅ Pushed main + tag ${targetVersion} to origin.`);
} else {
	console.log('\n─── 8. Skipping push (no --push flag) ───');
	console.log('  Run the following to publish:');
	console.log(`   git push origin main`);
	console.log(`   git push origin ${targetVersion}`);
}

/* ─── Done ──────────────────────────────────────────────── */

console.log(`\n═══════════════════════════════════════════`);
console.log(`  ✅ Release ${targetVersion} ready.`);
console.log(`═══════════════════════════════════════════`);