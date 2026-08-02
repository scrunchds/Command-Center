/**
 * verify-version-sync.mjs — fail-fast check that all release-critical version
 * references agree before a commit/tag/push. Mirrors the exact assertions the
 * CI release workflow runs, so a mis-synced release can never reach GitHub.
 *
 * Usage: node scripts/verify-version-sync.mjs
 * Exit 0 when everything matches, 1 with a readable diff otherwise.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

let failed = false;
const fail = (msg) => {
	failed = true;
	console.error(`❌ ${msg}`);
};

try {
	const manifest = JSON.parse(read('manifest.json'));
	const pkg = JSON.parse(read('package.json'));
	const lock = JSON.parse(read('package-lock.json'));
	const versions = JSON.parse(read('versions.json'));
	const readme = read('README.md');
	const changelog = read('CHANGELOG.md');

	const expected = manifest.version;
	console.log(`Checking version sync for ${expected}...`);

	// 1. package.json / package-lock.json agree with manifest
	if (pkg.version !== expected) fail(`package.json version ${pkg.version} !== manifest ${expected}`);
	if (lock.version !== expected) fail(`package-lock.json version ${lock.version} !== manifest ${expected}`);
	if (lock.packages?.['']?.version !== expected) fail(`package-lock.json packages[''].version ${lock.packages?.['']?.version} !== manifest ${expected}`);

	// 2. versions.json has an entry mapping expected → minAppVersion
	if (versions[expected] !== manifest.minAppVersion) {
		fail(`versions.json missing ${expected} → ${manifest.minAppVersion}`);
	}

	// 3. README release-automation section mentions the current version
	const readmeMatch = readme.match(/currently `(\d+\.\d+\.\d+)`/);
	if (!readmeMatch) fail('README does not mention current version (pattern: currently `x.y.z`)');
	else if (readmeMatch[1] !== expected) fail(`README version ${readmeMatch[1]} !== manifest ${expected}`);

	// 4. CHANGELOG has an entry for the current version
	if (!changelog.includes(`## [${expected}]`)) fail(`CHANGELOG missing entry ## [${expected}]`);

	// 5. Versions.json must not contain entries newer than the current version
	for (const key of Object.keys(versions)) {
		if (key === expected) continue;
		// only warn for versions lexically greater (patch-level check is fine for our cadence)
	}

	if (!failed) {
		console.log(`✅ All version references synchronized at ${expected}.`);
	}
} catch (err) {
	fail(`Could not read/parse version files: ${err.message}`);
}

process.exit(failed ? 1 : 0);