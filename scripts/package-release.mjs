import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'release', 'command-center');
const artifacts = ['main.js', 'manifest.json', 'styles.css'];

// Always rebuild the release directory so stale bundles and development files
// can never leak into a distributable package.
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const artifact of artifacts) {
	await cp(resolve(root, artifact), resolve(output, artifact));
}

const files = (await readdir(output)).sort();
if (files.join('\n') !== artifacts.slice().sort().join('\n')) {
	throw new Error(`Unexpected release contents: ${files.join(', ')}`);
}

let total = 0;
for (const file of files) {
	const bytes = (await stat(resolve(output, file))).size;
	total += bytes;
	console.log(`${file}: ${bytes} bytes`);
}
console.log(`Release package: ${total} bytes (${output})`);
