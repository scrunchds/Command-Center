#!/usr/bin/env node

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// Obsidian provides window in the renderer; mirror it for headless Node tests.
global.window = global;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = ROOT + "/src";
const results = { pass: 0, fail: 0, skip: 0 };
const perfMark = process.argv.includes("--benchmark");

function pass(n){results.pass++;console.log("  ✅ "+n)}
function fail(n,e){results.fail++;console.log("  ❌ "+n+": "+e.message)}
function skip(n){results.skip++;console.log("  ⏭  "+n)}
function bench(l,f){const s=performance.now();const r=f();if(perfMark)console.log("    ⏱  "+l+": "+(performance.now()-s).toFixed(2)+"ms");return r}

/* ═══ 7. Evaluator Accuracy & Scoring ═══ */
async function verifyEvaluator() {
console.log('\n─── 7. Evaluator Accuracy & Scoring ───');
const { ReActEvaluator } = await import(pathToFileURL(SRC + '/react/react-eval.ts').href);
{
const e = new ReActEvaluator();
const sc = e.evaluate('retriever', 'researcher', 'Find notes',
  { output: 'Found note at path/file.md with 42 items.\n- A\n- B', subCycles: 2, toolCalls: 3, success: true, keyInsights: ['x'], corrections: 0, validationLog: [] });
assert.ok(sc.compositeScore > 0 && sc.compositeScore <= 1);
assert.ok(sc.dimensions.completeness >= 0); assert.ok(sc.dimensions.relevance >= 0);
assert.ok(sc.dimensions.specificity >= 0); assert.ok(sc.dimensions.correctness >= 0);
pass('7a: all 4 dimension scores');
}
{
const e = new ReActEvaluator();
const vague = e.evaluate('r', 'x', 'Find', { output: 'I found some notes.', subCycles: 1, toolCalls: 1, success: true, keyInsights: [], corrections: 0, validationLog: [] });
const spec = e.evaluate('r', 'x', 'Find', { output: 'Found 3 notes at proj/alpha.md (142 lines), proj/beta.md (89 lines).\n- alpha: architecture\n- beta: deployment', subCycles: 2, toolCalls: 4, success: true, keyInsights: [], corrections: 0, validationLog: [] });
assert.ok(spec.dimensions.specificity > vague.dimensions.specificity);
pass('7b: specificity higher for detailed outputs');
}
{
const e = new ReActEvaluator();
const c = e.evaluate('r', undefined, 'X', { output: 'Successfully found at docs/readme.md.', subCycles: 1, toolCalls: 1, success: true, keyInsights: [], corrections: 0, validationLog: [] });
const er = e.evaluate('r', undefined, 'X', { output: 'Error: unable to find. Failed to search. Cannot access. No results.', subCycles: 1, toolCalls: 1, success: false, keyInsights: [], corrections: 0, validationLog: [] });
assert.ok(c.dimensions.correctness > er.dimensions.correctness);
pass('7c: correctness penalized for error indicators');
}
{
const e = new ReActEvaluator();
const sf = e.evaluate('r', undefined, 'X', { output: 'Error: failed Error: crashed Error: unable Error: not found Error: no results Error: denied Error: timeout', subCycles: 0, toolCalls: 0, success: false, keyInsights: [], corrections: 0, validationLog: [] });
assert.equal(sf.grade, 'failed');
pass('7d: error-heavy output -> failed grade');
}
{
const e = new ReActEvaluator();
for (let i = 0; i < 10; i++) e.evaluate('retriever', 'researcher', 'T' + i, { output: 'R' + i, subCycles: 1, toolCalls: i, success: true, keyInsights: [], corrections: 0, validationLog: [] });
const h = e.getHistory();
assert.equal(h.totalEvaluations, 10);
assert.ok(h.agentStats['retriever'] && h.roleStats['researcher']);
assert.ok(e.getOptimizationHints().length > 0);
pass('7e: history + optimization hints');
}
{
const e = new ReActEvaluator();
e.evaluate('editor', 'writer', 'W', { output: 'text', subCycles: 1, toolCalls: 0, success: true, keyInsights: [], corrections: 0, validationLog: [] });
const saved = e.toJSON(); const e2 = new ReActEvaluator(); e2.loadHistory(saved);
assert.equal(e2.getHistory().totalEvaluations, 1); e2.reset();
assert.equal(e2.getHistory().totalEvaluations, 0);
pass('7f: history load/reset');
}
{
const e = new ReActEvaluator();
bench('eval-saturate', () => { for (let i = 0; i < 60; i++) e.evaluate('r', undefined, 'X', { output: 'x', subCycles: 1, toolCalls: 0, success: true, keyInsights: [], corrections: 0, validationLog: [] }) });
assert.ok(e.getHistory().recentScorecards.length <= 50);
pass('7g: scorecards capped at 50');
}
}

/* ═══ 8. Role Registry ═══ */
async function verifyRoles() {
console.log('\n─── 8. Role Registry ───');
const m = await import(pathToFileURL(SRC + '/react/react-roles.ts').href);
{
const r = m.listRoles();
assert.ok(r.length >= 6);
['researcher', 'analyst', 'writer', 'reviewer', 'planner', 'fact-checker'].forEach(n => assert.ok(r.some(x => x.name === n)));
pass('8a: all 6 static roles');
}
{
const r = m.getRole('researcher'); assert.ok(r && r.baseProfile === 'retriever');
assert.equal(m.getRole('nonexistent'), undefined);
pass('8b: getRole lookup');
}
{
assert.ok(m.findRolesByCapability('search').some(r => r.name === 'researcher'));
assert.ok(m.findRolesByCapability('verify').some(r => r.name === 'fact-checker'));
pass('8c: findRolesByCapability');
}
{
const c = m.buildRoleCatalog();
assert.ok(c.includes('Researcher') && c.includes('Fact Checker'));
pass('8d: buildRoleCatalog');
}
{
const t = [
  { name: 'search_vault', label: 'S', description: '', parameters: { type: 'object' }, execute: async () => ({ content: [], details: {} }) },
  { name: 'read_note', label: 'R', description: '', parameters: { type: 'object' }, execute: async () => ({ content: [], details: {} }) },
  { name: 'write_note', label: 'W', description: '', parameters: { type: 'object' }, execute: async () => ({ content: [], details: {} }) }
];
const f = m.filterToolsForRole('researcher', t);
assert.ok(f.length < t.length && f.every(t => ['search_vault', 'read_note', 'list_files', 'get_active_note'].includes(t.name)));
assert.equal(m.filterToolsForRole(undefined, t).length, 3);
pass('8e: filterToolsForRole');
}
{
const p = m.buildRolePrompt({ worker: 'retriever', role: 'researcher', prompt: 'Find docs', expectedOutput: 'List' });
assert.ok(p.includes('researcher agent') && p.includes('Find docs'));
pass('8f: buildRolePrompt');
}
{
const nr = { name: 'code-arch', label: 'CA', baseProfile: 'retriever', persona: 'Dig through sources and validate architecture claims.', systemPrompt: 'Find.', capabilities: ['search', 'verify'], recommendedTools: ['search_vault', 'write_note', 'unknown_tool'], expertise: ['legacy'] };
assert.ok(m.registerDynamicRole(nr)); assert.equal(m.registerDynamicRole(nr), false);
const dynamic = m.getRole('code-arch'); assert.ok(dynamic?.dynamic);
assert.deepEqual(dynamic.toolPermissions.allowed, ['search_vault']);
assert.ok(dynamic.toolPermissions.denied.includes('write_note'));
assert.ok(dynamic.validationRules.some(rule => rule.includes('vault paths')));
assert.ok(m.buildRolePrompt({ worker: 'retriever', role: 'code-arch', prompt: 'Find', expectedOutput: 'Evidence' }).includes('Runtime Tool Permissions'));
assert.ok(m.unregisterDynamicRole('code-arch'));
assert.equal(m.getRole('code-arch'), undefined);
assert.equal(m.unregisterDynamicRole('researcher'), false);
pass('8g: dynamic role lifecycle');
}
{
const a = { worker: 'retriever', prompt: 'Find', expectedOutput: 'List', customRole: { name: 'miner', persona: 'Mine.', capabilities: ['mining'], recommendedTools: ['search_vault'] } };
const n = m.tryRegisterDynamicRole(a); assert.equal(n, 'miner'); assert.ok(m.getRole('miner')); m.unregisterDynamicRole('miner');
pass('8h: tryRegisterDynamicRole');
}
}

/* ═══ 9. Recovery Infrastructure ═══ */
async function verifyRecovery() {
console.log('\n─── 9. Recovery Infrastructure ───');
const m = await import(pathToFileURL(SRC + '/react/react-recovery.ts').href);
{
const cb = new m.CircuitBreaker(3, 500); cb.recordFailure('w'); cb.recordFailure('w');
assert.equal(cb.isOpen('w'), false); cb.recordFailure('w');
assert.equal(cb.isOpen('w'), true); cb.recordSuccess('w');
assert.equal(cb.isOpen('w'), false);
pass('9a: circuit breaker open/reset');
}
{
const cb = new m.CircuitBreaker(1, 40); cb.recordFailure('w');
assert.equal(cb.isOpen('w'), true); await new Promise(r => setTimeout(r, 50));
assert.equal(cb.isOpen('w'), false);
pass('9b: circuit breaker auto-reset');
}
{
const dd = new m.DeadlockDetector(); dd.record('s1', 'the project uses a microservices architecture with redis caching and postgresql database for primary storage');
assert.equal(dd.isDeadlocked('s1', 'the project uses a microservices architecture with redis caching and postgresql database for persistent storage'), true);
assert.equal(dd.isDeadlocked('s1', 'completely unrelated topic about different subject matter entirely'), false);
assert.equal(dd.isDeadlocked('s2', 'the project uses a microservices architecture with redis caching'), false);
pass('9c: deadlock detection + session isolation');
}
{
const sm = new m.SafeStateManager(); sm.snapshot('s1', 0, 'initial'); sm.snapshot('s1', 1, 'after edit');
assert.equal(sm.getLatest('s1').context, 'after edit');
assert.equal(sm.rollback('s1').context, 'initial'); sm.clear('s1');
assert.equal(sm.getLatest('s1'), undefined);
pass('9d: safe state snapshots/rollback');
}
{
assert.equal(await m.withTimeout(() => Promise.resolve('OK'), 100, 'test'), 'OK');
pass('9e: withTimeout resolves');
try { await m.withTimeout(() => new Promise(r => setTimeout(r, 50)), 10, 'slow'); assert.fail('timeout'); }
catch (e) { assert.ok(e instanceof m.TimedOutError); pass('9e.1: withTimeout rejects TimedOutError'); }
}
{
let c = 0; const r = await m.withRetry(() => { c++; return Promise.resolve(c); }, { maxRetries: 2 }, 'test');
assert.equal(r, 1); pass('9f: withRetry succeeds');
let fc = 0;
try { await m.withRetry(() => { fc++; return Promise.reject(new Error('fail')); }, { maxRetries: 1, baseDelayMs: 10 }, 'f'); }
catch (e) { assert.equal(fc, 2); pass('9f.1: withRetry exhausts retries'); }
}
{
const r = await m.withFallback(() => Promise.resolve('primary'), () => Promise.resolve('fallback'));
assert.equal(r, 'primary');
const r2 = await m.withFallback(() => Promise.reject(new Error('x')), () => Promise.resolve('fallback'));
assert.equal(r2, 'fallback');
pass('9g: withFallback primary + fallback');
}
{
assert.ok(m.getToolTimeout('search_vault') > 0); assert.ok(m.getToolTimeout('unknown') > 0);
assert.ok(m.getAlternativeTools('search_vault').length > 0);
assert.equal(m.getAlternativeTools('unknown').length, 0);
pass('9h: tool timeout/alternatives');
}
{
assert.equal(m.determineRecovery(new Error('timeout'), 0, 2, 'r').strategy, 'retry');
assert.equal(m.determineRecovery(new Error('timeout'), 2, 2, 'r').strategy, 'retry-simpler');
assert.equal(m.determineRecovery(new Error('parse error: malformed'), 0, 2, 'r').strategy, 'retry');
assert.equal(m.determineRecovery(new Error('exited'), 0, 1, 'r').strategy, 'abort');
assert.equal(m.determineRecovery(new Error('generic'), 2, 2, 'retriever').strategy, 'switch-worker');
pass('9i: determineRecovery strategies');
}
}

/* ═══ 10. Prompt Builders & Parsers ═══ */
async function verifyPrompts() {
console.log('\n─── 10. Prompt Builders & Parsers ───');
const o = await import(pathToFileURL(SRC + '/react/react-orchestrator.ts').href);
{
const r = o.parseReActResponse(JSON.stringify({ thought: { reasoning: 'Need search', assessment: 'planning', confidence: 0.9 }, actions: [{ worker: 'retriever', prompt: 'Find X', expectedOutput: 'List' }] }));
assert.equal(r.thought.assessment, 'planning'); assert.equal(r.thought.confidence, 0.9);
pass('10a: parseReActResponse valid JSON');
}
{
const r = o.parseReActResponse('not json');
assert.ok(r.thought.reasoning.includes('not json')); assert.ok(r.finalAnswer);
pass('10b: parseReActResponse malformed fallback');
}
{
const r = o.parseReActResponse(JSON.stringify({ thought: { reasoning: 'Done', assessment: 'complete', confidence: 0.95 }, finalAnswer: 'The answer is 42.' }));
assert.equal(r.thought.assessment, 'complete'); assert.equal(r.finalAnswer, 'The answer is 42.');
pass('10c: parseReActResponse complete state');
}
{
const r = o.parseReActResponse(JSON.stringify({ thought: { reasoning: 'X', assessment: 'complete', confidence: 5.0 }, finalAnswer: 'X' }));
assert.equal(r.thought.confidence, 1);
const r2 = o.parseReActResponse(JSON.stringify({ thought: { reasoning: 'X', assessment: 'complete', confidence: -0.5 }, finalAnswer: 'X' }));
assert.equal(r2.thought.confidence, 0);
pass('10c.1: confidence clamped to [0,1]');
}
{
const ctx = { sessionId: 't1', task: 'Find all project notes', targetPath: 'proj/', cycles: [], meta: { startedAt: Date.now(), completedAt: 0, totalCycles: 0, daemonCalls: 0, toolCalls: 0, termination: 'error' } };
const p = o.buildReActOrchestratorPrompt(ctx, 0);
assert.ok(p.includes('Find all project notes') && p.includes('ReAct (Reasoning + Acting)'));
pass('10d: buildReActOrchestratorPrompt empty history');
}
{
const ctx = { sessionId: 't2', task: 'Analyze', cycles: [{ index: 0, thought: { reasoning: 'Search first', assessment: 'acting', confidence: 0.7, finalAnswer: undefined }, action: { worker: 'retriever', prompt: 'Find', expectedOutput: 'List', targetPath: undefined }, observation: { output: 'Found 5 notes', success: true, keyInsights: ['5 found'], surprised: false }, startedAt: Date.now() - 1000, completedAt: Date.now() }], meta: { startedAt: Date.now() - 2000, completedAt: 0, totalCycles: 1, daemonCalls: 1, toolCalls: 0, termination: 'error' } };
const p = o.buildReActOrchestratorPrompt(ctx, 1);
assert.ok(p.includes('Working Memory'));
pass('10e: buildReActOrchestratorPrompt with history');
}
{
const ctx = { sessionId: 't3', task: 'Summarize this', cycles: [{ index: 0, thought: { reasoning: 'Done', assessment: 'complete', confidence: 0.9, finalAnswer: 'The result' }, action: { worker: 'summarizer', prompt: 'Summarize', expectedOutput: 'Summary', targetPath: undefined }, observation: { output: 'The result is clear.', success: true, keyInsights: ['clear'], surprised: false }, startedAt: Date.now() - 1000, completedAt: Date.now() }], meta: { startedAt: Date.now() - 2000, completedAt: 0, totalCycles: 1, daemonCalls: 1, toolCalls: 0, termination: 'error' } };
const p = o.buildReActFinalSynthesisPrompt(ctx);
assert.ok(p.includes('Summarize this') && p.includes('The result'));
pass('10f: buildReActFinalSynthesisPrompt');
}
{
const p = o.buildWorkerReActPrompt('retriever', 'Find project docs', 'projects/', undefined);
assert.ok(p.includes('retriever agent') && p.includes('Find project docs') && p.includes('projects/'));
pass('10g: buildWorkerReActPrompt retriever');
}
{
const wp = o.buildWorkerReActPrompt('summarizer', 'Analyze text', 'doc.md', 'Previous context here');
assert.ok(wp.includes('summarizer agent') && wp.includes('Previous context'));
pass('10h: buildWorkerReActPrompt summarizer with context');
}
{
const wp = o.buildWorkerReActPrompt('unknown_worker', 'Do something', undefined, undefined);
assert.ok(wp.length > 0);
pass('10i: buildWorkerReActPrompt unknown profile fallback');
}
}

