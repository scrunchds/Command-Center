/**
 * install-hooks.mjs — install the pre-push hook into .git/hooks/
 *
 * Run once after cloning:
 *   node scripts/install-hooks.mjs
 *   or manually:
 *   cp scripts/pre-push.hook .git/hooks/pre-push
 *   chmod +x .git/hooks/pre-push
 */

import { copyFileSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(ROOT, 'scripts', 'pre-push.hook');
const dest = resolve(ROOT, '.git', 'hooks', 'pre-push');

try {
	copyFileSync(source, dest);
	chmodSync(dest, 0o755);
	console.log('✅ pre-push hook installed at .git/hooks/pre-push');
} catch (err) {
	console.error('❌ Could not install hook:', err.message);
	console.error('   Try: cp scripts/pre-push.hook .git/hooks/pre-push');
	console.error('   Then: chmod +x .git/hooks/pre-push');
	process.exit(1);
}