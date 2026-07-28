#!/usr/bin/env node

/**
 * Fail-closed repository PII/secret audit for commits and release packaging.
 *
 * Usage:
 *   node scripts/sanitize-repo.mjs            # tracked + untracked public files
 *   node scripts/sanitize-repo.mjs --staged   # staged blobs only (pre-commit)
 *   node scripts/sanitize-repo.mjs --release  # repository plus built/release assets
 *
 * A deliberate test fixture may suppress one line with `SANITIZE_ALLOW` and a
 * reason. Never use that marker for real credentials or personal data.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const stagedOnly = args.has('--staged');
const includeRelease = args.has('--release');
const artifactsOnly = args.has('--artifacts');
const allowedArgs = new Set(['--staged', '--release', '--artifacts']);
for (const arg of args) if (!allowedArgs.has(arg)) fail(`Unknown option: ${arg}`);
if ([stagedOnly, includeRelease, artifactsOnly].filter(Boolean).length > 1) {
	fail('--staged, --release, and --artifacts cannot be combined.');
}

const maxBytes = 2 * 1024 * 1024;
const selfPath = 'scripts/sanitize-repo.mjs';
const allowMarker = ['SANITIZE', 'ALLOW'].join('_');
const textExtensions = new Set([
	'', '.cjs', '.css', '.example', '.html', '.js', '.json', '.jsonc', '.jsx',
	'.md', '.mjs', '.mts', '.scss', '.sh', '.toml', '.ts', '.tsx', '.txt',
	'.yaml', '.yml',
]);
const exactTextNames = new Set(['LICENSE', '.gitignore', '.npmrc']);
const excludedPrefixes = ['node_modules/', '.git/', 'release/'];
const excludedNames = new Set();
const findings = [];

const checks = [
	{
		id: 'private-key',
		description: 'private key material',
		pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
	},
	{
		id: 'provider-secret',
		description: 'provider or source-control credential',
		pattern: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
	},
	{
		id: 'assigned-secret',
		description: 'hardcoded secret-like assignment',
		pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*["'][^"'\s${}<]{8,}["']/gi,
	},
	{
		id: 'windows-user-path',
		description: 'absolute Windows user profile path',
		pattern: /\b[A-Za-z]:[\\/]+Users[\\/]+(?!<|%|\$\{)[^\\/\s"'`<>]+[\\/]+/gi,
	},
	{
		id: 'workspace-path',
		description: 'local absolute workspace path',
		pattern: /\b[A-Za-z]:[\\/]+(?:Sandbox|Projects?|Workspace|Vaults?)[\\/]+[^\s"'`<>]+/gi,
	},
	{
		id: 'posix-home-path',
		description: 'absolute POSIX user home path',
		pattern: /\/(?:Users|home)\/(?!<|\$\{)[^/\s"'`<>]+\//g,
	},
	{
		id: 'private-ipv4',
		description: 'private LAN IPv4 address',
		pattern: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g,
	},
];

const files = artifactsOnly ? new Set(listedFiles('release-audit')) : stagedOnly ? stagedFiles() : repositoryFiles();
if (!artifactsOnly) {
	for (const deleted of deletedFiles()) files.delete(deleted);
}
if (includeRelease) {
	for (const path of ['main.js', 'styles.css', ...listedFiles('release/command-center')]) files.add(path);
}

for (const path of [...files].sort()) {
	if (!shouldScan(path)) continue;
	let content;
	try {
		content = stagedOnly ? stagedContent(path) : readFileSync(resolve(root, path));
	} catch (error) {
		findings.push({ path, line: 0, id: 'unreadable', excerpt: error instanceof Error ? error.message : String(error) });
		continue;
	}
	if (content.length > maxBytes) {
		findings.push({ path, line: 0, id: 'oversize', excerpt: `${content.length} bytes exceeds ${maxBytes}` });
		continue;
	}
	if (content.includes(0)) {
		findings.push({ path, line: 0, id: 'nul-byte', excerpt: 'NUL byte found in a text source or release asset' });
		continue;
	}
	scanText(path, content.toString('utf8'));
}

if (findings.length) {
	console.error(`Repository sanitization failed with ${findings.length} finding(s):`);
	for (const finding of findings) console.error(`  ${finding.path}:${finding.line} [${finding.id}] ${finding.excerpt}`);
	console.error('Remove the data or add a narrowly scoped SANITIZE_ALLOW comment for an intentional synthetic fixture.');
	process.exit(1);
}

console.log(`Repository sanitization passed: ${files.size} candidate file(s), no PII, local paths, private IPs, or secrets detected.`);

function scanText(path, text) {
	const lines = text.split(/\r?\n/u);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (line.includes(allowMarker)) continue;
		for (const check of checks) {
			check.pattern.lastIndex = 0;
			const match = check.pattern.exec(line);
			if (match) findings.push({
				path,
				line: index + 1,
				id: check.id,
				excerpt: `${check.description}: ${redact(match[0])}`,
			});
		}
	}
}

function repositoryFiles() {
	return new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).map(normalize));
}

function stagedFiles() {
	return new Set(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean).map(normalize));
}

function deletedFiles() {
	return new Set(git(['diff', '--name-only', '--diff-filter=D', '-z', 'HEAD']).split('\0').filter(Boolean).map(normalize));
}

function stagedContent(path) {
	return execFileSync('git', ['show', `:${path}`], { cwd: root, encoding: 'buffer', maxBuffer: maxBytes + 1 });
}

function listedFiles(directory) {
	try {
		return gitLikeWalk(resolve(root, directory)).map(path => normalize(relative(root, path)));
	} catch {
		return [];
	}
}

function gitLikeWalk(directory) {
	const result = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) result.push(...gitLikeWalk(path));
		else if (entry.isFile()) result.push(path);
	}
	return result;
}

function shouldScan(path) {
	if (path === selfPath || excludedNames.has(path)) return false;
	if (excludedPrefixes.some(prefix => path.startsWith(prefix)) && !(includeRelease && path.startsWith('release/')) && !(artifactsOnly && path.startsWith('release-audit/'))) return false;
	if (path.startsWith('.command-center/') || path.includes('/.command-center/')) {
		findings.push({ path, line: 0, id: 'runtime-state', excerpt: 'Command Center runtime state must never be tracked or published' });
		return false;
	}
	let size;
	try { size = statSync(resolve(root, path)).size; } catch { size = 0; }
	if (!stagedOnly && size > maxBytes) return true;
	const name = path.split('/').at(-1) ?? '';
	return exactTextNames.has(name) || textExtensions.has(extname(name).toLowerCase());
}

function git(arguments_) {
	return execFileSync('git', arguments_, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

function normalize(path) { return path.split(sep).join('/').replaceAll('\\', '/'); }
function redact(value) { return value.length <= 12 ? '[REDACTED]' : `${value.slice(0, 4)}…${value.slice(-4)}`; }
function fail(message) { console.error(message); process.exit(2); }