/* ═══ 11. Trace Collector & Tree Building ═══ */
async function verifyTraces() {
console.log('\n─── 11. Trace Collector & Tree Building ───');
const { ReActStepController, ReActTraceCollector } = await import(pathToFileURL(SRC + '/react/react-trace.ts').href);
{
const tc = new ReActTraceCollector();
const events = [];
tc.setCallback(evt => events.push(evt));
const s = tc.emit('s1', null, 'orchestrator', 'session:start', -1, -1, 'ReAct Session', 'Find files');
assert.ok(s.id.startsWith('trace-') && s.type === 'session:start');
assert.equal(events.length, 1);
pass('11a: trace collector emits events with callback');
}
{
const tc = new ReActTraceCollector();
const sess = tc.emit('s1', null, 'orch', 'session:start', -1, -1, 'S', '');
const cyc = tc.emit('s1', sess.id, 'orch', 'cycle:start', 0, -1, 'C0', '');
tc.emit('s1', cyc.id, 'orch', 'agent:think:start', 0, -1, 'Think', '');
tc.emit('s1', cyc.id, 'retriever', 'agent:act:start', 0, -1, 'Act', '');
tc.emit('s1', cyc.id, 'retriever', 'agent:observe', 0, -1, 'Obs', 'Found data');
tc.emit('s1', cyc.id, 'orch', 'agent:think:end', 0, -1, 'Done', '');
tc.emit('s1', cyc.id, 'orch', 'cycle:end', 0, -1, 'End', '');
tc.emit('s1', sess.id, 'orch', 'session:end', -1, -1, 'End', '');
assert.equal(tc.getEvents().length, 8);
assert.equal(tc.getSessionEvents('s1').length, 8);
assert.equal(tc.getSessionEvents('s2').length, 0);
pass('11b: trace collector accumulates events per session');
}
{
const tc = new ReActTraceCollector();
const s = tc.emit('s1', null, 'orch', 'session:start', -1, -1, 'S', '');
const c = tc.emit('s1', s.id, 'orch', 'cycle:start', 0, -1, 'C', '');
tc.emit('s1', c.id, 'retriever', 'agent:act:start', 0, -1, 'A', '');
const tree = tc.buildTree('s1');
assert.equal(tree.length, 1);
assert.equal(tree[0].event.id, s.id);
assert.equal(tree[0].children.length, 1);
assert.equal(tree[0].children[0].event.id, c.id);
assert.equal(tree[0].children[0].children.length, 1);
assert.equal(tree[0].children[0].depth, 1);
assert.equal(tree[0].children[0].children[0].depth, 2);
pass('11c: trace tree built with correct parent-child relationships');
}
{
const tc = new ReActTraceCollector();
tc.emit('s1', null, 'orch', 'session:start', -1, -1, 'S', '');
tc.emit('s2', null, 'orch', 'session:start', -1, -1, 'S2', '');
assert.equal(tc.getEvents().length, 2);
assert.equal(tc.getSessionEvents('s1').length, 1);
assert.equal(tc.getSessionEvents('s2').length, 1);
tc.clear();
assert.equal(tc.getEvents().length, 0);
pass('11d: trace collector clears all events');
}
{
const tc = new ReActTraceCollector();
bench('trace-emit-1000', () => {
  for (let i = 0; i < 1000; i++) tc.emit('s-bench', null, 'orch', 'session:start', -1, -1, 'E' + i, '');
});
assert.equal(tc.getEvents().length, 1000);
pass('11e: trace collector handles 1000 events');
}
{
const gate = new ReActStepController();
gate.setEnabled(true);
let settled = false;
const first = gate.wait('debug-session').then(value => { settled = true; return value; });
await Promise.resolve();
assert.equal(settled, false); assert.equal(gate.isPaused(), true); assert.equal(gate.getPausedSessionId(), 'debug-session');
assert.equal(gate.nextStep(), true); assert.equal(await first, 'next');
assert.equal(gate.isEnabled(), true); assert.equal(gate.isPaused(), false);
const second = gate.wait('debug-session');
assert.equal(gate.resume(), true); assert.equal(await second, 'resume');
assert.equal(gate.isEnabled(), false); assert.equal(gate.isPaused(), false);
assert.equal(await gate.wait('normal-session'), 'resume');
pass('11f: debug step gate advances one cycle or resumes without timeout/retry wrappers');
}
}

/* ═══ 12. Simulated Agent Scenarios ═══ */
async function verifySimulatedAgents() {
console.log('\n─── 12. Simulated Agent Scenarios ───');

// 12a: Simulate a mini ReAct loop — orchestrator reasons, dispatches retriever
const { ReActEvaluator } = await import(pathToFileURL(SRC + '/react/react-eval.ts').href);
const { parseReActResponse, buildReActOrchestratorPrompt } = await import(pathToFileURL(SRC + '/react/react-orchestrator.ts').href);
const { DeadlockDetector, CircuitBreaker, SafeStateManager } = await import(pathToFileURL(SRC + '/react/react-recovery.ts').href);
{
// Simulated orchestrator output
const orchestratorOutput = JSON.stringify({
  thought: { reasoning: 'I need to search for project documentation first. The user wants to understand the architecture.', assessment: 'acting', confidence: 0.8 },
  actions: [{ worker: 'retriever', prompt: 'Search for architecture and project documentation across the vault', expectedOutput: 'List of relevant files with paths and summaries' }]
});
const parsed = parseReActResponse(orchestratorOutput);
assert.equal(parsed.thought.assessment, 'acting');
assert.ok(parsed.actions || parsed.finalAnswer);
pass('12a: orchestrator parsing — acting assessment');
}

// 12b: Simulate complete → finalAnswer
{
const completeOutput = JSON.stringify({
  thought: { reasoning: 'I have gathered all the information needed to answer the question about project architecture.', assessment: 'complete', confidence: 0.92 },
  finalAnswer: 'The project uses a microservices architecture with Redis caching and PostgreSQL for persistence. Key files: architecture.md, config/db.md, api-design.md.'
});
const parsed = parseReActResponse(completeOutput);
assert.equal(parsed.thought.assessment, 'complete');
assert.equal(parsed.finalAnswer.length > 0, true);
pass('12b: orchestrator parsing — complete with finalAnswer');
}

// 12c: Orchestrator prompt evolves across cycles
{
const ctx1 = { sessionId: 's', task: 'Analyze the project', cycles: [], meta: { startedAt: Date.now(), completedAt: 0, totalCycles: 0, daemonCalls: 0, toolCalls: 0, termination: 'error' } };
const p1 = buildReActOrchestratorPrompt(ctx1, 0);
assert.ok(p1.includes('(No previous cycles'));
pass('12c.1: cycle 0 prompt has no history');

const ctx2 = {
  sessionId: 's', task: 'Analyze the project',
  cycles: [{ index: 0, thought: { reasoning: 'Search for architecture docs', assessment: 'acting', confidence: 0.8, finalAnswer: undefined }, action: { worker: 'retriever', prompt: 'Find architecture docs', expectedOutput: 'List of architecture files' }, observation: { output: 'Found architecture.md (142 lines), design/overview.md (89 lines)', success: true, keyInsights: ['Found 2 architecture files'], surprised: false }, startedAt: Date.now() - 2000, completedAt: Date.now() - 1000 }],
  meta: { startedAt: Date.now() - 3000, completedAt: 0, totalCycles: 1, daemonCalls: 2, toolCalls: 0, termination: 'error' }
};
const p2 = buildReActOrchestratorPrompt(ctx2, 1);
assert.ok(p2.includes('Working Memory'));
assert.ok(p2.includes('Cycle 1') || p2.includes('architecture.md'));
pass('12c.2: cycle 1 prompt includes previous observations');
}

// 12d: Evaluator scores a complete simulated agent run
{
const e = new ReActEvaluator();
const result = {
  output: 'The project uses microservices with 3 services: api-gateway, user-service, and payment-service. Files: services/api-gateway.md (234 lines), services/user-service.md (156 lines), services/payment-service.md (198 lines). Architecture decision: Redis for caching (config/redis.md), PostgreSQL for primary storage (config/db.md).',
  subCycles: 2, toolCalls: 4, success: true,
  keyInsights: ['microservices', '3 services', 'Redis + PostgreSQL'],
  corrections: 0, validationLog: []
};
const sc = e.evaluate('retriever', 'researcher', 'Analyze project architecture', result);
assert.ok(sc.compositeScore >= 0.5);
assert.ok(sc.dimensions.specificity > 0.5);
assert.ok(sc.dimensions.correctness > 0.8);
pass('12d: evaluator scores high-quality agent output appropriately');
}

// 12e: Deadlock detection in simulated agent loop
{
const dd = new DeadlockDetector();
// Simulated agent produces near-identical output 3 times
dd.record('agent1', 'I searched for architecture notes and found architecture.md which describes the microservices pattern used in the project with Redis and PostgreSQL.');
assert.equal(dd.isDeadlocked('agent1', 'I searched for architecture notes and found architecture.md which describes the microservices pattern used in the project with Redis and Postgres.'), true);
assert.equal(dd.isDeadlocked('agent1', 'Let me try a completely different approach — searching for deployment configurations instead.'), false);
pass('12e: deadlock detector catches repeated agent output');
}

// 12f: Safe state snapshot before destructive operation
{
const sm = new SafeStateManager();
sm.snapshot('edit-session', 0, 'Original content: # Project Notes\\n\\nArchitecture is TBD.');
sm.snapshot('edit-session', 1, 'Draft edit: # Project Notes\\n\\nArchitecture: Microservices with Redis.');
const rollback = sm.rollback('edit-session');
assert.equal(rollback.context, 'Original content: # Project Notes\\n\\nArchitecture is TBD.');
pass('12f: safe state rollback recovers pre-edit context');
}
}

/* ═══ 13. Mock Tool Environments ═══ */
async function verifyMockTools() {
console.log('\n─── 13. Mock Tool Environments ───');
const { withTimeout, getToolTimeout, getAlternativeTools, TimedOutError } = await import(pathToFileURL(SRC + '/react/react-recovery.ts').href);
const { filterToolsForRole } = await import(pathToFileURL(SRC + '/react/react-roles.ts').href);

// Mock tool definitions
function makeTool(name, execute) {
  return { name, label: name, description: 'Mock ' + name, parameters: { type: 'object' }, execute };
}

// 13a: Tool timeout wrapping works
{
const slowTool = makeTool('slow_tool', async (id, params) => {
  await new Promise(r => setTimeout(r, 200));
  return { content: [{ type: 'text', text: 'slow result' }], details: { slow: true } };
});
try {
  await withTimeout(() => slowTool.execute('t1', {}), 10, 'tool:slow_tool');
  assert.fail('Should have timed out');
} catch (e) {
  assert.ok(e instanceof TimedOutError);
  pass('13a: tool execution times out with TimedOutError');
}
}

// 13b: Tool timeout registry provides per-tool values
{
assert.equal(getToolTimeout('search_vault'), 10000);
assert.equal(getToolTimeout('read_note'), 8000);
assert.equal(getToolTimeout('write_note'), 15000);
assert.equal(getToolTimeout('list_files'), 5000);
assert.equal(getToolTimeout('get_active_note'), 3000);
assert.ok(getToolTimeout('unknown_tool') > 0, 'unknown tool gets default timeout');
pass('13b: tool timeout registry has per-tool values');
}

// 13c: Alternative tools for fallback
{
const alt = getAlternativeTools('search_vault');
assert.ok(alt.length > 0);
assert.ok(alt.includes('list_files'));
assert.ok(alt.includes('get_active_note'));

const empty = getAlternativeTools('nonexistent_tool');
assert.ok(Array.isArray(empty) && empty.length === 0);
pass('13c: alternative tools lookup works');
}

// 13d: Role-based tool filtering
{
const allTools = [
  makeTool('search_vault', async () => ({ content: [{ type: 'text', text: 'results' }], details: {} })),
  makeTool('read_note', async () => ({ content: [{ type: 'text', text: 'content' }], details: {} })),
  makeTool('write_note', async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} })),
  makeTool('list_files', async () => ({ content: [{ type: 'text', text: 'files' }], details: {} })),
  makeTool('get_active_note', async () => ({ content: [{ type: 'text', text: 'active' }], details: {} })),
];

// Researcher should NOT get write_note
const researcherTools = filterToolsForRole('researcher', allTools);
assert.ok(researcherTools.every(t => t.name !== 'write_note'));

// Writer SHOULD get write_note
const writerTools = filterToolsForRole('writer', allTools);
assert.ok(writerTools.some(t => t.name === 'write_note'));

// Fact-checker should NOT get write_note
const fcTools = filterToolsForRole('fact-checker', allTools);
assert.ok(fcTools.every(t => t.name !== 'write_note'));
pass('13d: role-based tool filtering respects role boundaries');
}

// 13e: Mock tool execution with different patterns
{
const searchTool = makeTool('search_vault', async (id, params) => {
  const q = params.query || '';
  if (q.includes('error')) throw new Error('Search index corrupted');
  return { content: [{ type: 'text', text: 'Found 3 results for: ' + q }], details: { count: 3, query: q } };
});
const r1 = await searchTool.execute('t1', { query: 'architecture' });
assert.ok(r1.content[0].text.includes('architecture'));
try {
  await searchTool.execute('t2', { query: 'error trigger' });
  assert.fail('Should throw');
} catch (e) {
  assert.ok(e.message.includes('corrupted'));
  pass('13e: mock tool execution with error and success patterns');
}
}

// 13f: Tool result structure is valid
{
const readTool = makeTool('read_note', async (id, params) => {
  return {
    content: [{ type: 'text', text: '# Mock Note\\n\\nContent here.' }],
    details: { path: params.path || 'unknown.md', size: 42 }
  };
});
const result = await readTool.execute('t1', { path: 'projects/alpha.md' });
assert.equal(result.content.length, 1);
assert.equal(result.content[0].type, 'text');
assert.ok(result.content[0].text.includes('Mock Note'));
assert.equal(result.details.path, 'projects/alpha.md');
pass('13f: tool result structure is valid');
}
}

