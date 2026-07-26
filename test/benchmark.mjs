#!/usr/bin/env node
/**
 * Command Center performance benchmarks.
 *
 * Human-readable results are printed to stdout and a machine-readable report is
 * always written to benchmark-results.json at the repository root.
 */

import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');
const OUTPUT = join(ROOT, 'benchmark-results.json');
const SAMPLE_COUNT = 5;
const metrics = [];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function addMetric({ id, name, category, iterations, samples, core = false }) {
  const durationMs = median(samples);
  const value = durationMs / iterations;
  const metric = {
    id,
    name,
    category,
    core,
    unit: 'ms/op',
    direction: 'lower-is-better',
    value,
    iterations,
    durationMs,
    statistic: 'median',
    samplesMs: samples,
    operationsPerSecond: value > 0 ? 1000 / value : null,
  };
  metrics.push(metric);
  console.log(`${name.padEnd(24)} ${value.toFixed(6)} ms/op  (${metric.operationsPerSecond?.toFixed(0) ?? '∞'} ops/s)`);
}

function measureSync(fn, iterations, warmup = Math.min(iterations, 100)) {
  for (let i = 0; i < warmup; i++) fn(i);
  const samples = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    const started = performance.now();
    for (let i = 0; i < iterations; i++) fn(i);
    samples.push(performance.now() - started);
  }
  return samples;
}

async function measureAsync(fn, iterations, warmup = Math.min(iterations, 20)) {
  for (let i = 0; i < warmup; i++) await fn(i);
  const samples = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    const started = performance.now();
    for (let i = 0; i < iterations; i++) await fn(i);
    samples.push(performance.now() - started);
  }
  return samples;
}

async function run() {
  console.log('═══ Command Center Performance Benchmarks ═══\n');

  const [evalMod, rolesMod, recoveryMod, orchMod, traceMod, searchMod] = await Promise.all([
    import(pathToFileURL(join(SRC, 'react/react-eval.ts')).href),
    import(pathToFileURL(join(SRC, 'react/react-roles.ts')).href),
    import(pathToFileURL(join(SRC, 'react/react-recovery.ts')).href),
    import(pathToFileURL(join(SRC, 'react/react-orchestrator.ts')).href),
    import(pathToFileURL(join(SRC, 'react/react-trace.ts')).href),
    import(pathToFileURL(join(SRC, 'obsidian-search.ts')).href),
  ]);

  {
    const evaluator = new evalMod.ReActEvaluator();
    addMetric({ id: 'evaluator', name: 'Evaluator', category: 'react', iterations: 1000,
      samples: measureSync(i => evaluator.evaluate('retriever', 'researcher', `Task ${i}`, {
        output: `Result ${i} with content at path/file.md`, subCycles: 2, toolCalls: 3,
        success: true, keyInsights: ['a'], corrections: 0, validationLog: [],
      }), 1000) });
  }

  {
    const roles = rolesMod.listRoles();
    addMetric({ id: 'role-lookup', name: 'Role lookup', category: 'registry', iterations: 5000,
      samples: measureSync(i => rolesMod.getRole(roles[i % roles.length].name), 5000) });
  }

  {
    const breaker = new recoveryMod.CircuitBreaker(10, 1000);
    addMetric({ id: 'circuit-breaker', name: 'Circuit breaker', category: 'recovery', iterations: 10000,
      samples: measureSync(() => { breaker.recordSuccess('w'); breaker.isOpen('w'); }, 10000) });
  }

  {
    const detector = new recoveryMod.DeadlockDetector();
    detector.record('s1', 'hello world test alpha beta gamma delta epsilon zeta');
    addMetric({ id: 'deadlock-detector', name: 'Deadlock detector', category: 'recovery', iterations: 5000,
      samples: measureSync(() => detector.isDeadlocked('s1', 'hello world test alpha beta gamma delta epsilon zeta'), 5000) });
  }

  {
    const context = { sessionId: 'bench', task: 'Find project notes', cycles: [], meta: {
      startedAt: Date.now(), completedAt: 0, totalCycles: 0, daemonCalls: 0, toolCalls: 0, termination: 'error',
    } };
    addMetric({ id: 'prompt-builder', name: 'Prompt builder', category: 'react', iterations: 1000,
      samples: measureSync(() => orchMod.buildReActOrchestratorPrompt(context, 0), 1000) });
  }

  {
    const manager = new recoveryMod.SafeStateManager();
    addMetric({ id: 'safe-state', name: 'Safe state snapshot', category: 'recovery', iterations: 2000,
      samples: measureSync(i => manager.snapshot(`s${i}`, i % 5, `Context ${i}`), 2000) });
  }

  addMetric({ id: 'retry-overhead', name: 'withRetry overhead', category: 'recovery', iterations: 1000,
    samples: await measureAsync(i => recoveryMod.withRetry(() => Promise.resolve(i), { maxRetries: 0 }, 'bench'), 1000) });

  {
    const collector = new traceMod.ReActTraceCollector();
    let parentId = null;
    addMetric({ id: 'trace-collection', name: 'Trace collection', category: 'trace', core: true, iterations: 20000,
      samples: measureSync(i => {
        const event = collector.emit('bench', parentId, 'orch', 'agent:think:start', i / 10 | 0, i % 10, `Event ${i}`, 'Content');
        if (i % 10 === 0) parentId = event.id;
      }, 20000) });
  }

  {
    const json = JSON.stringify({ thought: { reasoning: 'Search first', assessment: 'acting', confidence: 0.9 },
      actions: [{ worker: 'retriever', prompt: 'Find X', expectedOutput: 'List' }] });
    addMetric({ id: 'json-parsing', name: 'ReAct JSON parsing', category: 'parsing', core: true, iterations: 20000,
      samples: measureSync(() => orchMod.parseReActResponse(json), 20000) });
  }

  // Cold BM25 index + score. A fresh mock App per sample prevents the WeakMap
  // index from turning this into a cache-hit benchmark.
  {
    const documentCount = 500;
    const samples = [];
    for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
      const files = Array.from({ length: documentCount }, (_, i) => ({
        path: `Bench/note-${i}.md`, name: `note-${i}.md`,
        stat: { mtime: 1, size: 450 },
      }));
      const app = {
        vault: { cachedRead: async file => `---\ntags: [bench]\n---\n# Note ${file.name}\nalpha beta project search content ${file.path} `.repeat(6) },
        metadataCache: { getFileCache: () => ({ headings: [], tags: [] }) },
      };
      const query = searchMod.parseQuery('alpha project search');
      const started = performance.now();
      await searchMod.scoreBatch(files, query, app, 20);
      samples.push(performance.now() - started);
    }
    addMetric({ id: 'bm25-cold-index', name: 'BM25 cold indexing', category: 'search', core: true,
      iterations: documentCount, samples });
  }

  const report = {
    schemaVersion: 1,
    suite: 'command-center',
    generatedAt: new Date().toISOString(),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    metrics,
  };
  await writeFile(OUTPUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${OUTPUT}`);
  console.log('═══ Benchmarks Complete ═══');
}

run().catch(error => { console.error('Benchmark failed:', error); process.exit(1); });
