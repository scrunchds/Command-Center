#!/usr/bin/env node
/** Compare benchmark-results.json with the checked-in core metric baselines. */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const resultsPath = join(ROOT, 'benchmark-results.json');
const baselinePath = join(ROOT, 'test', 'benchmark-baselines.json');

const [results, config] = await Promise.all([
  readFile(resultsPath, 'utf8').then(JSON.parse),
  readFile(baselinePath, 'utf8').then(JSON.parse),
]);

if (results.schemaVersion !== 1 || !Array.isArray(results.metrics)) {
  throw new Error(`Unsupported benchmark report schema in ${resultsPath}`);
}

const allowed = Number(config.allowedRegressionPercent ?? 25);
const actualById = new Map(results.metrics.map(metric => [metric.id, metric]));
const failures = [];

console.log(`Performance regression gate (maximum regression: ${allowed}%)`);
console.log('Metric'.padEnd(24), 'Actual'.padStart(14), 'Baseline'.padStart(14), 'Change'.padStart(11), 'Status'.padStart(9));

for (const [id, baseline] of Object.entries(config.metrics)) {
  const actual = actualById.get(id);
  if (!actual) {
    failures.push(`${id}: missing from benchmark results`);
    continue;
  }
  if (actual.unit !== baseline.unit || actual.direction !== baseline.direction) {
    failures.push(`${id}: incompatible unit or direction`);
    continue;
  }

  const change = baseline.direction === 'higher-is-better'
    ? ((baseline.baseline - actual.value) / baseline.baseline) * 100
    : ((actual.value - baseline.baseline) / baseline.baseline) * 100;
  const failed = !Number.isFinite(actual.value) || change > allowed;
  const status = failed ? 'FAIL' : 'PASS';
  console.log(
    id.padEnd(24),
    `${actual.value.toFixed(6)} ${actual.unit}`.padStart(14),
    `${baseline.baseline.toFixed(6)} ${baseline.unit}`.padStart(14),
    `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`.padStart(11),
    status.padStart(9),
  );
  if (failed) failures.push(`${id}: ${change.toFixed(1)}% slower than baseline (limit ${allowed}%)`);
}

if (failures.length > 0) {
  console.error('\nPerformance regression detected:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('\nAll core benchmarks are within baseline thresholds.');