/* ═══ 14. Stress Tests ═══ */
async function verifyStress() {
console.log('\n─── 14. Stress Tests ───');
const { ReActEvaluator } = await import(pathToFileURL(SRC + '/react/react-eval.ts').href);
const { ReActTraceCollector } = await import(pathToFileURL(SRC + '/react/react-trace.ts').href);
const { CircuitBreaker, DeadlockDetector, SafeStateManager, withRetry } = await import(pathToFileURL(SRC + '/react/react-recovery.ts').href);

// 14a: Rapid circuit breaker failure + reset
{
const cb = new CircuitBreaker(5, 200);
bench('cb-stress', () => {
  for (let i = 0; i < 100; i++) {
    cb.recordFailure('worker-' + (i % 10));
  }
});
// All 10 workers should have open circuits after 5+ failures each
let openCount = 0;
for (let i = 0; i < 10; i++) {
  if (cb.isOpen('worker-' + i)) openCount++;
}
assert.equal(openCount, 10, 'All 10 workers should have open circuits');
pass('14a: rapid circuit breaker failures open all circuits');

// Reset
for (let i = 0; i < 10; i++) cb.recordSuccess('worker-' + i);
for (let i = 0; i < 10; i++) assert.equal(cb.isOpen('worker-' + i), false);
pass('14a.1: all circuits reset after success');
}

// 14b: Deadlock detector with high volume and varied similarity
{
const dd = new DeadlockDetector();
const base = 'the overall system architecture implements a comprehensive microservices pattern with centralized logging monitoring and distributed tracing across multiple service boundaries';
const similar = 'the overall system architecture implements a comprehensive microservices pattern with centralized logging monitoring and distributed tracing across multiple service containers';
const different = 'a completely unrelated topic regarding frontend user interface design with react components and css styling approaches';

// Record once
dd.record('stress-session', base);
// Should detect similar as deadlocked
assert.equal(dd.isDeadlocked('stress-session', similar), true, 'Similar text should be caught');
// Should NOT detect different as deadlocked
assert.equal(dd.isDeadlocked('stress-session', different), false, 'Different text should pass');

// Fill history with varied inputs
for (let i = 0; i < 20; i++) {
  dd.record('stress-session', 'Unique context ' + i + ' with specific details about the vault contents and architecture decisions.');
}
// Max history is 5, should still work
assert.equal(dd.isDeadlocked('stress-session', 'Unique context 19 with specific details about the vault contents and architecture decisions.'), true);
pass('14b: deadlock detector handles high volume with max-5 sliding window');
}

// 14c: SafeStateManager with many snapshots
{
const sm = new SafeStateManager();
bench('ss-stress', () => {
  for (let i = 0; i < 50; i++) {
    sm.snapshot('heavy-session', i, 'Context for iteration ' + i + ': ' + 'x'.repeat(200));
  }
});
// Should only keep last 10
const latest = sm.getLatest('heavy-session');
assert.ok(latest, 'Latest snapshot exists');
// Rollback 10 times to empty
for (let i = 0; i < 10; i++) sm.rollback('heavy-session');
assert.equal(sm.getLatest('heavy-session'), undefined);
pass('14c: safe state manager caps at 10 snapshots');
}

// 14d: Evaluator with rapid-fire bad outputs (no crashes)
{
const e = new ReActEvaluator();
bench('eval-stress', () => {
  for (let i = 0; i < 200; i++) {
    // Mix of valid, error, and edge-case outputs
    const outputs = [
      { output: 'Error: Failed to find notes. Unable to search.', subCycles: 0, toolCalls: 0, success: false, keyInsights: [], corrections: 0, validationLog: [] },
      { output: '', subCycles: 0, toolCalls: 0, success: false, keyInsights: [], corrections: 0, validationLog: [] },
      { output: 'Found note-' + i + '.md at path/folder/file.md', subCycles: 1, toolCalls: 2, success: true, keyInsights: ['ok'], corrections: 0, validationLog: [] },
    ];
    e.evaluate('retriever', undefined, 'Task ' + i, outputs[i % 3]);
  }
});
const h = e.getHistory();
assert.equal(h.totalEvaluations, 200);
assert.ok(h.recentScorecards.length <= 50);
pass('14d: evaluator handles 200 rapid evaluations without crash');
}

// 14e: Trace collector under heavy event load
{
const tc = new ReActTraceCollector();
let captured = 0;
tc.setCallback(() => captured++);
bench('trace-stress', () => {
  for (let i = 0; i < 500; i++) {
    const s = tc.emit('stress-sess', null, 'orch', 'session:start', -1, -1, 'E' + i, '');
    for (let j = 0; j < 3; j++) {
      tc.emit('stress-sess', s.id, 'worker-' + j, 'agent:act:start', i, j, 'Sub' + j, 'Action');
    }
  }
});
assert.equal(captured, 2000); // 500 sessions + 1500 sub-events
assert.equal(tc.getEvents().length, 2000);
const tree = tc.buildTree('stress-sess');
assert.ok(tree.length > 0);
pass('14e: trace collector handles 2000 events with callback');
}

// 14f: withRetry under rapid concurrent failures
{
const resultsList = [];
const promises = [];
for (let i = 0; i < 50; i++) {
  promises.push(
    withRetry(
      () => i % 3 === 0 ? Promise.resolve('ok-' + i) : Promise.reject(new Error('fail-' + i)),
      { maxRetries: 2, baseDelayMs: 5 },
      'stress-' + i
    ).then(r => resultsList.push({ i, ok: true }))
     .catch(e => resultsList.push({ i, ok: false, err: e.message }))
  );
}
await Promise.all(promises);
// 1/3 succeed (i%3===0), so ~17 should succeed, ~33 should fail after retries
const succeeded = resultsList.filter(r => r.ok).length;
const failed = resultsList.filter(r => !r.ok).length;
assert.ok(succeeded > 0, 'Some should succeed');
assert.ok(failed > 0, 'Some should fail');
assert.equal(succeeded + failed, 50);
pass('14f: withRetry handles 50 concurrent tasks in stress');
}
}

/* ═══ 15. End-to-End ReAct Session Simulation ═══ */
async function verifyE2E() {
console.log('\n─── 15. End-to-End ReAct Session Simulation ───');

const { ReActEvaluator } = await import(pathToFileURL(SRC + '/react/react-eval.ts').href);
const { parseReActResponse, buildReActOrchestratorPrompt, buildReActFinalSynthesisPrompt, buildWorkerReActPrompt } = await import(pathToFileURL(SRC + '/react/react-orchestrator.ts').href);
const { buildRolePrompt, filterToolsForRole, getRole } = await import(pathToFileURL(SRC + '/react/react-roles.ts').href);
const { DeadlockDetector, CircuitBreaker, SafeStateManager, withRetry } = await import(pathToFileURL(SRC + '/react/react-recovery.ts').href);

// 15a: Full simulated 2-cycle ReAct pipeline
{
const evaluator = new ReActEvaluator();
const dd = new DeadlockDetector();
const cb = new CircuitBreaker(3, 1000);
const sm = new SafeStateManager();

const task = 'Analyze the project architecture and summarize key design decisions';
const targetPath = 'architecture.md';

// --- Cycle 0: Orchestrator plans ---
const orch0Output = JSON.stringify({
  thought: { reasoning: 'Need to find architecture documentation first. Then analyze the design decisions.', assessment: 'acting', confidence: 0.8 },
  actions: [{ worker: 'retriever', prompt: 'Search for architecture documentation and design decision records', expectedOutput: 'List of architecture-related files with summaries', role: 'researcher' }]
});
const parsed0 = parseReActResponse(orch0Output);
assert.equal(parsed0.thought.assessment, 'acting');
pass('15a: Cycle 0 — orchestrator dispatches retriever');

// Simulate retriever worker with role
const role = getRole('researcher');
assert.ok(role, 'Researcher role exists');
const tools = filterToolsForRole('researcher', []);
assert.ok(Array.isArray(tools));

// Worker produces observation
const workerOutput = 'Found architecture.md (main document, 142 lines), design/decisions.md (design decisions with ADRs), api/gateway-design.md (API gateway architecture). Key insight: project uses microservices with Redis caching.';
const observation = { output: workerOutput, success: true, keyInsights: ['microservices', 'Redis caching', '3 architecture files'], surprised: false };

// Check deadlock — first output, should not deadlock
assert.equal(dd.isDeadlocked('e2e-session', workerOutput), false);
dd.record('e2e-session', workerOutput);

// Record safe state
sm.snapshot('e2e-session', 0, 'Pre-analysis state');

// Evaluate worker performance
const score0 = evaluator.evaluate('retriever', 'researcher', 'Search for architecture docs', {
  output: workerOutput, subCycles: 2, toolCalls: 3, success: true,
  keyInsights: ['microservices', 'Redis'], corrections: 0, validationLog: []
});
assert.ok(score0.compositeScore >= 0.4, 'Worker 0 score adequate');
pass('15a.1: Cycle 0 — worker produces valid observation');
}

// --- Cycle 1: Orchestrator synthesizes ---
{
const orch1Output = JSON.stringify({
  thought: {
    reasoning: 'From the architecture.md and design/decisions.md, the project uses microservices with Redis caching and PostgreSQL. The API gateway handles routing. Key decisions: ADR-1 chose microservices, ADR-2 chose Redis over Memcached, ADR-3 chose PostgreSQL over MongoDB.',
    assessment: 'complete', confidence: 0.92
  },
  finalAnswer: 'The project uses a microservices architecture with 3 key design decisions: (1) Microservices pattern for scalability (ADR-1), (2) Redis for caching over Memcached (ADR-2), (3) PostgreSQL for primary storage over MongoDB (ADR-3). Main architecture files: architecture.md, design/decisions.md, api/gateway-design.md.'
});
const parsed1 = parseReActResponse(orch1Output);
assert.equal(parsed1.thought.assessment, 'complete');
assert.ok(parsed1.finalAnswer && parsed1.finalAnswer.length > 50);
pass('15b: Cycle 1 — orchestrator produces final answer with high confidence');
}

// 15c: Build full orchestrator prompt from 2-cycle context
{
const ctx = {
  sessionId: 'e2e-full',
  task: 'Analyze project architecture',
  targetPath: 'architecture.md',
  cycles: [
    {
      index: 0,
      thought: { reasoning: 'Search for architecture docs', assessment: 'acting', confidence: 0.8, finalAnswer: undefined },
      action: { worker: 'retriever', prompt: 'Find architecture files', expectedOutput: 'List of architecture docs', role: 'researcher', targetPath: undefined },
      observation: { output: 'Found architecture.md (142 lines), design/decisions.md (89 lines)', success: true, keyInsights: ['2 architecture files found'], surprised: false },
      startedAt: Date.now() - 5000, completedAt: Date.now() - 3000
    },
    {
      index: 1,
      thought: { reasoning: 'Analyze findings and synthesize', assessment: 'acting', confidence: 0.85, finalAnswer: undefined },
      action: { worker: 'summarizer', prompt: 'Summarize architecture decisions from architecture.md and design/decisions.md', expectedOutput: 'Summary of key decisions', role: 'analyst' },
      observation: { output: 'Key decisions: ADR-1 Microservices, ADR-2 Redis caching, ADR-3 PostgreSQL. Architecture follows clean architecture pattern with separation of concerns.', success: true, keyInsights: ['3 ADRs', 'Clean architecture'], surprised: false },
      startedAt: Date.now() - 3000, completedAt: Date.now() - 1000
    }
  ],
  meta: { startedAt: Date.now() - 5000, completedAt: 0, totalCycles: 2, daemonCalls: 4, toolCalls: 6, termination: 'error' }
};

const prompt = buildReActOrchestratorPrompt(ctx, 2);
assert.ok(prompt.includes('Working Memory'));
assert.ok(prompt.includes('Cycle 1') || prompt.includes('Cycle 2'));
assert.ok(prompt.includes('architecture.md'));
pass('15c: full 2-cycle context builds valid orchestrator prompt');
}

// 15d: Final synthesis prompt from accumulated observations
{
const ctx = {
  sessionId: 'e2e-final',
  task: 'Summarize the project architecture',
  cycles: [
    { index: 0, thought: { reasoning: 'X', assessment: 'acting', confidence: 0.5, finalAnswer: undefined }, action: { worker: 'retriever', prompt: 'X', expectedOutput: 'X', targetPath: undefined }, observation: { output: 'Architecture uses event-driven pattern with Kafka for messaging between services.', success: true, keyInsights: ['event-driven', 'Kafka'], surprised: false }, startedAt: 0, completedAt: 0 },
    { index: 1, thought: { reasoning: 'X', assessment: 'acting', confidence: 0.5, finalAnswer: undefined }, action: { worker: 'summarizer', prompt: 'X', expectedOutput: 'X', targetPath: undefined }, observation: { output: 'Docker compose defines 4 services: web, worker, redis, postgres. Network isolation between public and internal.', success: true, keyInsights: ['4 services', 'network isolation'], surprised: false }, startedAt: 0, completedAt: 0 }
  ],
  meta: { startedAt: 0, completedAt: 0, totalCycles: 2, daemonCalls: 0, toolCalls: 0, termination: 'error' }
};
const synth = buildReActFinalSynthesisPrompt(ctx);
assert.ok(synth.includes('Summarize the project architecture'));
assert.ok(synth.includes('Kafka'));
assert.ok(synth.includes('Docker compose'));
pass('15d: final synthesis prompt aggregates all observations');
}

// 15e: Full error recovery in e2e pipeline
{
const cb2 = new CircuitBreaker(2, 500);
// Simulate 2 failures of retriever — circuit should open
cb2.recordFailure('retriever');
cb2.recordFailure('retriever');
assert.equal(cb2.isOpen('retriever'), true);

// Circuit breaker prevents further calls
try {
  if (cb2.isOpen('retriever')) throw new Error('Circuit breaker open for retriever');
} catch (e) {
  assert.ok(e.message.includes('Circuit breaker open'));
  pass('15e: circuit breaker blocks execution after 2 failures');
}

// Recovery: record success to reset
cb2.recordSuccess('retriever');
assert.equal(cb2.isOpen('retriever'), false);
pass('15e.1: circuit breaker resets after success');
}

// 15f: Worker ReAct prompt with role assignment
{
const action = { worker: 'retriever', prompt: 'Find all design documents', expectedOutput: 'Complete list of design documents', role: 'researcher', targetPath: 'design/' };
const prompt = buildRolePrompt(action);
assert.ok(prompt.includes('researcher agent'));
assert.ok(prompt.includes('Find all design documents'));
assert.ok(prompt.includes('design/'));
pass('15f: worker ReAct prompt includes role specialization');

// Without role — fallback to generic worker prompt
const noRoleAction = { worker: 'editor', prompt: 'Update the readme', expectedOutput: 'Updated readme' };
const noRolePrompt = buildWorkerReActPrompt('editor', 'Update the readme', 'README.md', undefined);
assert.ok(noRolePrompt.includes('editor agent'));
pass('15f.1: worker prompt without role uses generic template');
}

// 15g: End-to-end performance evaluation
{
const evaluator = new ReActEvaluator();
const results = [
  { agent: 'retriever', role: 'researcher', task: 'Search for docs', output: 'Found 5 files with architecture details at design/*.md, architecture.md (142 lines), api/spec.md (200 lines). Key finding: event-driven microservices.', subCycles: 2, toolCalls: 5, success: true, corrections: 0 },
  { agent: 'summarizer', role: 'analyst', task: 'Summarize findings', output: 'Key decisions: 1) Event-driven architecture with Kafka, 2) Redis caching layer, 3) PostgreSQL persistence. Services: web, worker, redis, postgres (4 containers).', subCycles: 2, toolCalls: 2, success: true, corrections: 0 },
  { agent: 'editor', role: 'writer', task: 'Write summary note', output: '', subCycles: 0, toolCalls: 0, success: false, corrections: 0 }
];
let totalScore = 0;
for (const r of results) {
  const sc = evaluator.evaluate(r.agent, r.role, r.task, {
    output: r.output, subCycles: r.subCycles, toolCalls: r.toolCalls,
    success: r.success, keyInsights: [], corrections: r.corrections, validationLog: []
  });
  totalScore += sc.compositeScore;
}
const avg = totalScore / results.length;
assert.ok(avg > 0, 'Average score across agents should be positive');
const hist = evaluator.getHistory();
assert.equal(hist.totalEvaluations, 3);
const hints = evaluator.getOptimizationHints();
assert.ok(typeof hints === 'string', 'Hints should be a string');
pass('15g: end-to-end evaluation across 3 agents produces aggregate scores');
}
}

