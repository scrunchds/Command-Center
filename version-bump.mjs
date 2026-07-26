import { readFileSync, writeFileSync } from 'fs';

const targetVersion = process.env.npm_package_version;
if (!targetVersion) throw new Error('npm_package_version is unavailable. Run this script through npm.');
// Obsidian accepts a numeric dotted version string. This project intentionally
// preserves the publication label 1.0.00 rather than normalizing it as SemVer.
if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) throw new Error(`Invalid Obsidian version: ${targetVersion}`);

// read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t'));

// update versions.json with target version and minAppVersion from manifest.json
// but only if the target version is not already in versions.json
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeFileSync('versions.json', JSON.stringify(versions, null, '\t'));
}
