#!/usr/bin/env node

/**
 * Download every published GitHub release and verify its public file surface.
 * Requires an authenticated GitHub CLI (`gh`) session.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const auditRoot = resolve(root, 'release-audit');
const repository = process.env.GITHUB_REPOSITORY ?? 'scrunchds/Command-Center';
const expected = ['main.js', 'manifest.json', 'styles.css'];

rmSync(auditRoot, { recursive: true, force: true });
mkdirSync(auditRoot, { recursive: true });

try {
	const releases = JSON.parse(gh([
		'release', 'list', '--repo', repository, '--limit', '100',
		'--json', 'tagName,isDraft,isPrerelease',
	]));
	const published = releases.filter(release => !release.isDraft);
	if (published.length === 0) throw new Error(`No published releases found for ${repository}.`);

	for (const release of published) {
		const directory = resolve(auditRoot, release.tagName);
		mkdirSync(directory, { recursive: true });
		gh(['release', 'download', release.tagName, '--repo', repository, '--dir', directory]);
		const files = readdirSync(directory).sort();
		if (files.join('\n') !== expected.join('\n')) {
			throw new Error(`${release.tagName} exposes unexpected files: ${files.join(', ') || '(none)'}`);
		}
		for (const file of files) {
			if (!statSync(resolve(directory, file)).isFile()) {
				throw new Error(`${release.tagName}/${file} is not a regular file.`);
			}
		}
	}

	execFileSync(process.execPath, ['scripts/sanitize-repo.mjs', '--artifacts'], {
		cwd: root,
		stdio: 'inherit',
	});
	console.log(`Audited ${published.length} published release(s); each exposes only ${expected.join(', ')}.`);
} finally {
	rmSync(auditRoot, { recursive: true, force: true });
}

function gh(arguments_) {
	try {
		return execFileSync('gh', arguments_, {
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (error) {
		const detail = error?.stderr?.toString().trim() || error?.message || String(error);
		throw new Error(`gh ${arguments_.map(value => basename(value) === value ? value : relative(root, value).split(sep).join('/')).join(' ')} failed: ${detail}`);
	}
}