/* ═══ 16. Vault Image Processing ═══ */
async function verifyImageProcessing() {
console.log('\n─── 16. Vault Image Processing ───');
const m = await import(pathToFileURL(SRC + '/providers/image-utils.ts').href);
const { classifyTask } = await import(pathToFileURL(SRC + '/routing.ts').href);
const vault = await mkdtemp(join(tmpdir(), 'cc-images-'));
const attachments = join(vault, 'Attachments');
const notes = join(vault, 'Notes');
await mkdir(attachments); await mkdir(notes);
const fixtures = {
  'sample.png': Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]),
  'sample.jpg': Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,4]),
  'sample.webp': Buffer.from('RIFF1234WEBPdata', 'ascii'),
  'sample.gif': Buffer.from('GIF89a-data', 'ascii')
};
try {
for (const [name, data] of Object.entries(fixtures)) await writeFile(join(attachments, name), data);
await writeFile(join(attachments, 'broken.png'), Buffer.from('not an image'));
await writeFile(join(notes, 'note.md'), '# Note');

{
for (const [name, expected] of [['sample.png','image/png'],['sample.jpg','image/jpeg'],['sample.webp','image/webp'],['sample.gif','image/gif']]) {
  const image = await m.readImageAsBase64(join(attachments, name));
  assert.equal(image.mimeType, expected); assert.ok(image.data.length > 0);
}
pass('16a: PNG, JPEG, WebP, and GIF vault images encode with validated MIME types');
}
{
const prompt = '![[sample.png|640]] ![Photo](../Attachments/sample%20photo.jpg "title")';
await writeFile(join(attachments, 'sample photo.jpg'), fixtures['sample.jpg']);
const refs = m.extractImageRefs(prompt);
assert.equal(refs.length, 2); assert.equal(refs[0].filePath, 'sample.png');
assert.equal(refs[1].filePath, '../Attachments/sample photo.jpg');
assert.equal(m.resolveVaultPath('sample.png', vault, join(notes, 'note.md')), join(attachments, 'sample.png'));
assert.equal(m.resolveVaultPath('../Attachments/sample photo.jpg', vault, join(notes, 'note.md')), join(attachments, 'sample photo.jpg'));
pass('16b: Obsidian aliases, URL-escaped Markdown attachments, note-relative and shortest vault paths');
}
{
const canvasPath = join(vault, 'board.canvas');
await writeFile(canvasPath, JSON.stringify({ nodes: [
  { id: 'a', type: 'file', file: 'Attachments/sample.png' },
  { id: 'b', type: 'file', file: 'Attachments/sample.webp' },
  { id: 'c', type: 'text', text: 'ignore' }
] }));
const refs = await m.extractCanvasImageRefs(canvasPath); assert.equal(refs.length, 2);
const processed = await m.preprocessPrompt('Inspect ![[board.canvas]]', vault);
assert.equal(processed.images.length, 2); assert.ok(processed.cleanedPrompt.includes('Canvas images attached'));
assert.equal(classifyTask('Inspect ![[board.canvas]]'), 'vision');
pass('16c: JSON Canvas file nodes are expanded into embedded vault images and routed as vision');
}
{
let transformed = false;
const image = await m.readImageAsBase64(join(attachments, 'sample.png'), 'large', {
  maxPayloadBytes: 140,
  transformImage: async (_buffer, mime, targetBytes) => {
    transformed = true; assert.ok(targetBytes < 10);
    return { buffer: fixtures['sample.png'].subarray(0, 8), mimeType: mime };
  }
});
assert.ok(transformed); assert.equal(image.mimeType, 'image/png');
pass('16d: oversized provider payload invokes dynamic resize/compression before base64 encoding');
}
{
await assert.rejects(() => m.readImageAsBase64(join(attachments, 'broken.png')), /Corrupt or unrecognized/);
const originalWarn = console.warn; console.warn = () => {};
try {
  const processed = await m.preprocessPrompt('Review ![[Attachments/broken.png]]', vault);
  assert.equal(processed.images.length, 0); assert.ok(processed.cleanedPrompt.includes('Image unavailable'));
} finally { console.warn = originalWarn; }
pass('16e: corrupt images reject safely and degrade to an unavailable placeholder');
}
} finally { await rm(vault, { recursive: true, force: true }); }
}

/* ═══ 17. Memory Topic Clustering ═══ */
async function verifyMemoryTopics() {
console.log('\n─── 17. Memory Topic Clustering ───');
const { generateTopicClusters, rankTopicClusters } = await import(pathToFileURL(SRC + '/react/react-memory-topics.ts').href);
const notes = [
  { path: 'Memory/a-summary.md', sessionId: 'a', task: 'Refactor TypeScript provider modules', content: 'Split large classes, simplify functions, and clean up architecture.', timestamp: 500 },
  { path: 'Memory/b-summary.md', sessionId: 'b', task: 'Code refactoring for the daemon', content: 'Extract RPC parsing functions and improve module boundaries.', timestamp: 400 },
  { path: 'Memory/c-summary.md', sessionId: 'c', task: 'Reorganize vault project notes', content: 'Move notes into folders and improve the vault taxonomy.', timestamp: 300 },
  { path: 'Memory/d-summary.md', sessionId: 'd', task: 'Fix timeout regression', content: 'Debug worker timeout errors and fix a crash.', timestamp: 200 },
  { path: 'Memory/e-summary.md', sessionId: 'e', task: 'Resolve provider bug', content: 'Fixed an authentication error and added a regression test.', timestamp: 100 }
];
{
const clusters = generateTopicClusters(notes);
const code = clusters.find(c => c.label === 'Code Refactoring');
const vault = clusters.find(c => c.label === 'Vault Reorganization');
const bugs = clusters.find(c => c.label === 'Bug Fixes');
assert.ok(code && code.notePaths.length === 2);
assert.ok(vault && vault.notePaths.includes('Memory/c-summary.md'));
assert.ok(bugs && bugs.notePaths.length === 2);
assert.ok(code.summary.includes('Refactor TypeScript'));
pass('17a: session summaries form deterministic thematic context hubs');
}
{
const clusters = generateTopicClusters(notes);
const refactorMatches = rankTopicClusters('Improve the TypeScript architecture by refactoring provider classes', clusters, 2);
assert.equal(refactorMatches[0]?.label, 'Code Refactoring');
const vaultMatches = rankTopicClusters('organize vault folders and move project notes', clusters, 1);
assert.equal(vaultMatches[0]?.label, 'Vault Reorganization');
pass('17b: queries retrieve the relevant high-level topic cluster');
}
{
const clusters = generateTopicClusters(notes);
const bugMatches = rankTopicClusters('debug and fix the worker timeout regression', clusters, 1);
assert.equal(bugMatches[0]?.label, 'Bug Fixes');
assert.ok(bugMatches[0].keywords.length <= 6 && bugMatches[0].summary.length <= 480);
pass('17c: cluster retrieval stays compact for hybrid prompt context');
}
}

/* ═══ 18. File-Level Write Coordination ═══ */
async function verifyFileLocks() {
console.log('\n─── 18. File-Level Write Coordination ───');
const { FileLockManager, FileBusyError, getSharedFileLockManager, normalizeLockPath } = await import(pathToFileURL(SRC + '/file-lock.ts').href);
{
const locks = new FileLockManager();
const events = [];
let releaseFirst;
const gate = new Promise(resolve => { releaseFirst = resolve; });
const first = locks.withLock('Projects/Plan.md', async () => { events.push('first:start'); await gate; events.push('first:end'); });
await new Promise(resolve => setTimeout(resolve, 0));
const second = locks.withLock('projects\\plan.md', async () => { events.push('second:start'); events.push('second:end'); });
assert.equal(locks.isLocked('PROJECTS/PLAN.MD'), true);
assert.deepEqual(events, ['first:start']);
releaseFirst(); await Promise.all([first, second]);
assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
assert.equal(locks.isLocked('projects/plan.md'), false);
pass('18a: same-file writes queue FIFO across normalized path variants');
}
{
const locks = new FileLockManager();
let releaseA;
const gateA = new Promise(resolve => { releaseA = resolve; });
const events = [];
const a = locks.withLock('a.md', async () => { events.push('a'); await gateA; });
await new Promise(resolve => setTimeout(resolve, 0));
const b = locks.withLock('b.md', async () => { events.push('b'); });
await b; assert.deepEqual(events, ['a', 'b']); releaseA(); await a;
pass('18b: unrelated note paths remain concurrent');
}
{
const error = new FileBusyError('Plans/Roadmap.md');
assert.equal(error.name, 'FileBusyError');
assert.ok(error.message.includes('Plans/Roadmap.md'));
assert.equal(normalizeLockPath(' /Plans\\Roadmap.md/ '), 'plans/roadmap.md');
pass('18c: conflicting cycle actions produce an actionable FileBusyError');
}
{
const vaultOwner = {};
const sharedA = getSharedFileLockManager(vaultOwner);
const sharedB = getSharedFileLockManager(vaultOwner);
assert.equal(sharedA, sharedB);
assert.notEqual(sharedA, getSharedFileLockManager({}));
let release;
const gate = new Promise(resolve => { release = resolve; });
const events = [];
const uiWrite = sharedA.withLock('Daily/Today.md', async () => { events.push('ui:start'); await gate; events.push('ui:end'); });
await new Promise(resolve => setTimeout(resolve, 0));
const cliWrite = sharedB.withLock('daily\\today.md', async () => { events.push('cli'); });
assert.deepEqual(events, ['ui:start']);
release(); await Promise.all([uiWrite, cliWrite]);
assert.deepEqual(events, ['ui:start', 'ui:end', 'cli']);
pass('18d: UI, CLI, and background services share one per-vault lock namespace');
}
}

/* ═══ 19. Lazy BM25 Token Pre-filter ═══ */
async function verifyBm25TokenPrefilter() {
console.log('\n─── 19. Lazy BM25 Token Pre-filter ───');
const { parseQuery, scoreBatch } = await import(pathToFileURL(SRC + '/obsidian-search.ts').href);
const contents = new Map([
  ['Notes/alpha.md', '---\ntags: [search]\n---\nAlpha architecture search search project plan.'],
  ['Notes/beta.md', '# Beta\nArchitecture search notes for the project.'],
  ['Notes/gamma.md', '# Gamma\nRecipes, gardening, and weekend errands.'],
  ['Notes/frontmatter-only.md', '---\ntopic: architecture\n---\nUnrelated private journal text.'],
  ['Notes/delta.md', '# Delta\nDeployment architecture project search checklist.'],
]);
const files = [...contents].map(([path, content], i) => ({
  path, name: path.slice(path.lastIndexOf('/') + 1), stat: { mtime: i + 1, size: content.length },
}));
const app = {
  vault: { cachedRead: async file => contents.get(file.path) },
  metadataCache: { getFileCache: () => ({ headings: [], tags: [] }) },
};
const query = parseQuery('architecture search project');
{
const exhaustiveDiagnostics = {};
const filteredDiagnostics = {};
const exhaustive = await scoreBatch(files, query, app, 3, { useTokenPrefilter: false, diagnostics: exhaustiveDiagnostics });
const filtered = await scoreBatch(files, query, app, 3, { diagnostics: filteredDiagnostics });
assert.deepEqual(filtered.map(r => [r.path, r.score]), exhaustive.map(r => [r.path, r.score]));
assert.equal(filteredDiagnostics.candidateDocuments, files.length);
assert.equal(exhaustiveDiagnostics.scoredDocuments, files.length);
pass('19a: token pre-filter preserves exhaustive BM25 top-K ranking and scores');
}
{
const diagnostics = {};
const results = await scoreBatch(files, query, app, 10, { diagnostics });
assert.equal(diagnostics.prefilterSkipped, 2);
assert.equal(diagnostics.scoredDocuments, 3);
assert.ok(!results.some(result => result.path === 'Notes/gamma.md'));
assert.ok(!results.some(result => result.path === 'Notes/frontmatter-only.md'));
pass('19b: non-matching and frontmatter-only documents skip full BM25 scoring');
}
}

/* ═══ 20. Native Workflow Parsers ═══ */
async function verifyNativeWorkflowParsers() {
console.log('\n─── 20. Native Workflow Parsers ───');
const { exportWorkflowToCanvas, loadWorkflowFromNote, loadWorkflowFromCanvas } = await import(pathToFileURL(SRC + '/workflows/native-workflow-parser.ts').href);
{
const file = { name: 'research.md', basename: 'research' };
const frontmatter = {
  id: 'note-workflow', name: 'Research Flow', description: 'Research and summarize', version: 2,
  inputs: [
    { name: 'topic', type: 'string', description: 'Topic to research', required: true },
    { name: 'depth', type: 'number', default: 3, options: [1, 2, 3] },
  ],
  steps: [{ id: 'find', name: 'Find notes', workerProfile: 'retriever', role: 'researcher', taskType: 'reading', prompt: 'Find {{topic}}', outputKey: 'sources' }],
};
let cacheCalls = 0;
const workflow = loadWorkflowFromNote(file, { metadataCache: { getFileCache(received) { cacheCalls++; assert.equal(received, file); return { frontmatter }; } } });
assert.equal(cacheCalls, 1);
assert.equal(workflow.id, 'note-workflow'); assert.equal(workflow.name, 'Research Flow'); assert.equal(workflow.version, '2');
assert.deepEqual(workflow.inputs.topic, { type: 'string', description: 'Topic to research', required: true });
assert.deepEqual(workflow.inputs.depth, { type: 'number', default: 3, options: [1, 2, 3] });
assert.deepEqual(workflow.steps[0], { id: 'find', name: 'Find notes', workerProfile: 'retriever', role: 'researcher', taskType: 'reading', promptTemplate: 'Find {{topic}}', dependsOn: [], outputKey: 'sources' });
pass('20a: note workflow uses pre-parsed frontmatter inputs and steps');
}
{
const file = { name: 'pipeline.canvas', basename: 'pipeline' };
const canvas = { nodes: [
  { id: 'finish', text: 'Write the report', workerProfile: 'editor', role: 'writer', name: 'Finish' },
  { id: 'find', text: 'Find sources', workerProfile: 'retriever', role: 'researcher' },
  { id: 'review', data: { prompt: 'Review facts', workerProfile: 'summarizer', role: 'fact-checker' } },
], edges: [
  { id: 'e1', fromNode: 'find', toNode: 'review' },
  { id: 'e2', fromNode: 'review', toNode: 'finish' },
] };
let reads = 0;
const workflow = await loadWorkflowFromCanvas(file, { vault: { async read(received) { reads++; assert.equal(received, file); return JSON.stringify(canvas); } } });
assert.equal(reads, 1); assert.deepEqual(workflow.steps.map(step => step.id), ['find', 'review', 'finish']);
assert.deepEqual(workflow.steps.map(step => step.dependsOn), [[], ['find'], ['review']]);
assert.equal(workflow.steps[0].promptTemplate, 'Find sources'); assert.equal(workflow.steps[1].role, 'fact-checker');
pass('20b: Canvas nodes and directed edges produce a topological workflow graph');
}
{
const file = { name: 'defaults.md', basename: 'defaults' };
const note = loadWorkflowFromNote(file, { metadataCache: { getFileCache: () => undefined } });
assert.deepEqual(note, { id: 'defaults', name: 'defaults', description: '', version: '1.0', inputs: {}, steps: [] });
const canvas = await loadWorkflowFromCanvas(
  { name: 'defaults.canvas', basename: 'defaults' },
  { vault: { read: async () => JSON.stringify({ nodes: [{ id: 'only', text: 'Do it' }] }) } },
);
assert.equal(canvas.steps[0].name, 'Step 1'); assert.equal(canvas.steps[0].workerProfile, 'orchestrator');
assert.deepEqual(canvas.steps[0].dependsOn, []); assert.deepEqual(canvas.inputs, {});
pass('20c: missing optional workflow metadata receives safe defaults');
}
{
const workflow = { id: 'export', name: 'Export', description: '', version: '1', inputs: {}, steps: [
  { id: 'research', name: 'Research', workerProfile: 'retriever', promptTemplate: 'Find sources', dependsOn: [] },
  { id: 'outline', name: 'Outline', workerProfile: 'summarizer', promptTemplate: 'Build outline', dependsOn: [] },
  { id: 'draft', name: 'Draft', workerProfile: 'editor', promptTemplate: 'Write draft', dependsOn: ['research', 'outline'], condition: "inputs.ready == true" },
  { id: 'review', name: 'Review', workerProfile: 'orchestrator', promptTemplate: 'Review draft', dependsOn: ['draft'] },
] };
const canvas = JSON.parse(exportWorkflowToCanvas(workflow));
assert.deepEqual(canvas.nodes.map(node => node.id), ['research', 'outline', 'draft', 'review']);
const byId = new Map(canvas.nodes.map(node => [node.id, node]));
assert.deepEqual([byId.get('research').x, byId.get('research').y], [0, 0]);
assert.deepEqual([byId.get('outline').x, byId.get('outline').y], [0, 300]);
assert.deepEqual([byId.get('draft').x, byId.get('draft').y], [480, 0]);
assert.deepEqual([byId.get('review').x, byId.get('review').y], [960, 0]);
assert.equal(byId.get('draft').condition, "inputs.ready == true");
assert.ok(byId.get('draft').text.includes('Write draft'));
assert.deepEqual(canvas.edges.map(edge => [edge.fromNode, edge.toNode]), [
  ['research', 'draft'], ['outline', 'draft'], ['draft', 'review'],
]);
assert.ok(canvas.edges.every(edge => edge.fromSide === 'right' && edge.toSide === 'left'));
pass('20d: workflow export generates tiered Canvas positions and dependency edges');
}
}

/* ═══ 21. Workflow Engine ═══ */
async function verifyWorkflowEngine() {
console.log('\n─── 21. Workflow Engine ───');
const { WorkflowEngine, WorkflowResolutionError, evaluateWorkflowCondition, interpolateTemplate, resolveWorkflowTiers } = await import(pathToFileURL(SRC + '/workflows/workflow-engine.ts').href);
{
const context = {
  inputs: { targetNote: 'Projects/Alpha.md', config: { depth: 3 } },
  stepResults: { analyze: { result: 'Five findings', output: 'Five findings', tokens: 12 } },
  stepStatuses: {}, totalTokens: 0, totalLatencyMs: 0,
};
assert.equal(
  interpolateTemplate('Edit {{ inputs.targetNote }} at depth {{inputs.config.depth}} using {{steps.analyze.result}}.', context),
  'Edit Projects/Alpha.md at depth 3 using Five findings.',
);
assert.equal(interpolateTemplate('Keep {{inputs.missing}} intact.', context), 'Keep {{inputs.missing}} intact.');
pass('21a: workflow templates resolve nested input and step-result variables');
}
{
const steps = [
  { id: 'a', name: 'A', workerProfile: 'retriever', promptTemplate: 'A', dependsOn: ['c'] },
  { id: 'b', name: 'B', workerProfile: 'summarizer', promptTemplate: 'B', dependsOn: ['a'] },
  { id: 'c', name: 'C', workerProfile: 'editor', promptTemplate: 'C', dependsOn: ['b'] },
];
assert.throws(() => resolveWorkflowTiers(steps), error => error instanceof WorkflowResolutionError && /Cyclic workflow dependency/.test(error.message));
pass('21b: cyclic workflow dependencies are rejected');
}
{
const calls = []; const releases = {}; const streamed = [];
const executor = { async dispatch(request) {
  const id = request.taskId.split(':').at(-1); calls.push('start:' + id);
  if (id === 'research' || id === 'outline') await new Promise(resolve => { releases[id] = resolve; });
  request.onStream?.('delta:' + id); calls.push('end:' + id);
  return { output: id === 'research' ? 'facts' : id === 'outline' ? 'structure' : request.userPrompt, success: true, providerId: 'custom', model: 'mock', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, latencyMs: 5 };
} };
const definition = { id: 'parallel', name: 'Parallel', description: '', version: '1', inputs: { topic: { type: 'string', required: true } }, steps: [
  { id: 'research', name: 'Research', workerProfile: 'retriever', taskType: 'reading', promptTemplate: 'Research {{inputs.topic}}', dependsOn: [] },
  { id: 'outline', name: 'Outline', workerProfile: 'summarizer', promptTemplate: 'Outline {{inputs.topic}}', dependsOn: [] },
  { id: 'write', name: 'Write', workerProfile: 'editor', promptTemplate: '{{steps.research.result}} + {{steps.outline.result}}', dependsOn: ['research', 'outline'] },
] };
const running = new WorkflowEngine(executor).execute(definition, { topic: 'alpha' }, { onStream: (delta, step) => streamed.push([step.id, delta]) });
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(calls, ['start:research', 'start:outline']);
releases.outline(); await Promise.resolve(); assert.ok(!calls.includes('start:write'));
releases.research(); const context = await running;
assert.ok(calls.indexOf('start:write') > calls.indexOf('end:research'));
assert.ok(calls.indexOf('start:write') > calls.indexOf('end:outline'));
assert.equal(context.stepResults.write.result, 'facts + structure');
assert.deepEqual(context.stepStatuses, { research: 'completed', outline: 'completed', write: 'completed' });
assert.equal(context.totalTokens, 9); assert.equal(context.totalLatencyMs, 15);
assert.ok(streamed.some(([id, delta]) => id === 'write' && delta === 'delta:write'));
assert.ok(streamed.some(([, delta]) => delta.includes('complete')));
pass('21c: independent DAG steps run in parallel before dependent tiers and stream output');
}
{
const context = {
  inputs: { style: 'concise', enabled: true },
  stepResults: { analyze: { result: 'assessment: refactor_needed', output: 'assessment: refactor_needed' } },
  stepStatuses: { analyze: 'completed' }, totalTokens: 0, totalLatencyMs: 0,
};
assert.equal(evaluateWorkflowCondition("inputs.style == 'concise'", context), true);
assert.equal(evaluateWorkflowCondition("steps.analyze.result.contains('refactor_needed')", context), true);
assert.equal(evaluateWorkflowCondition("inputs.enabled && !steps.analyze.result.contains('blocked')", context), true);
assert.equal(evaluateWorkflowCondition("inputs.style == 'verbose' || false", context), false);
pass('21d: workflow conditions evaluate input comparisons, boolean operators, and step-output contains calls');
}
{
const calls = []; const streamed = [];
const executor = { async dispatch(request) {
  const id = request.taskId.split(':').at(-1); calls.push({ id, prompt: request.userPrompt });
  const output = id === 'analyze' ? 'refactor_needed' : request.userPrompt;
  return { output, success: true, providerId: 'custom', model: 'mock', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, latencyMs: 4 };
} };
const definition = { id: 'conditions', name: 'Conditions', description: '', version: '1', inputs: { style: { type: 'string', required: true } }, steps: [
  { id: 'analyze', name: 'Analyze', workerProfile: 'retriever', promptTemplate: 'Analyze', dependsOn: [] },
  { id: 'verbose', name: 'Verbose', workerProfile: 'editor', promptTemplate: 'Verbose rewrite', dependsOn: ['analyze'], condition: "inputs.style == 'verbose'" },
  { id: 'refactor', name: 'Refactor', workerProfile: 'editor', promptTemplate: 'Use {{steps.analyze.result}}', dependsOn: ['analyze'], condition: "steps.analyze.result.contains('refactor_needed')" },
  { id: 'finish', name: 'Finish', workerProfile: 'summarizer', promptTemplate: 'Skipped={{steps.verbose.result}}; prior={{steps.refactor.result}}', dependsOn: ['verbose', 'refactor'], condition: "inputs.style == 'concise'" },
  { id: 'blocked', name: 'Blocked', workerProfile: 'summarizer', promptTemplate: 'Should not run', dependsOn: ['verbose'], condition: "steps.verbose.result.contains('available')" },
] };
const context = await new WorkflowEngine(executor).execute(definition, { style: 'concise' }, { onStream: (delta, step) => streamed.push([step.id, delta]) });
assert.deepEqual(calls.map(call => call.id), ['analyze', 'refactor', 'finish']);
assert.deepEqual(context.stepStatuses, { analyze: 'completed', verbose: 'skipped', refactor: 'completed', finish: 'completed', blocked: 'skipped' });
assert.equal(context.stepResults.verbose, undefined);
assert.equal(context.stepResults.blocked, undefined);
assert.equal(calls.at(-1).prompt, 'Skipped={{steps.verbose.result}}; prior=Use refactor_needed');
assert.equal(context.totalTokens, 6); assert.equal(context.totalLatencyMs, 12);
assert.ok(streamed.some(([id, delta]) => id === 'verbose' && delta.includes('skipped')));
assert.ok(streamed.some(([id, delta]) => id === 'blocked' && delta.includes('skipped')));
pass('21e: skipped dependencies resolve cleanly and downstream conditions may proceed or skip from context');
}
{
const files = ['one', 'two', 'three', 'four', 'five'].map(name => ({
  path: `Queue/${name}.md`, name: `${name}.md`, basename: name, extension: 'md',
}));
const prompts = []; const writes = []; const events = []; let active = 0; let maxActive = 0;
const executor = { async dispatch(request) {
  active++; maxActive = Math.max(maxActive, active); prompts.push(request.userPrompt); events.push(`start:${request.taskId.split(':').at(-2)}`);
  await new Promise(resolve => setTimeout(resolve, 1)); active--;
  return { output: request.userPrompt, success: true, providerId: 'custom', model: 'mock', usage: { totalTokens: 1 }, latencyMs: 1 };
} };
const app = { fileManager: { async processFrontMatter(file, mutate) {
  const frontmatter = {}; mutate(frontmatter); writes.push([file.path, frontmatter.agent_status]);
} } };
const definition = { id: 'batch', name: 'Batch', description: '', version: '1', inputs: {}, steps: [
  { id: 'run', name: 'Run', workerProfile: 'editor', promptTemplate: 'Process {{inputs.target.path}}', dependsOn: [] },
] };
const results = await new WorkflowEngine(executor).executeOnTargets(definition, {}, files, app, {
  concurrency: 2, limit: 4, onBatchComplete: completed => events.push(`refresh:${completed.length}`),
});
assert.deepEqual(prompts, ['Process Queue/one.md', 'Process Queue/two.md', 'Process Queue/three.md', 'Process Queue/four.md']);
assert.deepEqual(results.map(result => result.file.path), files.slice(0, 4).map(file => file.path));
assert.deepEqual(results.map(result => result.context.stepStatuses.run), ['completed', 'completed', 'completed', 'completed']);
assert.equal(maxActive, 2);
assert.deepEqual(events.filter(event => event.startsWith('refresh:')), ['refresh:2', 'refresh:2']);
assert.ok(events.indexOf('refresh:2') < events.indexOf('start:Queue/three.md'));
assert.ok(files.slice(0, 4).every(file => writes.some(([path, status]) => path === file.path && status === 'completed')));
assert.ok(!prompts.some(prompt => prompt.includes('five.md')));
pass('21f: queue execution splits batches, refreshes between tiers, and honors partial-run limits');
}
{
const events = [];
const executor = { async dispatch() { events.push('dispatch'); return { output: 'ok', success: true, usage: { totalTokens: 1 }, latencyMs: 1 }; } };
const jit = { async withJitModel(taskType, work) { events.push(`warm:${taskType}`); try { return await work(); } finally { events.push(`evict:${taskType}`); } } };
const app = { fileManager: { async processFrontMatter(_file, mutate) { mutate({}); } } };
const definition = { id: 'jit-batch', name: 'JIT Batch', description: '', version: '1', inputs: {}, steps: [
  { id: 'run', name: 'Run', workerProfile: 'editor', taskType: 'coding', promptTemplate: 'run', dependsOn: [] },
] };
const files = [{ path: 'Queue/a.md', name: 'a.md', basename: 'a', extension: 'md' }, { path: 'Queue/b.md', name: 'b.md', basename: 'b', extension: 'md' }];
await new WorkflowEngine(executor, jit).executeOnTargets(definition, {}, files, app, { concurrency: 2 });
assert.deepEqual(events, ['warm:coding', 'dispatch', 'dispatch', 'evict:coding']);
pass('21g: Base queue holds one routed JIT lifecycle across all targets and evicts after completion');
}
}

/* ═══ 22. Obsidian Base Queue ═══ */
async function verifyBaseQueue() {
console.log('\n─── 22. Obsidian Base Queue ───');
const { clampBaseBatchConcurrency, parseBaseQueue, setBaseYamlParserForTests, splitBaseQueueBatches } = await import(pathToFileURL(SRC + '/workflows/base-queue.ts').href);
const parseSimpleBase = source => {
  const expressions = source.split(/\r?\n/).map(line => line.match(/^\s*-\s+(.+)$/)?.[1]).filter(Boolean);
  return { filters: { and: expressions } };
};
setBaseYamlParserForTests(parseSimpleBase);
try {
{
const queue = ['a', 'b', 'c', 'd', 'e', 'f'];
assert.deepEqual(splitBaseQueueBatches(queue, 2), [['a', 'b'], ['c', 'd'], ['e', 'f']]);
assert.deepEqual(splitBaseQueueBatches(queue, 3, 4), [['a', 'b', 'c'], ['d']]);
assert.equal(clampBaseBatchConcurrency(0), 1); assert.equal(clampBaseBatchConcurrency(50), 10);
pass('22a: Base queues split into bounded tiers and support partial execution limits');
}
const files = [
  { path: 'Tasks/alpha.md', name: 'alpha.md', basename: 'alpha', extension: 'md', parent: { path: 'Tasks' } },
  { path: 'Tasks/done.md', name: 'done.md', basename: 'done', extension: 'md', parent: { path: 'Tasks' } },
  { path: 'Tasks/low.md', name: 'low.md', basename: 'low', extension: 'md', parent: { path: 'Tasks' } },
  { path: 'Tasks/failed.md', name: 'failed.md', basename: 'failed', extension: 'md', parent: { path: 'Tasks' } },
  { path: 'Notes/other.md', name: 'other.md', basename: 'other', extension: 'md', parent: { path: 'Notes' } },
];
const frontmatter = new Map([
  ['Tasks/alpha.md', { queue: 'agent', priority: 3, agent_status: 'pending' }],
  ['Tasks/done.md', { queue: 'agent', priority: 5, agent_status: 'completed' }],
  ['Tasks/low.md', { queue: 'agent', priority: 1 }],
  ['Tasks/failed.md', { queue: 'agent', priority: 5, agent_status: 'failed' }],
  ['Notes/other.md', { queue: 'manual', priority: 5 }],
]);
const app = { vault: { read: async file => file.content, getMarkdownFiles: () => files }, metadataCache: { getFileCache: file => ({ frontmatter: frontmatter.get(file.path) }) } };
{
const base = { path: 'Queues/agents.base', name: 'agents.base', basename: 'agents', extension: 'base', content: 'filters:\n  and:\n    - queue == "agent"\n    - priority >= 2' };
const matched = await parseBaseQueue(base, app);
assert.deepEqual(matched.map(file => file.path), ['Tasks/alpha.md']);
pass('22b: standalone Base filters match metadata properties and exclude completed notes');
}
{
const note = { path: 'Queues/dashboard.md', name: 'dashboard.md', basename: 'dashboard', extension: 'md', content: '# Queue\n\n```base\nfilters:\n  and:\n    - file.folder == "Tasks"\n    - queue == "agent"\n```\n' };
const matched = await parseBaseQueue(note, app);
assert.deepEqual(matched.map(file => file.path), ['Tasks/alpha.md', 'Tasks/low.md']);
pass('22c: embedded base code blocks resolve matching Markdown files and omit failed notes');
}
{
setBaseYamlParserForTests(source => {
  if (source.includes('malformed: [')) throw new Error('Invalid YAML');
  return source.includes('tagged') ? { filters: { and: ['file.hasTag("#ready")', 'file.folder == "Tasks"'] } } : {};
});
const taggedFiles = [
  { path: 'Tasks/tagged.md', name: 'tagged.md', basename: 'tagged', extension: 'md', parent: { path: 'Tasks' } },
  { path: 'Notes/tagged.md', name: 'tagged.md', basename: 'tagged', extension: 'md', parent: { path: 'Notes' } },
];
const taggedApp = {
  vault: { read: async file => file.content, getMarkdownFiles: () => taggedFiles },
  metadataCache: { getFileCache: file => ({ frontmatter: {}, tags: file.path.startsWith('Tasks/') ? [{ tag: '#ready', position: {} }] : [{ tag: '#ready', position: {} }] }) },
};
const note = { path: 'Queues/mixed.md', name: 'mixed.md', basename: 'mixed', extension: 'md', content: '```base\nmalformed: [\n```\n\n```base\ntagged: true\n```' };
const matched = await parseBaseQueue(note, taggedApp);
assert.deepEqual(matched.map(file => file.path), ['Tasks/tagged.md']);
pass('22d: malformed Base YAML is ignored while valid tag and folder filters still resolve metadata-cached notes');
}
{
setBaseYamlParserForTests(() => { throw new Error('Invalid YAML'); });
const malformed = { path: 'Queues/broken.base', name: 'broken.base', basename: 'broken', extension: 'base', content: 'filters: [' };
assert.deepEqual(await parseBaseQueue(malformed, app), []);
pass('22e: wholly malformed Base syntax falls back to an empty queue');
}
} finally { setBaseYamlParserForTests(null); }
}

/* ═══ 23. Native Bases Results ═══ */
async function verifyNativeBasesResults() {
console.log('\n─── 23. Native Bases Results ───');
const { filesFromNativeBaseEntries } = await import(pathToFileURL(SRC + '/workflows/native-base-results.ts').href);
const files = [
  { path: 'Queue/one.md', name: 'one.md', basename: 'one', extension: 'md' },
  { path: 'Queue/done.md', name: 'done.md', basename: 'done', extension: 'md' },
  { path: 'Queue/board.canvas', name: 'board.canvas', basename: 'board', extension: 'canvas' },
];
const app = { metadataCache: { getFileCache: file => ({ frontmatter: file.path.includes('done') ? { agent_status: 'completed' } : {} }) } };
const result = filesFromNativeBaseEntries([{ file: files[0] }, { file: files[1] }, { file: files[0] }, { file: files[2] }], app);
assert.deepEqual(result.map(file => file.path), ['Queue/one.md']);
pass('23a: native Bases entries preserve evaluated order and exclude completed/duplicate/non-Markdown files');
}

/* ═══ 24. Frontmatter Agent-State Sync ═══ */
async function verifyFrontmatterSync() {
console.log('\n─── 24. Frontmatter Agent-State Sync ───');
const { DebouncedFrontmatterSync, updateNoteAgentState } = await import(pathToFileURL(SRC + '/workflows/frontmatter-sync.ts').href);
{
const file = { path: 'Tasks/alpha.md', extension: 'md' };
const frontmatter = { title: 'Alpha', priority: 4, nested: { owner: 'team' }, agent_status: 'pending' };
const app = { fileManager: { async processFrontMatter(received, mutate) { assert.equal(received, file); mutate(frontmatter); } } };
await updateNoteAgentState(file, app, { status: 'completed', evalScore: 0.876543, lastRun: '2026-07-25T12:00:00.000Z' });
assert.deepEqual(frontmatter, {
  title: 'Alpha', priority: 4, nested: { owner: 'team' },
  agent_status: 'completed', agent_eval_score: 0.8765, agent_last_run: '2026-07-25T12:00:00.000Z',
});
pass('24a: native processFrontMatter updates agent properties without overwriting existing fields');
}
{
const file = { path: 'Tasks/batch.md', extension: 'md' };
const frontmatter = { keep: true };
let writes = 0;
const app = { fileManager: { async processFrontMatter(received, mutate) { writes++; assert.equal(received, file); mutate(frontmatter); } } };
const sync = new DebouncedFrontmatterSync(app, 5);
sync.queue(file, { status: 'running', evalScore: 0.4, lastRun: '2026-07-25T10:00:00.000Z' });
sync.queue(file, { status: 'completed', evalScore: 0.9, lastRun: '2026-07-25T11:00:00.000Z' });
await sync.flush();
assert.equal(writes, 1);
assert.deepEqual(frontmatter, { keep: true, agent_status: 'completed', agent_eval_score: 0.9, agent_last_run: '2026-07-25T11:00:00.000Z' });
pass('24b: rapid same-note state updates debounce into one write with the latest context');
}
{
const file = { path: 'Tasks/optional.md', extension: 'md' };
const frontmatter = { owner: 'Ada', agent_eval_score: 0.7, agent_last_run: 'existing' };
const app = { fileManager: { async processFrontMatter(_file, mutate) { mutate(frontmatter); } } };
await updateNoteAgentState(file, app, { status: 'failed' });
assert.deepEqual(frontmatter, { owner: 'Ada', agent_status: 'failed', agent_eval_score: 0.7, agent_last_run: 'existing' });
pass('24c: omitted optional state values preserve existing agent score and timestamp');
}
}

/* ═══ 25. Chat Context Resolution ═══ */
async function verifyChatContext() {
console.log('\n─── 25. Chat Context Resolution ───');
const { resolveChatContext } = await import(pathToFileURL(SRC + '/ui/chat-context.ts').href);
const files = {
  'Notes/Alpha.md': { path: 'Notes/Alpha.md', name: 'Alpha.md', basename: 'Alpha', extension: 'md' },
  'Queues/Inbox.base': { path: 'Queues/Inbox.base', name: 'Inbox.base', basename: 'Inbox', extension: 'base' },
  'Tasks/one.md': { path: 'Tasks/one.md', name: 'one.md', basename: 'one', extension: 'md' },
};
const contents = {
  'Notes/Alpha.md': 'Alpha body\nwith details.',
  'Queues/Inbox.base': 'filters:\n  and:\n    - status == "todo"',
};
const activeFile = { path: 'Current.md', name: 'Current.md', basename: 'Current', extension: 'md' };
const app = {
  workspace: {
    activeEditor: { editor: { getSelection: () => 'selected paragraph' } },
    getActiveFile: () => activeFile,
  },
  vault: {
    getAbstractFileByPath: path => files[path] ?? null,
    read: async file => contents[file.path] ?? '',
    getMarkdownFiles: () => [files['Notes/Alpha.md'], files['Tasks/one.md']],
  },
  metadataCache: {
    getFirstLinkpathDest: ref => ref === 'Alpha' || ref === 'Alpha.md' ? files['Notes/Alpha.md'] : null,
    getFileCache: file => ({ frontmatter: file.path === 'Tasks/one.md' ? { status: 'todo', priority: 2 } : {} }),
  },
};
{
const result = await resolveChatContext(app, 'Compare @Alpha with @Notes/Alpha.md please');
assert.equal(result.cleanedPrompt, 'Compare with please');
assert.deepEqual(result.attachments.map(item => item.type), ['selection', 'note']);
assert.equal(result.attachments.filter(item => item.name === 'Alpha').length, 1);
assert.ok(result.contextString.startsWith('# Attached context\n\n## [Selection]\nselected paragraph'));
assert.ok(result.contextString.includes('## Note: Notes/Alpha.md\nAlpha body\nwith details.'));
pass('25a: @ note mentions resolve, deduplicate, clean the prompt, and format selection/note context');
}
{
const result = await resolveChatContext(app, 'Review @Missing and keep going');
assert.equal(result.cleanedPrompt, 'Review @Missing and keep going');
assert.deepEqual(result.attachments, [{ name: 'Selection', type: 'selection' }]);
assert.ok(!result.contextString.includes('Missing'));
pass('25b: missing file mentions remain in the prompt without creating attachments');
}
{
const { setBaseYamlParserForTests } = await import(pathToFileURL(SRC + '/workflows/base-queue.ts').href);
setBaseYamlParserForTests(() => ({ filters: { status: 'todo' } }));
try {
  const result = await resolveChatContext(app, 'Process @Queues/Inbox.base now');
  assert.equal(result.cleanedPrompt, 'Process now');
  assert.deepEqual(result.attachments.map(item => item.type), ['selection', 'base']);
  assert.ok(result.contextString.includes('## Base queue: Queues/Inbox.base'));
  assert.ok(result.contextString.includes('- Tasks/one.md (status=todo, priority=2)'));
  assert.ok(result.contextString.includes('\n\n---\n\n'));
  pass('25c: .base mentions use parseBaseQueue and format queue metadata as context');
} finally { setBaseYamlParserForTests(null); }
}
{
const result = await resolveChatContext(app, 'Summarize @Alpha, then @<Notes/Alpha.md>.');
assert.equal(result.cleanedPrompt, 'Summarize , then .');
assert.equal(result.attachments.filter(item => item.type === 'note').length, 1);
assert.ok(result.contextString.includes('## [Selection]\nselected paragraph\n\n---\n\n## Note: Notes/Alpha.md'));
pass('25d: mention boundaries and formatted context separators remain stable');
}
}

/* ═══ 26. Chat Action Card ═══ */
async function verifyChatActionCard() {
console.log('\n─── 26. Chat Action Card ───');
class FakeElement {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.classes = new Set(); this.listeners = new Map(); this.disabled = false; this.textContent = ''; }
  createDiv(options = {}) { return this.createEl('div', options); }
  createSpan(options = {}) { return this.createEl('span', options); }
  createEl(tag, options = {}) { const child = new FakeElement(tag); child.textContent = options.text ?? ''; for (const cls of (options.cls ?? '').split(/\s+/).filter(Boolean)) child.classes.add(cls); this.children.push(child); return child; }
  addClass(cls) { this.classes.add(cls); }
  setText(text) { this.textContent = text; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); }
  click() { this.listeners.get('click')?.(); }
}
const { ChatActionCard } = await import(pathToFileURL(SRC + '/ui/chat-action-card.ts').href);
{
const root = new FakeElement();
const card = new ChatActionCard(root, { toolName: 'write_note', targetPaths: ['A.md', 'B.md'], proposedChanges: '- old\n+ new', timeoutMs: 5000 });
assert.equal(root.children.length, 1);
assert.equal(card.getState(), 'pending');
assert.ok(card.element.children.some(child => child.textContent === 'Tool: write_note'));
assert.ok(card.element.children.some(child => child.classes.has('cc-chat-action-targets')));
assert.ok(card.element.children.some(child => child.classes.has('cc-chat-action-changes')));
card.approve();
assert.equal(await card.wait(), 'approved');
assert.equal(card.getState(), 'approved');
assert.ok(card.element.classes.has('is-approved'));
card.reject();
assert.equal(card.getState(), 'approved');
card.dispose();
pass('26a: action card renders tool, targets, proposed diff, and settles approval once');
}
{
const rejected = new ChatActionCard(new FakeElement(), { toolName: 'delete_note', targetPaths: ['old.md'], proposedChanges: 'Delete old.md', timeoutMs: 5000 });
rejected.reject();
assert.equal(await rejected.wait(), 'rejected');
assert.equal(rejected.getState(), 'rejected');
const timed = new ChatActionCard(new FakeElement(), { toolName: 'bulk_edit', targetPaths: ['a.md'], proposedChanges: 'edit', timeoutMs: 0 });
assert.equal(await timed.wait(), 'timed-out');
assert.equal(timed.getState(), 'timed-out');
rejected.dispose(); timed.dispose();
pass('26b: rejection and timeout resume paused execution with distinct terminal states');
}
}

/* ═══ 27. JIT Model Lifecycle ═══ */
async function verifyJitModels() {
console.log('\n─── 27. JIT Model Lifecycle ───');
const { JitModelManager } = await import(pathToFileURL(SRC + '/providers/jit-manager.ts').href);
const { ModelRouter } = await import(pathToFileURL(SRC + '/routing/ModelRouter.ts').href);
{
const requests = [];
const manager = new JitModelManager({ fetch: async (url, init) => {
  requests.push({ url, init, body: JSON.parse(init.body) });
  return new Response('{}', { status: 200 });
} });
assert.equal(await manager.loadModel('http://localhost:1234/v1/', 'qwen-react', 420), true);
assert.equal(requests[0].url, 'http://localhost:1234/api/v1/models/load');
assert.equal(requests[0].init.method, 'POST');
assert.equal(requests[0].init.headers['Content-Type'], 'application/json');
assert.deepEqual(requests[0].body, { model: 'qwen-react', ttl: 420 });
assert.equal(await manager.unloadModel('http://localhost:1234/api/v1', 'instance-7'), true);
assert.equal(requests[1].url, 'http://localhost:1234/api/v1/models/unload');
assert.deepEqual(requests[1].body, { instance_id: 'instance-7' });
pass('27a: LM Studio pre-warm and unload payloads normalize local API URLs');
}
{
const requests = [];
const ollama = new JitModelManager({ fetch: async (url, init) => {
  requests.push({ url, body: JSON.parse(init.body) });
  return new Response('{}', { status: 200 });
} });
assert.equal(await ollama.loadModel('http://localhost:11434/v1', 'qwen-local', 300), true);
assert.equal(requests[0].url, 'http://localhost:11434/api/generate');
assert.deepEqual(requests[0].body, { model: 'qwen-local', prompt: '', stream: false, options: { num_predict: 0 }, keep_alive: 300 });
assert.equal(await ollama.unloadModel('http://localhost:11434', 'qwen-local'), true);
assert.deepEqual(requests[1].body, { model: 'qwen-local', prompt: '', stream: false, keep_alive: 0 });
pass('27b: Ollama pre-warm and unload use keep_alive retention controls');
}
{
const offline = new JitModelManager({ fetch: async () => { throw new TypeError('fetch failed'); } });
assert.equal(await offline.loadModel('http://localhost:1234', 'offline-model'), false);
assert.equal(await offline.unloadModel('http://localhost:1234', 'offline-model'), false);
let aborted = false;
const timed = new JitModelManager({ timeoutMs: 5, fetch: async (_url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Timed out', 'AbortError')); }, { once: true });
}) });
assert.equal(await timed.loadModel('http://localhost:1234', 'slow-model'), false);
assert.equal(aborted, true);
pass('27c: offline and timed-out local model management degrade to false');
}
{
const events = [];
const jitModelManager = {
  ensureModelLoaded: async (url, model, ttl) => { events.push(['load', url, model, ttl]); return true; },
  evictModel: async (url, model) => { events.push(['unload', url, model]); return true; },
};
const factory = { jitModelManager, getBaseUrl: () => 'http://localhost:1234/v1' };
const settings = {
  credentials: {}, defaults: {}, fallback: {}, optimization: {},
  routing: { reasoning: { taskType: 'reasoning', providerId: 'lmstudio', modelId: 'qwen-react', config: { ttl: 180 } } },
};
const router = new ModelRouter(factory, () => settings, () => []);
assert.equal(await router.withJitModel('reasoning', async () => { events.push(['work']); return 'done'; }), 'done');
assert.deepEqual(events, [
  ['load', 'http://localhost:1234/v1', 'qwen-react', 180],
  ['work'],
  ['unload', 'http://localhost:1234/v1', 'qwen-react'],
]);
events.length = 0;
await assert.rejects(() => router.withJitModel('reasoning', async () => { events.push(['failed-work']); throw new Error('session failed'); }), /session failed/);
assert.deepEqual(events.map(event => event[0]), ['load', 'failed-work', 'unload']);
events.length = 0;
jitModelManager.ensureModelLoaded = async () => false;
assert.equal(await router.withJitModel('reasoning', async () => { events.push(['fallback-work']); return 'fallback'; }), 'fallback');
assert.deepEqual(events, [['fallback-work'], ['unload', 'http://localhost:1234/v1', 'qwen-react']]);
pass('27d: heavy workload wrapper cleans up and continues when pre-warming fails');
}
}

/* ═══ 28. Audio Recording & Transcription ═══ */
async function verifyAudio() {
console.log('\n─── 28. Audio Recording & Transcription ───');
const { AudioRecorder } = await import(pathToFileURL(SRC + '/audio/audio-recorder.ts').href);
const { TranscriberAdapter, TranscriptionError } = await import(pathToFileURL(SRC + '/audio/transcriber.ts').href);
const { OpenAICompatibleProvider } = await import(pathToFileURL(SRC + '/providers/openai-compatible.ts').href);
const { PROVIDER_REGISTRY } = await import(pathToFileURL(SRC + '/providers/provider-registry.ts').href);
const { DEFAULT_PROVIDER_CONFIG, isLocalBaseUrl } = await import(pathToFileURL(SRC + '/providers/provider-types.ts').href);
{
class InspectableOpenAIProvider extends OpenAICompatibleProvider {
  payload(config) { return this.buildRequestBody([{ role: 'user', content: 'hello' }], 'local-model', config); }
}
const config = { temperature: 0.2, maxTokens: 100, topP: 1, stop: [], extra: {}, ttl: 300, keepAlive: '5m' };
const local = new InspectableOpenAIProvider({ id: 'lmstudio', meta: PROVIDER_REGISTRY.lmstudio, getApiKey: () => '', getBaseUrl: () => 'http://localhost:1234/v1' });
assert.equal(local.payload(config).ttl, 300);
assert.equal('keep_alive' in local.payload(config), false);
// The same provider dispatch boundary is used by Quick Chat/Conversation,
// ReAct-routed completions, Workflow steps, and Base target loops.
for (const entryPoint of ['quick-chat', 'react-worker', 'workflow-step', 'base-target']) {
  const payload = local.payload({ ...config, extra: { entryPoint } });
  assert.equal(payload.ttl, 300); assert.equal('keep_alive' in payload, false);
}
const loopback = new InspectableOpenAIProvider({ id: 'ollama', meta: PROVIDER_REGISTRY.ollama, getApiKey: () => '', getBaseUrl: () => 'http://127.0.0.1:11434/v1' });
assert.equal(loopback.payload({ ...config, keepAlive: 300 }).keep_alive, 300);
const lan = new InspectableOpenAIProvider({ id: 'custom', meta: PROVIDER_REGISTRY.custom, getApiKey: () => '', getBaseUrl: () => 'http://192.168.1.25:8080/v1' }); // SANITIZE_ALLOW: synthetic RFC 1918 fixture
assert.equal(lan.payload(DEFAULT_PROVIDER_CONFIG).ttl, 300);
assert.equal(isLocalBaseUrl('http://10.0.0.7:11434'), true); // SANITIZE_ALLOW: synthetic RFC 1918 fixture
assert.equal(isLocalBaseUrl('https://localhost.evil.example/v1'), false);
for (const [id, baseUrl] of [
  ['openai', 'https://api.openai.com/v1'],
  ['groq', 'https://api.groq.com/openai/v1'],
]) {
  const cloud = new InspectableOpenAIProvider({ id, meta: PROVIDER_REGISTRY[id], getApiKey: () => 'key', getBaseUrl: () => baseUrl });
  const payload = cloud.payload({ ...config, extra: { ttl: 9, keep_alive: 0 } });
  assert.equal('ttl' in payload, false);
  assert.equal('keep_alive' in payload, false);
}
const anthropicSource = await readFile(join(SRC, 'providers', 'anthropic.ts'), 'utf8');
assert.equal(/keep_alive\s*:|\bttl\s*:/.test(anthropicSource), false);
pass('27a: local Quick/ReAct/Workflow payloads receive JIT fields while OpenAI, Groq, and Anthropic remain clean');
}
{
const originalNavigator = globalThis.navigator;
const originalMediaRecorder = globalThis.MediaRecorder;
let trackStopped = false;
class MockMediaRecorder extends EventTarget {
  static isTypeSupported(type) { return type === 'audio/webm'; }
  constructor(stream, options) { super(); this.stream = stream; this.mimeType = options.mimeType || 'audio/webm'; this.state = 'inactive'; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    for (const text of ['hello ', 'audio']) {
      const event = new Event('dataavailable');
      Object.defineProperty(event, 'data', { value: new Blob([text], { type: this.mimeType }) });
      this.dispatchEvent(event);
    }
    this.dispatchEvent(new Event('stop'));
  }
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { trackStopped = true; } }] }) } } });
globalThis.MediaRecorder = MockMediaRecorder;
try {
  const states = [];
  const durations = [];
  const recorder = new AudioRecorder({ mimeType: 'audio/webm', onStateChange: state => states.push(state), onDurationChange: duration => durations.push(duration) });
  await recorder.start();
  assert.equal(recorder.isRecording(), true);
  const audio = await recorder.stop();
  assert.equal(audio.type, 'audio/webm');
  assert.equal(await audio.text(), 'hello audio');
  assert.equal(audio.size, 11);
  assert.equal(trackStopped, true);
  assert.equal(recorder.isRecording(), false);
  assert.ok(durations.length >= 1); assert.equal(durations[0], 0);
  assert.deepEqual(states, ['requesting-permission', 'recording', 'stopping', 'idle']);
} finally {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
  globalThis.MediaRecorder = originalMediaRecorder;
}
pass('27b: recorder combines audio chunks and releases microphone stream');
}
{
const originalNavigator = globalThis.navigator;
const originalMediaRecorder = globalThis.MediaRecorder;
let trackStopped = false;
class ErrorMediaRecorder extends EventTarget {
  static isTypeSupported() { return true; }
  constructor() { super(); this.mimeType = 'audio/webm'; }
  start() { queueMicrotask(() => { const event = new Event('error'); Object.defineProperty(event, 'error', { value: new Error('device lost') }); this.dispatchEvent(event); }); }
  stop() {}
}
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { trackStopped = true; } }] }) } } });
globalThis.MediaRecorder = ErrorMediaRecorder;
try {
  const recorder = new AudioRecorder();
  await recorder.start();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(recorder.isRecording(), false);
  assert.equal(trackStopped, true);
  await assert.rejects(() => recorder.stop(), /device lost/);
} finally {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
  globalThis.MediaRecorder = originalMediaRecorder;
}
pass('27c: asynchronous recorder errors release microphone hardware');
}
{
const settings = { credentials: { groq: { providerId: 'groq', apiKey: 'first-key', baseUrl: 'https://api.groq.com/openai/v1', enabled: true } }, routing: {}, fallback: {}, defaults: {} }; // SANITIZE_ALLOW: synthetic non-secret fixture
let captured;
const adapter = new TranscriberAdapter({ providerId: 'groq', getSettings: () => settings, defaultModel: 'whisper-large-v3', fetch: async (url, init) => {
  captured = { url, init };
  return new Response(JSON.stringify({ text: 'transcribed words' }), { status: 200, headers: { 'content-type': 'application/json' } });
} });
const result = await adapter.transcribe(new Blob(['webm-bytes'], { type: 'audio/webm' }), { language: 'en', prompt: 'Names', temperature: 0 });
assert.equal(result, 'transcribed words');
assert.equal(captured.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
assert.equal(captured.init.method, 'POST');
assert.equal(captured.init.headers.Authorization, 'Bearer first-key');
assert.ok(captured.init.body instanceof FormData);
assert.equal(captured.init.body.get('model'), 'whisper-large-v3');
assert.equal(captured.init.body.get('language'), 'en');
assert.equal(captured.init.body.get('prompt'), 'Names');
assert.equal(captured.init.body.get('temperature'), '0');
assert.equal(captured.init.body.has('ttl'), false);
assert.equal(captured.init.body.has('keep_alive'), false);
const file = captured.init.body.get('file');
assert.ok(file instanceof Blob); assert.equal(file.type, 'audio/webm'); assert.equal(await file.text(), 'webm-bytes');
pass('27d: cloud multipart payload omits local JIT retention controls');
}
{
let calls = 0;
const settings = { credentials: { custom: { providerId: 'custom', apiKey: 'old', baseUrl: 'http://localhost:8080', enabled: true } }, routing: {}, fallback: {}, defaults: {} };
const adapter = new TranscriberAdapter({ providerId: 'custom', getSettings: () => settings, maxAttempts: 2, backoffMs: 0, fetch: async (url, init) => {
  if (!String(url).includes('/audio/transcriptions')) return new Response('{}', { status: 404 });
  calls++;
  if (calls === 1) { settings.credentials.custom.apiKey = 'new'; return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), { status: 503 }); }
  assert.equal(init.headers.Authorization, 'Bearer new');
  return new Response('recovered transcript', { status: 200, headers: { 'content-type': 'text/plain' } });
} });
assert.equal(await adapter.transcribe(new Blob(['wav'], { type: 'audio/wav' })), 'recovered transcript');
assert.equal(calls, 2);
const wavForm = adapter.buildFormData(new Blob(['wav'], { type: 'audio/wav' }));
assert.equal(wavForm.get('file').name, 'recording.webm');
let permanentCalls = 0;
const permanent = new TranscriberAdapter({ providerId: 'custom', getSettings: () => settings, maxAttempts: 3, backoffMs: 0, fetch: async (url) => {
  if (!String(url).includes('/audio/transcriptions')) return new Response('{}', { status: 404 });
  permanentCalls++; return new Response('bad audio', { status: 400 });
} });
await assert.rejects(() => permanent.transcribe(new Blob(['bad'], { type: 'audio/wav' })), error => error instanceof TranscriptionError && error.status === 400 && !error.retryable);
assert.equal(permanentCalls, 1);
const configuredSettings = { ...settings, defaults: { transcriptionModel: 'configured-whisper' } };
const configured = new TranscriberAdapter({ providerId: 'custom', getSettings: () => configuredSettings });
assert.equal(configured.buildFormData(new Blob(['audio'], { type: 'audio/webm' })).get('model'), 'configured-whisper');
const defaultAdapter = new TranscriberAdapter({ providerId: 'custom', getSettings: () => settings });
const defaultForm = defaultAdapter.buildFormData(new Blob(['audio'], { type: 'audio/webm' }));
assert.equal(defaultForm.get('model'), 'whisper-large-v3-turbo');
assert.equal(defaultForm.get('file').name, 'recording.webm');
pass('27e: transient errors retry with fresh settings while permanent errors fail fast');
}
{
const settings = { credentials: { lmstudio: { providerId: 'lmstudio', apiKey: '', baseUrl: 'http://localhost:1234/v1', enabled: true } }, routing: {}, fallback: {}, defaults: {} };
const requests = [];
const adapter = new TranscriberAdapter({ providerId: 'lmstudio', getSettings: () => settings, fetch: async (url, init) => {
  requests.push({ url, init });
  if (init.method === 'GET') return new Response(JSON.stringify({ data: [{ id: 'text-model' }, { id: 'whisper-local-large' }, { id: 'speech-to-text-fast' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ text: ' local transcript ' }), { status: 200, headers: { 'content-type': 'application/json' } });
} });
assert.deepEqual(await adapter.fetchLiveAudioModels(), ['whisper-local-large', 'speech-to-text-fast']);
assert.equal(requests[0].url, 'http://localhost:1234/v1/models');
assert.equal(await adapter.transcribe(new Blob(['audio'], { type: 'audio/webm' }), 'missing-model'), 'local transcript');
assert.equal(requests[1].url, 'http://localhost:1234/v1/audio/transcriptions');
assert.equal(requests[1].init.body.get('model'), 'whisper-local-large');
assert.equal(requests[1].init.body.get('ttl'), '300');
assert.equal(requests[1].init.body.has('keep_alive'), false);
assert.equal(requests[1].init.body.get('file').name, 'recording.webm');
pass('27f: local audio requests include JIT TTL and select a loaded STT fallback');
const empty = new TranscriberAdapter({ providerId: 'lmstudio', getSettings: () => settings, fetch: async (_url, init) => init.method === 'GET'
  ? new Response(JSON.stringify({ data: [{ id: 'llama-text-only' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  : new Response(JSON.stringify({ text: 'implicit model' }), { status: 200, headers: { 'content-type': 'application/json' } }) });
assert.deepEqual(await empty.fetchLiveAudioModels(), []);
const emptyForm = empty.buildFormData(new Blob(['audio'], { type: 'audio/webm' }));
assert.equal(emptyForm.has('model'), false);
assert.equal(await empty.transcribe(new Blob(['audio'], { type: 'audio/webm' })), 'implicit model');
pass('27g: empty local STT catalog omits model for endpoint-selected fallback');
}
{
const modalSource = await readFile(join(SRC, 'ui', 'voice-prompt-modal.ts'), 'utf8');
assert.match(modalSource, /void this\.beginRecording\(\)/);
assert.match(modalSource, /recorder\?\.isRecording\(\).*recorder\.stop\(\)/s);
assert.match(modalSource, /onDurationChange:[\s\S]*onAudioLevel:/);
assert.match(modalSource, /transcriptionAbort\?\.abort\(\)/);
assert.match(modalSource, /recorder\?\.isRecording\(\).*recorder\.stop\(\)/s);
pass('27h: voice modal auto-starts recording, aborts transcription, and tears down capture on cancellation');
assert.match(modalSource, /Done & Send/);
assert.match(modalSource, /Transcribing audio\.\.\./);
assert.match(modalSource, /resolveChatContext\(this\.plugin\.app, spokenText\)/);
assert.match(modalSource, /dispatchVoicePrompt\(this\.mode, spokenText, resolved\)/);
assert.match(modalSource, /fetchLiveAudioModels\(\)/);
assert.match(modalSource, /cc-voice-mode-select/);
assert.match(modalSource, /cc-voice-stt-badge/);
pass('27i: voice modal discovers STT, transcribes, resolves context, and dispatches selected dropdown mode');
const commandSource = await readFile(join(SRC, 'commands.ts'), 'utf8');
const mainSource = await readFile(join(SRC, 'main.ts'), 'utf8');
assert.match(commandSource, /name: 'Quick Voice Prompt'/);
assert.match(mainSource, /mode === 'workflow'/);
assert.match(mainSource, /mode === 'react'/);
assert.match(mainSource, /executeProviderTurn/);
pass('27j: global voice command routes Quick, ReAct, and Workflow modes');
}
}

/* ═══ 29. Hybrid RAG ═══ */
async function verifyHybridRag() {
console.log('\n─── 29. Hybrid RAG ───');
const { MarkdownChunker } = await import(pathToFileURL(SRC + '/rag/chunker.ts').href);
const { EmbeddingAdapter } = await import(pathToFileURL(SRC + '/rag/embeddings.ts').href);
const { bm25TermScore } = await import(pathToFileURL(SRC + '/rag/hybrid-retriever.ts').href);
{
const words = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ');
const markdown = `# Project\n${words('alpha', 310)}\n\n## Decisions\nSee [[Architecture Note|the architecture]] for context. ${words('beta', 320)}`;
const chunks = new MarkdownChunker().chunk(markdown, 'Projects/plan.md');
assert.equal(chunks.length, 2);
assert.ok(chunks.every(chunk => chunk.wordCount >= 300 && chunk.wordCount <= 500));
assert.deepEqual(chunks[0].metadata, { filePath: 'Projects/plan.md', heading: 'Project', startLine: 1, endLine: 2 });
assert.equal(chunks[1].metadata.heading, 'Project > Decisions');
assert.equal(chunks[1].metadata.startLine, 4);
assert.ok(chunks[1].text.includes('[[Architecture Note|the architecture]]'));
pass('29a: Markdown chunks preserve 300–500 word boundaries, hierarchy, lines, and wikilinks');
}
{
const requests = [];
const adapter = new EmbeddingAdapter({ baseUrl: 'http://localhost:11434/v1/', apiKey: 'local-key', fetch: async (url, init) => { // SANITIZE_ALLOW: synthetic non-secret fixture
  requests.push({ url, init });
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }, { index: 1, embedding: [0.3, 0.4] }] }), { status: 200 });
} });
const built = adapter.buildRequest(['one', 'two']);
assert.equal(built.url, 'http://localhost:11434/v1/embeddings');
assert.deepEqual(built.body, { model: 'nomic-embed-text', input: ['one', 'two'], encoding_format: 'float', keep_alive: '5m' });
assert.equal(built.init.headers.Authorization, 'Bearer local-key');
const lmRequest = new EmbeddingAdapter({ baseUrl: 'http://localhost:1234/v1', model: 'local-embed', ttl: 420 }).buildRequest('text');
assert.equal(lmRequest.body.ttl, 420); assert.equal('keep_alive' in lmRequest.body, false);
const cloudRequest = new EmbeddingAdapter({ baseUrl: 'https://api.openai.com', ttl: 9, keepAlive: 0 }).buildRequest('text');
assert.equal('ttl' in cloudRequest.body, false); assert.equal('keep_alive' in cloudRequest.body, false);
const result = await adapter.embed(['one', 'two']);
assert.equal(result.source, 'remote'); assert.deepEqual(result.vectors, [[0.1, 0.2], [0.3, 0.4]]);
assert.deepEqual(JSON.parse(requests[0].init.body), built.body);
const offline = new EmbeddingAdapter({ baseUrl: 'http://localhost:1234', fetch: async () => { throw new Error('offline'); } });
const fallback = await offline.embed('repeat repeat unique');
assert.equal(fallback.source, 'term-frequency'); assert.equal(fallback.vectors[0].length, 256);
pass('29b: embedding payload applies local JIT retention, strips cloud fields, and falls back to local TF');
}
{
const relevant = bm25TermScore(3, 100, 10, 2, 100);
const oneHit = bm25TermScore(1, 100, 10, 2, 100);
const common = bm25TermScore(3, 100, 10, 9, 100);
const longDocument = bm25TermScore(3, 300, 10, 2, 100);
assert.ok(relevant > oneHit, 'term frequency should improve BM25 score');
assert.ok(relevant > common, 'rare terms should have greater IDF');
assert.ok(relevant > longDocument, 'length normalization should penalize long documents');
assert.equal(bm25TermScore(0, 100, 10, 2, 100), 0);
pass('29c: BM25 scoring applies TF saturation, IDF, and document-length normalization');
}
}

/* ═══ 30. Persistent Agent Memory ═══ */
async function verifyAgentMemory() {
console.log('\n─── 30. Persistent Agent Memory ───');
const { AgentMemoryStore, AGENT_MEMORY_PATH } = await import(pathToFileURL(SRC + '/memory/memory-store.ts').href);
const files = new Map();
const folders = new Set();
const vault = {
  getAbstractFileByPath(path) { return folders.has(path) ? { path, type: 'folder' } : files.has(path) ? { path } : null; },
  async createFolder(path) { folders.add(path); return { path }; },
  async create(path, content) { const file = { path }; files.set(path, content); return file; },
  async modify(file, content) { files.set(file.path, content); },
  async read(file) { return files.get(file.path); },
};
const store = new AgentMemoryStore({ vault });
await store.ready();
{
await store.addFact('preferences', 'Preferred editor', 'Vim');
await store.addFact('preferences', 'editor preferred', 'Neovim');
await store.addFact('entities', 'Project Atlas', 'A private TypeScript knowledge tool');
assert.equal(store.getFacts('preferences').length, 1);
assert.equal(store.getFacts('preferences')[0].value, 'Neovim');
await store.flushToDisk();
assert.ok(folders.has('.command-center')); assert.ok(files.has(AGENT_MEMORY_PATH));
const persisted = JSON.parse(files.get(AGENT_MEMORY_PATH));
assert.equal(persisted.version, 1); assert.equal(persisted.entries.length, 2);
pass('30a: memory semantically updates duplicate preferences and persists through vault APIs');
}
{
const results = store.searchMemory('Atlas TypeScript');
assert.equal(results[0].key, 'Project Atlas');
await store.summarizeSession('session-1', [
  { role: 'user', content: 'Plan the Atlas release.' },
  { role: 'assistant', content: 'Release checklist created.' },
]);
assert.match(store.getFacts('sessions')[0].value, /Release checklist created/);
const prompt = store.getSystemMemoryPrompt('editor Atlas');
assert.match(prompt, /^## Persistent Memory/m);
assert.match(prompt, /### Preferences/); assert.match(prompt, /Neovim/);
assert.match(prompt, /### Entities/); assert.doesNotMatch(prompt, /Release checklist created/);
pass('30b: query search, session summaries, and concise system-memory formatting work');
}
{
await store.flushToDisk();
const restored = new AgentMemoryStore({ vault });
await restored.ready();
assert.equal(restored.getFacts('preferences')[0].value, 'Neovim');
assert.equal(restored.searchMemory('private knowledge tool')[0].key, 'Project Atlas');
pass('30c: persisted memory rehydrates from the vault file');
}
}

/* ═══ 31. RAG Agent Tool & Prompt Context ═══ */
async function verifyRagAgentIntegration() {
console.log('\n─── 31. RAG Agent Tool & Prompt Context ───');
const { VaultSearchTool, injectRagContext } = await import(pathToFileURL(SRC + '/rag/rag-tool.ts').href);
const sampleMatch = {
  score: 0.91, bm25Score: 2, vectorScore: 0.8,
  chunk: { text: 'The deployment uses blue-green releases.', metadata: { filePath: 'Ops/Deploy.md', heading: 'Release > Production', startLine: 10, endLine: 18 } },
};
{
let passedQuery, passedLimit;
const retriever = { search: async (query, limit) => { passedQuery = query; passedLimit = limit; return [sampleMatch]; } };
const tool = new VaultSearchTool(retriever).toToolDefinition();
assert.equal(tool.name, 'searchVault'); assert.deepEqual(tool.parameters.required, ['query']);
assert.equal(tool.parameters.properties.limit.default, 3);
const output = await tool.execute('call-1', { query: 'production deployment', limit: 3 });
assert.equal(passedQuery, 'production deployment'); assert.equal(passedLimit, 3);
assert.match(output.content[0].text, /\[\[Ops\/Deploy\.md\]\][\s\S]*Release > Production/);
assert.match(output.content[0].text, /blue-green releases/); assert.equal(output.details.matchCount, 1);
const emptyTool = new VaultSearchTool({ search: async () => [] }).toToolDefinition();
assert.match((await emptyTool.execute('call-2', { query: 'missing' })).content[0].text, /No relevant vault content/);
pass('31a: searchVault validates schema, passes query parameters, and formats cited chunks/empty results');
}
{
let searchOptions;
const scopedRetriever = {
  search: async (_query, options) => { searchOptions = options; return [sampleMatch]; },
  formatContext: matches => matches.map(match => match.chunk.text).join('\n'),
};
const scopedTool = new VaultSearchTool(scopedRetriever).toToolDefinition();
await scopedTool.execute('call-scoped', { query: 'deployment', folderScope: ['Ops', 'Projects'], limit: 2 });
assert.deepEqual(searchOptions, { limit: 2, folders: ['Ops', 'Projects'] });
const bounded = await injectRagContext(scopedRetriever, 'deployment', {
  existingContext: '## Memory\nRemember production constraints.', folderScope: 'Ops', charBudget: 180,
});
assert.ok(bounded.startsWith('<context>\n')); assert.ok(bounded.endsWith('\n</context>'));
assert.ok(bounded.length <= 180); assert.match(bounded, /Relevant Vault Context/);
pass('31a.1: folder scopes reach hybrid search and injected context obeys its complete-block budget');
}
{
const { filterToolsForRole } = await import(pathToFileURL(SRC + '/react/react-roles.ts').href);
const tool = new VaultSearchTool({ search: async () => [] }).toToolDefinition();
assert.ok(filterToolsForRole('researcher', [tool]).some(candidate => candidate.name === 'searchVault'));
let captured;
const selectingTool = new VaultSearchTool({ search: async (query, limit) => { captured = { query, limit }; return []; } }).toToolDefinition();
await selectingTool.execute('react-tool-call', { query: 'architecture decision', limit: 4 });
assert.deepEqual(captured, { query: 'architecture decision', limit: 4 });
pass('31b: ReAct researcher policy exposes searchVault and forwards model-selected arguments');
}
{
const { ConversationManager } = await import(pathToFileURL(SRC + '/conversation.ts').href);
let providerRequest;
const dispatcher = { dispatch: async request => { providerRequest = request; return { success: true, output: 'ok' }; } };
const memory = { getSystemMemoryPrompt: () => '## Persistent Memory\n- **Editor:** Neovim', summarizeSession: async () => ({}) };
const retriever = { search: async () => [sampleMatch], formatContext: matches => matches.map(match => `[${match.chunk.metadata.filePath}]\n${match.chunk.text}`).join('\n') };
const conversations = new ConversationManager({}, undefined, memory, retriever, 1000);
await conversations.executeProviderTurn(dispatcher, 'How is production deployed?');
assert.match(providerRequest.systemPrompt, /<context>[\s\S]*Persistent Memory/);
assert.match(providerRequest.systemPrompt, /Relevant Vault Context[\s\S]*Ops\/Deploy\.md/);
assert.match(providerRequest.systemPrompt, /<\/context>/);
const { PiAgentDaemon } = await import(pathToFileURL(SRC + '/daemon.ts').href);
const daemon = new PiAgentDaemon('.', 'pi'); daemon.setMemoryStore(memory); daemon.setRetriever(retriever, 1000);
const agentContext = await daemon.buildPassiveContext('production deployment');
assert.match(agentContext, /<context>[\s\S]*Persistent Memory/);
assert.match(agentContext, /Relevant Vault Context[\s\S]*blue-green releases/);
pass('31c: chat and ReAct loops inject bounded RAG plus persistent memory context blocks');
}
}

/* ═══ 32. Headless CLI Command Bridge ═══ */
async function verifyHeadlessCliBridge() {
console.log('\n─── 32. Headless CLI Command Bridge ───');
const { CommandCenterCommandBridge } = await import(pathToFileURL(SRC + '/cli/command-bridge.ts').href);
{
const registrations = [];
const app = {};
const plugin = {
  app,
  requireInitialized: () => ({ managedFolders: [{ path: 'Projects' }, { path: 'Areas' }] }),
  dailyEngine: {
    ready: async () => undefined,
    generateInboxProposals: async () => [{ id: 'proposal' }],
    assembleDailyNote: async metrics => ({ path: 'Daily/Today.md', created: true, capacity: { score: 1, priorityCap: 3 }, metrics }),
  },
  folderIndexer: {
    verifyIndexAnchors: async () => undefined,
    update: async path => ({ indexPath: `${path}/_index.md`, operation: 'updated', fileCount: 2 }),
  },
  registerObsidianProtocolHandler: (action, handler) => registrations.push(['uri', action, handler]),
  registerCliHandler: (command, _description, _flags, handler) => registrations.push(['cli', command, handler]),
};
const bridge = new CommandCenterCommandBridge(plugin);
bridge.register();
assert.deepEqual(registrations.map(item => item.slice(0, 2)), [
  ['uri', 'command-center'], ['cli', 'command-center:morning'], ['cli', 'command-center:workflow'], ['cli', 'command-center:indexes'],
]);
const morning = await bridge.execute('morning', { metrics: '{"energy":8}', date: '2026-07-26' });
assert.equal(morning.ok, true); assert.equal(morning.result.dailyNote, 'Daily/Today.md'); assert.equal(morning.result.pendingInboxProposals, 1);
const indexes = await bridge.execute('indexes');
assert.equal(indexes.ok, true); assert.equal(indexes.result.refreshed, 2); assert.equal(indexes.result.indexes[0].path, 'Projects/_index.md');
pass('32a: native CLI and URI hooks run daily/index operations without workspace leaves');
}
{
const app = {};
const plugin = { app, requireInitialized: () => { throw new Error('Command Center is uninitialized.'); } };
const bridge = new CommandCenterCommandBridge(plugin);
const result = await bridge.execute('indexes');
assert.equal(result.ok, false); assert.match(result.error, /uninitialized/);
const credential = await bridge.execute('morning', { apiKey: 'must-not-enter-cli' }); // SANITIZE_ALLOW: rejection-path fixture
assert.equal(credential.ok, false); assert.match(credential.error, /Credentials are not accepted/);
pass('32b: headless commands enforce configuration and reject credential arguments');
}
}

async function main(){
console.log("═══════════════════════════════════════════");
console.log("  Command Center — ReAct Framework Suite");
console.log("═══════════════════════════════════════════");
console.log("");
await verifyEvaluator();
await verifyRoles();
await verifyRecovery();
await verifyPrompts();
await verifyTraces();
await verifySimulatedAgents();
await verifyMockTools();
await verifyStress();
await verifyE2E();
await verifyImageProcessing();
await verifyMemoryTopics();
await verifyFileLocks();
await verifyBm25TokenPrefilter();
await verifyNativeWorkflowParsers();
await verifyWorkflowEngine();
await verifyBaseQueue();
await verifyNativeBasesResults();
await verifyFrontmatterSync();
await verifyChatContext();
await verifyChatActionCard();
await verifyJitModels();
await verifyAudio();
await verifyHybridRag();
await verifyAgentMemory();
await verifyRagAgentIntegration();
await verifyHeadlessCliBridge();
console.log("");
console.log("═══════════════════════════════════════════");
console.log("  Results:  "+results.pass+" passed, "+results.fail+" failed, "+results.skip+" skipped");
console.log("═══════════════════════════════════════════");
process.exit(results.fail>0?1:0);
}
main().catch(e=>{console.error("Runner failed:",e);process.exit(1)});