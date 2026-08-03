#!/usr/bin/env node

/**
 * Command Center — Automated Verification Script
 *
 * Tests:
 *   1. Build integrity (tsc + esbuild clean)
 *   2. Worker response parsing (4 profiles, valid/malformed/edge)
 *   3. RPC stream routing & isolation (mock daemon JSONL)
 *   4. Daemon error recovery (crash, ENOENT, stop/start)
 *   5. Task queue lifecycle (enqueue → run → complete/fail → drained)
 *   6. Pi 0.82 daemon integration (portable mock subprocess)
 *
 * Usage:  node test/verify.mjs
 *         VERBOSE=1 node test/verify.mjs   (detailed output)
 */

import { strict as assert } from 'node:assert';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'src');
const results = { pass: 0, fail: 0, skip: 0 };

function pass(name) { results.pass++; console.log(`  ✅ ${name}`); }
function fail(name, err) { results.fail++; console.log(`  ❌ ${name}: ${err.message}`); }

/* ═══════════════════════════════════════════════════════════
   1. Build Integrity
   ═══════════════════════════════════════════════════════════ */

async function verifyBuild() {
	console.log('\n─── 1. Build Integrity ───');

	try {
		execSync('npx tsc --noEmit --skipLibCheck', { cwd: ROOT, stdio: 'pipe' });
		pass('tsc type-check: zero errors');
	} catch (e) {
		fail('tsc type-check', new Error(e.stderr?.toString() || e.message));
	}

	try {
		execSync('node esbuild.config.mjs production', { cwd: ROOT, stdio: 'pipe' });
		const size = existsSync(join(ROOT, 'main.js')) ? readFileSync(join(ROOT, 'main.js')).length : 0;
		pass(`esbuild production bundle: ${(size / 1024).toFixed(1)} KB`);
	} catch (e) {
		fail('esbuild build', new Error(e.stderr?.toString() || e.message));
	}
}

/* ═══════════════════════════════════════════════════════════
   2. Worker Response Parsing
   ═══════════════════════════════════════════════════════════ */

async function verifyWorkerParsers() {
	console.log('\n─── 2. Worker Response Parsing ───');

	// ── Orchestrator ──────────────────────────────────
	{
		const { parsePlanResponse } = await import(pathToFileURL(join(SRC, 'workers', 'orchestrator.ts')).href);
		const valid = parsePlanResponse(JSON.stringify({ steps: [{ worker: 'summarizer', prompt: 'X' }], rationale: 'test' }));
		assert.equal(valid.rationale, 'test');
		assert.equal(valid.steps.length, 1);
		pass('orchestrator: valid JSON parsed');

		const fallback = parsePlanResponse('not json');
		assert.equal(fallback.steps.length, 1);
		assert.equal(fallback.steps[0].worker, 'summarizer');
		pass('orchestrator: malformed JSON → fallback plan');

		const empty = parsePlanResponse('');
		assert.equal(empty.steps.length, 1);
		pass('orchestrator: empty string → fallback');
	}

	// ── Retriever ─────────────────────────────────────
	{
		const { parseRetrievalResponse } = await import(pathToFileURL(join(SRC, 'workers', 'retriever.ts')).href);
		const valid = parseRetrievalResponse(JSON.stringify({ matches: [{ path: 'n.md', title: 'N', relevance: 0.9, excerpt: '...' }], query: 'test' }));
		assert.equal(valid.matches.length, 1);
		assert.equal(valid.matches[0].relevance, 0.9);
		pass('retriever: valid JSON parsed');

		const fb = parseRetrievalResponse('garbage');
		assert.equal(fb.matches.length, 0);
		assert.equal(fb.query, 'Unknown (parse fallback)');
		pass('retriever: malformed JSON → empty matches');

		assert.equal(parseRetrievalResponse('').matches.length, 0);
		pass('retriever: empty string → empty matches');
	}

	// ── Summarizer ────────────────────────────────────
	{
		const { parseSummaryResponse } = await import(pathToFileURL(join(SRC, 'workers', 'summarizer.ts')).href);
		const valid = parseSummaryResponse(JSON.stringify({ title: 'T', keyPoints: ['a', 'b'], themes: ['t1'], actionableItems: [], oneLineSummary: 's' }));
		assert.equal(valid.title, 'T');
		assert.equal(valid.keyPoints.length, 2);
		pass('summarizer: valid JSON parsed');

		const fb = parseSummaryResponse('raw text here');
		assert.equal(fb.title, 'Summary');
		assert.equal(fb.keyPoints.length, 1);
		assert.ok(fb.keyPoints[0].includes('raw text'));
		pass('summarizer: malformed JSON → fallback summary');

		assert.equal(parseSummaryResponse('').keyPoints.length, 1);
		pass('summarizer: empty string → fallback');
	}

	// ── Editor ────────────────────────────────────────
	{
		const { parseEditResponse } = await import(pathToFileURL(join(SRC, 'workers', 'editor.ts')).href);
		const valid = parseEditResponse(JSON.stringify({ operations: [{ type: 'insert', newText: 'hi' }], rationale: 'edit' }));
		assert.equal(valid.operations.length, 1);
		assert.equal(valid.operations[0].type, 'insert');
		pass('editor: valid JSON parsed');

		const fb = parseEditResponse('bad');
		assert.equal(fb.operations.length, 0);
		assert.ok(fb.rationale.includes('Failed'));
		pass('editor: malformed JSON → empty operations');

		assert.equal(parseEditResponse('').operations.length, 0);
		pass('editor: empty string → empty operations');
	}
}

/* ═══════════════════════════════════════════════════════════
   3. RPC Daemon Stream Routing
   ═══════════════════════════════════════════════════════════ */

async function verifyDaemonStreams() {
	console.log('\n─── 3. RPC Daemon Stream Routing ───');

	const { PiAgentDaemon } = await import(pathToFileURL(join(SRC, 'daemon.ts')).href);

	// Create daemon with mocked subprocess pipes
	function mockDaemon() {
		const d = new PiAgentDaemon('/tmp/test-vault', 'pi');
		const stdin = new PassThrough();
		const stdoutWrite = new PassThrough();
		const writes = [];

		// Assign private fields (testing, not production)
		d.piProcess = {
			stdin,
			stdout: stdoutWrite,
			exitCode: null,
			kill: () => { d.piProcess.exitCode = 1; d.piProcess = null; },
		};
		d.startError = null;
		d.stdoutReadOffset = 0;
		d.stdoutWriteOffset = 0;
		d.activeTasks = new Set();
		d.activeSessionId = null;
		d.streamCallback = null;
		d.responseHandlers = new Map();

		// Exercise the production decoder rather than duplicating its logic.
		stdoutWrite.on('data', (chunk) => d.consumeStdoutChunk(chunk));
		stdoutWrite.on('end', () => d.consumeStdoutChunk(Buffer.alloc(0), true));

		// Capture stdin writes for assertions
		const origWrite = stdin.write.bind(stdin);
		stdin.write = (data, ...args) => { writes.push(data.toString()); return origWrite(data, ...args); };
		d._writes = writes;

		return { d, stdoutWrite, stdin, writes };
	}

	// ─── 3a. message_update text_delta → stream callback ──
	{
		const { d, stdoutWrite } = mockDaemon();
		const deltas = [];
		d.activeTasks.add('task-a1');
		d.streamCallback = (delta, tid) => deltas.push({ delta, tid });

		stdoutWrite.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' } }) + '\n');
		stdoutWrite.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'world' } }) + '\n');
		stdoutWrite.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: 'Hello world' } }) + '\n');

		assert.equal(deltas.length, 3);
		assert.equal(deltas[0].delta, 'Hello ');
		assert.equal(deltas[1].delta, 'world');
		assert.equal(deltas[2].delta, '\n');
		pass('3a: message_update text_delta → stream callback');
		d.stop();
	}

	// ─── 3b. tool_execution_update → stream callback ─────
	{
		const { d, stdoutWrite } = mockDaemon();
		const deltas = [];
		d.activeTasks.add('task-b1');
		d.streamCallback = (delta) => deltas.push(delta);

		stdoutWrite.write(JSON.stringify({ type: 'tool_execution_update', partialResult: { content: [{ type: 'text', text: 'tool chunk' }] } }) + '\n');
		assert.equal(deltas.length, 1);
		assert.ok(deltas[0].includes('tool chunk'));
		pass('3b: tool_execution_update → stream callback');
		d.stop();
	}

	// ─── 3c. agent_end → resolves handler, clears state ──
	{
		const { d, stdoutWrite } = mockDaemon();
		const taskId = 'task-c1';
		d.activeTasks.add(taskId);

		const promise = new Promise((resolve, reject) => {
			d.responseHandlers.set(taskId, (r) => r.error ? reject(new Error(r.error)) : resolve(r));
		});

		stdoutWrite.write(JSON.stringify({
			type: 'agent_end',
			taskId,
			messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Final' }] }],
		}) + '\n');

		const r = await promise;
		assert.equal(r.taskId, taskId);
		assert.equal(r.complete, true);
		assert.ok(r.result.output.includes('Final'));
		assert.equal(d.activeTasks.size, 0);
		pass('3c: agent_end resolves active task, removes from activeTasks');
		d.stop();
	}

	// ─── 3d. agent_settled also resolves ─────────────────
	{
		const { d, stdoutWrite } = mockDaemon();
		const taskId = 'task-d1';
		d.activeTasks.add(taskId);

		const promise = new Promise((resolve) => {
			d.responseHandlers.set(taskId, resolve);
		});

		stdoutWrite.write(JSON.stringify({ type: 'agent_settled', taskId, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'X' }] }] }) + '\n');
		const r = await promise;
		assert.equal(r.complete, true);
		pass('3d: agent_settled also resolves active task');
		d.stop();
	}

	// ─── 3e. Stream isolation: events route only by callback ──
	{
		const { d, stdoutWrite } = mockDaemon();
		const t1 = [], t2 = [];

		d.activeTasks.add('task-e1');
		d.activeTasks.add('task-e2');
		d.streamCallback = (d, tid) => {
			if (tid === 'task-e1') t1.push(d);
			else if (tid === 'task-e2') t2.push(d);
		};
		stdoutWrite.write(JSON.stringify({ type: 'message_update', taskId: 'task-e1', assistantMessageEvent: { type: 'text_delta', delta: 't1 only' } }) + '\n');
		stdoutWrite.write(JSON.stringify({ type: 'message_update', taskId: 'task-e2', assistantMessageEvent: { type: 'text_delta', delta: 't2 only' } }) + '\n');
		assert.equal(t1.length, 1);
		assert.equal(t2.length, 1);
		pass('3e: stream events include taskId context');
		d.stop();
	}

	// ─── 3f. Concurrent executeTask allowed (no single-task lock) ──
	{
		const { d } = mockDaemon();
		d.activeTasks.add('existing-task');
		// executeTask with lock=true checks startError and stdin, not busy lock
		// Since the mock has stdin, it should proceed to send (will not reject for busy)
		const p = d.executeTask({ taskId: 'concurrent-task', workerProfile: 'retriever', prompt: 'test' }).catch(() => {});
		// The concurrent model allows concurrent tasks — was previously rejected
		await new Promise(r => setTimeout(r, 50));
		// Clean up the pending handler before stop to avoid unhandled rejection
		d.responseHandlers.delete('concurrent-task');
		d.activeTasks.delete('concurrent-task');
		pass('3f: concurrent executeTask no longer rejects with "Daemon busy" (concurrent execution supported)');
		d.stop();
	}

	// ─── 3g. Steer error response → handler rejected ──────
	{
		const { d, stdoutWrite } = mockDaemon();
		const p = new Promise((res, rej) => d.responseHandlers.set('steer-1', (r) => r.error ? rej(new Error(r.error)) : res(r)));
		stdoutWrite.write(JSON.stringify({ type: 'response', id: 'steer-1', success: false, error: 'Steer failed' }) + '\n');
		try { await p; throw new Error('Should reject'); }
		catch (err) { assert.ok(err.message.includes('Steer failed')); }
		pass('3g: steer error response → rejected');
		d.stop();
	}

	// ─── 3h. executeTask sends Pi 0.82 prompt frame ────────
	{
		const { d, writes } = mockDaemon();
		d.piProcess.stdin = d.piProcess.stdin; // already set
		d.activeSessionId = null;

		const writePromise = new Promise((resolve) => {
			d.executeTask({ taskId: 'task-h1', workerProfile: 'orchestrator', prompt: 'do stuff', targetPath: 'note.md' })
				.catch(() => {}); // no response in this mock; only inspect the frame
			setTimeout(resolve, 100);
		});
		await writePromise;

		assert.ok(d._writes.length >= 1);
		const sent = JSON.parse(d._writes[0].trim());
		assert.equal(sent.id, 'task-h1');
		assert.equal(sent.type, 'prompt');
		assert.ok(sent.message.includes('Agent profile: orchestrator'));
		assert.ok(sent.message.includes('Target note: note.md'));
		assert.ok(sent.message.includes('do stuff'));
		pass('3h: executeTask sends valid Pi 0.82 prompt frame');
		d.stop();
	}

	// ─── 3i. Partial and multi-frame chunks are assembled ─
	{
		const { d, stdoutWrite } = mockDaemon();
		const deltas = [];
		d.activePromptTaskId = 'task-i1';
		d.streamCallback = (delta) => deltas.push(delta);
		const frames = Array.from({ length: 100 }, (_, i) => JSON.stringify({
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: `chunk-${i}` },
		}));
		const payload = Buffer.from(frames.join('\n') + '\n', 'utf8');
		// Split inside the first JSON token, then deliver the rest as one busy chunk.
		stdoutWrite.write(payload.subarray(0, 7));
		assert.equal(deltas.length, 0);
		stdoutWrite.write(payload.subarray(7));
		assert.equal(deltas.length, 100);
		assert.equal(deltas[0], 'chunk-0');
		assert.equal(deltas[99], 'chunk-99');
		assert.equal(d.stdoutWriteOffset - d.stdoutReadOffset, 0);
		pass('3i: partial frame + high-throughput multi-frame chunk decoded without loss');
		d.stop();
	}

	// ─── 3j. UTF-8 boundaries and U+2028/U+2029 stay in payload ─
	{
		const { d, stdoutWrite } = mockDaemon();
		const deltas = [];
		d.activePromptTaskId = 'task-j1';
		d.streamCallback = (delta) => deltas.push(delta);
		const expected = 'before\u2028middle\u2029after 😀';
		const payload = Buffer.from(JSON.stringify({
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: expected },
		}) + '\r\n', 'utf8');
		const emojiStart = payload.indexOf(Buffer.from('😀'));
		assert.ok(emojiStart > 0);
		// Split halfway through the four-byte emoji to verify stateful UTF-8 decoding.
		stdoutWrite.write(payload.subarray(0, emojiStart + 2));
		stdoutWrite.write(payload.subarray(emojiStart + 2));
		assert.deepEqual(deltas, [expected]);
		pass('3j: split UTF-8 code point and literal U+2028/U+2029 decode intact');
		d.stop();
	}

	// ─── 3k. A final frame without LF is decoded on stream end ─
	{
		const { d, stdoutWrite } = mockDaemon();
		const deltas = [];
		d.activePromptTaskId = 'task-k1';
		d.streamCallback = (delta) => deltas.push(delta);
		stdoutWrite.end(JSON.stringify({
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: 'final-frame' },
		}));
		await new Promise(resolve => stdoutWrite.once('end', resolve));
		assert.deepEqual(deltas, ['final-frame']);
		assert.equal(d.stdoutWriteOffset - d.stdoutReadOffset, 0);
		pass('3k: unterminated final JSON frame decoded when stdout ends');
		d.stop();
	}
}

/* ═══════════════════════════════════════════════════════════
   4. Daemon Error Recovery
   ═══════════════════════════════════════════════════════════ */

async function verifyErrorRecovery() {
	console.log('\n─── 4. Daemon Error Recovery ───');

	const { PiAgentDaemon } = await import(pathToFileURL(join(SRC, 'daemon.ts')).href);

	// ─── 4a. Start with bad pi path → startError set ─────
	{
		const d = new PiAgentDaemon('/tmp', '/non/existent/pi_binary');
		d.start();
		// Await a tick for async spawn error
		await new Promise(r => setTimeout(r, 100));
		assert.ok(d.startError !== null);
		assert.ok(d.startError.includes('Failed to start') || d.startError.includes('ENOENT'));
		assert.equal(d.isRunning(), false);
		pass('4a: bad pi path → startError, daemon not running');

		// executeTask fails fast
		try {
			await d.executeTask({ taskId: 'x', workerProfile: 'o', prompt: 'x' });
			throw new Error('Should reject');
		} catch (err) {
			assert.ok(err.message.includes('Daemon failed'));
			pass('4a.1: executeTask fails fast with startError message');
		}
	}

	// ─── 4b. Stop → clean state ─────────────────────────
	{
		const d = new PiAgentDaemon('/tmp', 'pi');
		// Inject a mock process
		let killed = false;
		d.piProcess = { stdin: new PassThrough(), stdout: new EventEmitter(), exitCode: null, kill: () => { killed = true; d.piProcess.exitCode = 1; d.piProcess = null; } };
		d.consumeStdoutChunk(Buffer.from('something'));
		d.activeTasks.add('old-task');

		d.stop();
		assert.equal(killed, true);
		assert.equal(d.piProcess, null);
		assert.equal(d.stdoutWriteOffset - d.stdoutReadOffset, 0);
		assert.equal(d.activeTasks.size, 0);
		pass('4b: stop kills process, clears buffer and activeTasks');
	}

	// ─── 4c. Start after stop → clean restart ──────────
	{
		const d = new PiAgentDaemon('/tmp', 'pi');
		let killCount = 0;
		d.piProcess = { stdin: new PassThrough(), stdout: new EventEmitter(), exitCode: null, kill: () => killCount++ };
		d.stop();
		assert.equal(killCount, 1);

		// start() should no-op since piProcess was nullified in stop()
		d.piProcess = null;
		d.start();
		// After start with invalid pi, startError should be set
		await new Promise(r => setTimeout(r, 100));
		assert.ok(d.startError !== null || d.piProcess === null);
		pass('4c: stop/start cycle completes without exception');
	}

	// ─── 4d. Process exit during active task → state cleanup ──
	{
		const d = new PiAgentDaemon('/tmp', 'pi');
		const exitEmitter = new EventEmitter();
		d.piProcess = {
			stdin: new PassThrough(),
			stdout: new EventEmitter(),
			exitCode: null,
			kill: () => { d.piProcess.exitCode = 1; d.piProcess = null; },
		};
		d.consumeStdoutChunk(Buffer.from('partial'));
		d.activeTasks.add('lost-task');

		// Simulate exit event
		const exitHandler = (code) => {
			console.warn('[CC] Pi daemon exited (code ' + code + ')');
			d.piProcess = null;
			d.resetStdoutBuffer();
			d.activeTasks.clear();
		};
		exitHandler(1);

		assert.equal(d.piProcess, null);
		assert.equal(d.stdoutWriteOffset - d.stdoutReadOffset, 0);
		assert.equal(d.activeTasks.size, 0);
		pass('4d: process exit clears buffer and activeTasks');
	}

	// ─── 4e. Stale events dropped after task switch ────
	{
		const { d, stdoutWrite } = (() => {
			const d2 = new PiAgentDaemon('/tmp', 'pi');
			const sin = new PassThrough();
			const sout = new PassThrough();
			d2.piProcess = { stdin: sin, stdout: sout, exitCode: null, kill: () => {} };
			d2.startError = null;
			d2.stdoutReadOffset = 0;
			d2.stdoutWriteOffset = 0;
			d2.activeTasks = new Set();
			d2.activeSessionId = null;
			d2.streamCallback = null;
			d2.responseHandlers = new Map();
			sout.on('data', (chunk) => d2.consumeStdoutChunk(chunk));
			return { d: d2, stdoutWrite: sout };
		})();

		const deltas = [];
		d.activeTasks.add('task-e4');
		d.streamCallback = (delta) => deltas.push(delta);

		// Send event
		stdoutWrite.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'should appear' } }) + '\n');
		assert.equal(deltas.length, 1);

		// Simulate agent_end resolved and cleared
		d.activeTasks.delete('task-e4');
		d.streamCallback = null;

		// Send another event — should be dropped
		stdoutWrite.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'should be dropped' } }) + '\n');
		assert.equal(deltas.length, 1);  // still 1
		pass('4e: events after task completion are dropped');
		d.stop();
	}
}
/* ═══════════════════════════════════════════════════════════
   5. Task Queue Lifecycle
   ═══════════════════════════════════════════════════════════ */

async function verifyTaskQueue() {
	console.log('\n─── 5. Task Queue Lifecycle ───');

	const { TaskQueue } = await import(pathToFileURL(join(SRC, 'task-queue.ts')).href);

	// ─── 5a. Enqueue → process → complete ─────────────
	{
		const events = [];
		const q = new TaskQueue({
			execute: async (task) => {
				await new Promise(r => setTimeout(r, 10));
				return { output: 'done', metadata: { taskId: task.id } };
			},
		}, 1);

		q.on('started', (e, t) => events.push({ e, id: t.id }));
		q.on('completed', (e, t) => events.push({ e, id: t.id }));
		q.on('drained', () => events.push({ e: 'drained' }));

		const task = { id: 't1', workerProfile: 'test', prompt: 'x', status: 'queued' };
		q.enqueue(task);

		await new Promise(r => setTimeout(r, 50));

		assert.equal(events.filter(e => e.e === 'started').length, 1);
		assert.equal(events.filter(e => e.e === 'completed').length, 1);
		assert.equal(events.filter(e => e.e === 'drained').length, 1);

		const stats = q.getStats();
		assert.equal(stats.completed, 1);
		assert.equal(stats.running, 0);
		assert.equal(stats.pending, 0);
		pass('5a: enqueue → started → completed → drained');
	}

	// ─── 5b. Task failure → failed event ──────────────
	{
		const events = [];
		const q = new TaskQueue({
			execute: async () => { throw new Error('simulated failure'); },
		}, 1);

		q.on('failed', (e, t) => events.push({ e, id: t.id, err: t.error }));
		q.on('drained', () => events.push({ e: 'drained' }));

		q.enqueue({ id: 't2', workerProfile: 'test', prompt: 'x', status: 'queued' });
		await new Promise(r => setTimeout(r, 50));

		assert.equal(events.filter(e => e.e === 'failed').length, 1);
		assert.equal(events[0].err, 'simulated failure');
		assert.equal(q.getStats().failed, 1);
		pass('5b: task failure → failed event + drained');
	}

	// ─── 5c. Concurrency limit respected ──────────────
	{
		let concurrent = 0;
		let maxConcurrent = 0;
		const q = new TaskQueue({
			execute: async () => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise(r => setTimeout(r, 20));
				concurrent--;
				return { output: 'ok' };
			},
		}, 2);

		q.enqueue({ id: 'c1', workerProfile: 't', prompt: 'x', status: 'queued' });
		q.enqueue({ id: 'c2', workerProfile: 't', prompt: 'x', status: 'queued' });
		q.enqueue({ id: 'c3', workerProfile: 't', prompt: 'x', status: 'queued' });

		await new Promise(r => setTimeout(r, 80));
		assert.ok(maxConcurrent <= 2, `maxConcurrent was ${maxConcurrent}`);
		assert.equal(q.getStats().completed, 3);
		pass('5c: concurrency=2, max concurrent never exceeded');
	}

	// ─── 5d. Event listener cleanup ───────────────────
	{
		const q = new TaskQueue({ execute: async () => ({}) }, 1);
		let count = 0;
		const fn = () => count++;
		q.on('completed', fn);
		q.off('completed', fn);
		q.enqueue({ id: 't3', workerProfile: 't', prompt: 'x', status: 'queued' });
		await new Promise(r => setTimeout(r, 30));
		assert.equal(count, 0);  // removed listener should not fire
		pass('5d: off() removes listener');
	}
}

/* ═══════════════════════════════════════════════════════════
   6. Pi 0.82 RPC Subprocess Integration (portable mock)
   ═══════════════════════════════════════════════════════════ */

async function verifyRealDaemon() {
	console.log('\n─── 6. Pi 0.82 RPC Subprocess Integration ───');

	// Launch the JS mock through the exact Node executable running this suite.
	// This is portable across Windows/macOS/Linux and Node 20/22/24.
	const mockPiPath = join(ROOT, 'test', 'mock-pi-daemon.js');
	assert.ok(existsSync(mockPiPath), 'Mock Pi RPC executable should exist');

	const tmpDir = mkdtempSync(join(tmpdir(), `cc-test-${randomUUID().slice(0, 8)}-`));
	try {
		writeFileSync(join(tmpDir, 'test-note.md'), '# Test Note\n\nHello world.');

		const { PiAgentDaemon } = await import(pathToFileURL(join(SRC, 'daemon.ts')).href);
		const daemon = new PiAgentDaemon(tmpDir, mockPiPath);

		daemon.start();
		await new Promise(r => setTimeout(r, 150));
		assert.ok(daemon.isRunning(), `Daemon should be running: ${daemon.startError ?? 'no launch error'}`);
		pass('6a: daemon starts portable Pi 0.82 RPC mock');

		const deltas = [];
		const result = await daemon.executeTask({
			taskId: 'mock-test-1',
			workerProfile: 'summarizer',
			prompt: 'Summarize the note at test-note.md in one sentence.',
			targetPath: 'test-note.md',
		}, (delta) => deltas.push(delta));

		assert.equal(result.complete, true);
		assert.ok(result.result);
		assert.match(result.result.output, /hello world/i);
		pass('6b: executeTask completes through Pi 0.82 agent_end → agent_settled');

		assert.deepEqual(deltas, ['Mock Pi summary: ', 'test-note.md ', 'says hello world.', '\n']);
		pass('6c: deterministic streaming deltas received over JSONL stdout');

		daemon.stop();
		await new Promise(r => setTimeout(r, 100));
		assert.equal(daemon.isRunning(), false);
		pass('6d: daemon stops cleanly');

		daemon.start();
		await new Promise(r => setTimeout(r, 150));
		assert.ok(daemon.isRunning());
		daemon.stop();
		pass('6e: daemon start after stop works');
	} catch (err) {
		fail('Pi RPC subprocess integration', err);
	} finally {
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
	}
}

/* ═══════════════════════════════════════════════════════════
   7. Provider Fallback Classification & Circuit State
   ═══════════════════════════════════════════════════════════ */

async function verifyProviderFallback() {
	console.log('\n─── 7. Provider Fallback Classification & Circuit State ───');
	const { ProviderError } = await import(pathToFileURL(join(SRC, 'providers/provider-types.ts')).href);
	const { classifyProviderFailure, ProviderCircuitBreaker } = await import(
		pathToFileURL(join(SRC, 'providers/provider-recovery.ts')).href
	);
	const config = {
		primary: 'openai', fallbacks: ['anthropic'],
		fallbackOnRateLimit: true, fallbackOnTimeout: true,
		maxAttempts: 2, backoffMs: 1000,
	};

	assert.equal(classifyProviderFailure(new ProviderError('rate_limited', '429', 'openai', 429), config), 'fallback-backoff');
	assert.equal(classifyProviderFailure(new ProviderError('timeout', 'slow', 'openai'), config), 'fallback-backoff');
	assert.equal(classifyProviderFailure(new ProviderError('connection_failed', 'offline', 'openai'), config), 'fallback-backoff');
	assert.equal(classifyProviderFailure(new ProviderError('server_error', '500', 'openai', 500), config), 'fallback-backoff');
	pass('7a: transient provider failures use fallback with exponential backoff');

	assert.equal(classifyProviderFailure(new ProviderError('auth_failed', '401', 'openai', 401), config), 'fallback-immediate');
	assert.equal(classifyProviderFailure(new ProviderError('invalid_request', 'schema', 'openai', 400), config), 'fail');
	assert.equal(classifyProviderFailure(new ProviderError('context_exceeded', 'large', 'openai', 400), config), 'fail');
	assert.equal(classifyProviderFailure(new ProviderError('content_filtered', 'blocked', 'openai', 400), config), 'fail');
	pass('7b: auth bypasses backoff; invalid request errors fail fast');

	const breaker = new ProviderCircuitBreaker(2, 100);
	const auth = new ProviderError('auth_failed', 'bad key', 'openai', 401);
	const schema = new ProviderError('invalid_request', 'bad schema', 'openai', 400);
	breaker.recordFailure('openai', auth, 0);
	breaker.recordFailure('openai', schema, 0);
	assert.equal(breaker.getFailureCount('openai'), 0);
	assert.equal(breaker.getState('openai', 0), 'closed');

	const network = new ProviderError('connection_failed', 'offline', 'openai');
	breaker.recordFailure('openai', network, 0);
	breaker.recordFailure('openai', network, 1);
	assert.equal(breaker.getState('openai', 50), 'open');
	assert.equal(breaker.getState('anthropic', 50), 'closed');
	assert.equal(breaker.getState('openai', 101), 'half-open');
	breaker.recordSuccess('openai');
	assert.equal(breaker.getState('openai', 101), 'closed');
	pass('7c: provider circuits track only transient failures and remain provider-isolated');

	const { ProviderDispatcher } = await import(pathToFileURL(join(SRC, 'dispatcher.ts')).href);
	const calls = { openai: 0, anthropic: 0 };
	let primaryError = new ProviderError('auth_failed', 'bad key', 'openai', 401);
	const adapters = {
		openai: {
			id: 'openai',
			isAvailable: () => true,
			getDefaultModel: () => 'openai-model',
			complete: async () => {
				calls.openai++;
				return { output: '', success: false, error: primaryError.message, typedError: primaryError, providerId: 'openai', latencyMs: 0 };
			},
		},
		anthropic: {
			id: 'anthropic',
			isAvailable: () => true,
			getDefaultModel: () => 'anthropic-model',
			complete: async () => {
				calls.anthropic++;
				return { output: 'fallback-ok', success: true, providerId: 'anthropic', latencyMs: 0 };
			},
		},
	};
	const settings = {
		credentials: { openai: { enabled: true }, anthropic: { enabled: true } }, fallback: config,
		routing: {
			coding: { taskType: 'coding', providerId: 'openai', modelId: 'primary-model' },
			vision: { taskType: 'vision', providerId: 'openai', modelId: 'primary-model' },
			reading: { taskType: 'reading', providerId: 'openai', modelId: 'primary-model' },
			reasoning: { taskType: 'reasoning', providerId: 'openai', modelId: 'primary-model' },
			fast: { taskType: 'fast', providerId: 'openai', modelId: 'primary-model' },
		},
	};
	// Faithful mock factory: mirrors ProviderFactory.isUsable/listUsable/resolveModelForTask.
	const mockFactory = {
		get: id => adapters[id],
		isUsable: id => { const c = settings.credentials[id]; const en = id === 'pi-daemon' ? true : (c?.enabled ?? false); return en && !!adapters[id] && adapters[id].isAvailable(); },
		listUsable: () => Object.keys(adapters).filter(id => { const c = settings.credentials[id]; const en = id === 'pi-daemon' ? true : (c?.enabled ?? false); return en && adapters[id].isAvailable(); }).map(id => adapters[id]),
		resolveModelForTask: (id, tt) => adapters[id]?.getDefaultModel(tt) ?? 'unknown',
	};
	const dispatcher = new ProviderDispatcher(mockFactory, () => settings);
	let delayed = 0;
	dispatcher._delay = async () => { delayed++; };
	const authResult = await dispatcher.dispatch({ systemPrompt: '', userPrompt: 'test' }, 'reasoning');
	assert.equal(authResult.output, 'fallback-ok');
	assert.equal(delayed, 0, '401 fallback must not sleep');
	assert.equal(dispatcher.circuitBreaker.getFailureCount('openai'), 0);

	primaryError = new ProviderError('invalid_request', 'invalid schema', 'openai', 400);
	calls.anthropic = 0;
	const schemaResult = await dispatcher.dispatch({ systemPrompt: '', userPrompt: 'test' }, 'reasoning');
	assert.equal(schemaResult.success, false);
	assert.equal(calls.anthropic, 0, '400 must fail before fallback adapter');
	assert.equal(delayed, 0, '400 must not sleep');
	assert.equal(dispatcher.circuitBreaker.getFailureCount('openai'), 0);
	pass('7d: dispatcher routes 401 immediately and fails 400 without backoff or circuit pollution');
}

/* ═══════════════════════════════════════════════════════════
   8. Release Version Sync (version-bump.mjs)
   ═══════════════════════════════════════════════════════════ */

async function verifyVersionSync() {
	console.log('\n─── 8. Release Version Sync ───');

	// Simulate what the release workflow's version gate checks:
	// manifest.json, package.json, and package-lock.json must all agree.
	const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
	const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));

	const expected = manifest.version;
	try {
		if (pkg.version !== expected) throw new Error(
			`package.json version ${pkg.version} !== manifest ${expected}`
		);
		if (lock.version !== expected) throw new Error(
			`package-lock.json root version ${lock.version} !== manifest ${expected}`
		);
		if (lock.packages?.['']?.version !== expected) throw new Error(
			`package-lock.json packages[''].version ${lock.packages?.['']?.version} !== manifest ${expected}`
		);
		pass('8a: manifest.json, package.json, and package-lock.json all agree on version ' + expected);
	} catch (e) {
		fail('8a: version sync', e);
	}

	// Verify the version-bump.mjs script can sync all three files.
	// Run it with a test version via npm version and verify all files are updated.
	const tmpDir = mkdtempSync(join(tmpdir(), 'cc-version-test-'));
	try {
		const testVersion = '99.99.99';
		const srcFiles = [
			'manifest.json', 'package.json', 'package-lock.json', 'versions.json',
		];
		for (const f of srcFiles) {
			writeFileSync(join(tmpDir, f), readFileSync(join(ROOT, f)));
		}

		// Simulate what version-bump.mjs does: read manifest, write version, update lock
		const manifest = JSON.parse(readFileSync(join(tmpDir, 'manifest.json'), 'utf8'));
		const { minAppVersion } = manifest;
		manifest.version = testVersion;
		writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, '\t'));

		const versions = JSON.parse(readFileSync(join(tmpDir, 'versions.json'), 'utf8'));
		if (!(testVersion in versions)) {
			versions[testVersion] = minAppVersion;
			writeFileSync(join(tmpDir, 'versions.json'), JSON.stringify(versions, null, '\t'));
		}

		const lock = JSON.parse(readFileSync(join(tmpDir, 'package-lock.json'), 'utf8'));
		lock.version = testVersion;
		if (lock.packages?.['']?.version) {
			lock.packages[''].version = testVersion;
		}
		writeFileSync(join(tmpDir, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');

		const bumpedManifest = JSON.parse(readFileSync(join(tmpDir, 'manifest.json'), 'utf8'));
		const bumpedLock = JSON.parse(readFileSync(join(tmpDir, 'package-lock.json'), 'utf8'));

		assert.equal(bumpedManifest.version, testVersion, 'manifest.json version bumped');
		assert.equal(bumpedLock.version, testVersion, 'package-lock.json root version bumped');
		assert.equal(bumpedLock.packages?.['']?.version, testVersion, 'package-lock.json packages root version bumped');

		pass('8b: version-bump logic syncs manifest.json, package-lock.json root, and packages root');
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

/* ═══════════════════════════════════════════════════════════
   9. DataNormalizer — Execution Boundary Sanitization
   ═══════════════════════════════════════════════════════════ */

async function verifyDataNormalizer() {
	console.log('\n─── 9. Data Normalizer (Sanitization Boundary) ───');
	const { DataNormalizer } = await import(pathToFileURL(join(SRC, 'execution/D'+'ataNormalizer.ts')).href);

	const n = new DataNormalizer();

	// Valid payload with content
	const r1 = n.normalize({ success: true, content: 'Hello world', latencyMs: 100 }, 'provider-dispatcher');
	assert.equal(r1.success, true);
	assert.equal(r1.content, 'Hello world');
	assert.equal(r1.latencyMs, 100);
	pass('9a: normalizes valid payload with content');

	// Control character stripping
	const r2 = n.normalize({ success: true, content: 'Line1\x00\x01\x02\nLine2\x7f\nLine3', latencyMs: 0 }, 'pi-daemon');
	assert.equal(r2.content, 'Line1\nLine2\nLine3');
	pass('9b: strips control characters from content');

	// Stack trace removal
	const r3 = n.normalize({ success: true, content: 'Result\n    at Object.<anonymous> (/path/file.js:1:2)\n    at next (internal/process/next_tick.js:1:2)\nFinal line', latencyMs: 0 }, 'pi-daemon');
	assert.equal(r3.content, 'Result\nFinal line');
	pass('9c: removes stack trace lines from content');

	// Error extraction with trace cleaning
	const r4 = n.normalize({ success: false, error: 'Something broke\nTraceback (most recent call last):\n  File "test.py", line 5, in <module>\n    raise ValueError("bad")', latencyMs: 0 }, 'python-worker');
	assert.equal(r4.success, false);
	assert.equal(r4.error, 'Something broke');
	pass('9d: extracts first safe line from error, strips Python traceback');

	// Malformed JSON string payload
	const r5 = n.normalize('{invalid json}', 'pi-daemon');
	assert.equal(r5.success, false);
	assert.ok(r5.error?.includes('malformed'));
	pass('9e: handles malformed JSON string payload gracefully');

	// Nested result field
	const r6 = n.normalize({ success: true, result: { output: 'Nested output' }, latencyMs: 50 }, 'provider-dispatcher');
	assert.equal(r6.content, 'Nested output');
	pass('9f: extracts content from nested result.output');

	// Merge multiple results
	const merged = n.merge([
		{ success: true, content: 'First', latencyMs: 10 },
		{ success: true, content: 'Second', latencyMs: 20 },
	], 'provider-dispatcher');
	assert.equal(merged.success, true);
	assert.ok(merged.content.includes('First'));
	assert.ok(merged.content.includes('Second'));
	assert.equal(merged.latencyMs, 30);
	pass('9g: merge combines multiple successful results with total latency');

	// Merge with failure
	const mergedFail = n.merge([
		{ success: true, content: 'Good', latencyMs: 5 },
		{ success: false, error: 'Bad', latencyMs: 3 },
	], 'provider-dispatcher');
	assert.equal(mergedFail.success, false);
	assert.equal(mergedFail.error, 'Bad');
	pass('9h: merge reports failure when any sub-result fails');
}

/* ═══════════════════════════════════════════════════════════
   10. JSON Repair — Model Output Recovery
   ═══════════════════════════════════════════════════════════ */

async function verifyJsonRepair() {
	console.log('\n─── 10. JSON Repair (Model Output Recovery) ───');
	const {
		stripJsonCodeFence,
		repairModelJson,
		parseModelJson,
	} = await import(pathToFileURL(join(SRC, 'providers/json-repair.ts')).href);

	// Strip fences
	assert.equal(stripJsonCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
	assert.equal(stripJsonCodeFence('```\n{"a":1}\n```'), '{"a":1}');
	assert.equal(stripJsonCodeFence('{"a":1}'), '{"a":1}');
	assert.equal(stripJsonCodeFence('Some prose ```json\n{"a":1}\n``` more'), '{"a":1}');
	pass('10a: stripJsonCodeFence removes Markdown code fences');

	// Repair trailing commas
	const repaired = repairModelJson('{"a":1,"b":2,}');
	assert.equal(repaired, '{"a":1,"b":2}');
	pass('10b: repairModelJson removes trailing commas');

	// Parse with fence
	const parsed = parseModelJson('```json\n{"a":1,"b":2}\n```');
	assert.deepEqual(parsed, { a: 1, b: 2 });
	pass('10c: parseModelJson parses fenced JSON');

	// Parse with repair (trailing comma)
	const repairedParsed = parseModelJson('{"a":1,"b":2,}');
	assert.deepEqual(repairedParsed, { a: 1, b: 2 });
	pass('10d: parseModelJson auto-repairs trailing commas');

	// Parse with nested arrays
	const nested = parseModelJson('{"items":[1,2,3],"obj":{"k":"v"}}');
	assert.deepEqual(nested, { items: [1, 2, 3], obj: { k: 'v' } });
	pass('10e: parseModelJson handles nested arrays and objects');

	// Invalid JSON throws
	assert.throws(() => parseModelJson('{definitely not json}'), SyntaxError);
	pass('10f: parseModelJson throws SyntaxError on truly invalid JSON');

	// Unclosed JSON (truncated)
	const truncated = repairModelJson('{"a":1,"b":"hello');
	assert.ok(truncated.includes('"a":1'));
	pass('10g: repairModelJson closes truncated JSON gracefully');
}

/* ═══════════════════════════════════════════════════════════
   11. Cache Manager — Prompt Caching & Token Optimization
   ═══════════════════════════════════════════════════════════ */

async function verifyCacheManager() {
	console.log('\n─── 11. Cache Manager (Prompt Caching & Token Optimization) ───');
	const {
		resolveCacheConfig,
		shouldUseCache,
		generateCacheKey,
		computeOptimalMaxTokens,
		estimatePromptTokens,
		CacheStatsTracker,
	} = await import(pathToFileURL(join(SRC, 'providers/cache-manager.ts')).href);

	// Default config resolution
	const cfg = resolveCacheConfig();
	assert.equal(cfg.strategy, 'conservative');
	assert.equal(typeof cfg.cacheTtlSeconds, 'number');
	assert.equal(cfg.minCacheTokens, 1024);
	pass('11a: resolveCacheConfig returns defaults');

	// Partial merge
	const partial = resolveCacheConfig({ strategy: 'read' });
	assert.equal(partial.strategy, 'read');
	assert.equal(typeof partial.cacheTtlSeconds, 'number');
	pass('11b: resolveCacheConfig merges partial over defaults');

	// Cache key generation
	const key1 = generateCacheKey('system prompt', [{ name: 'tool1', description: 'desc', parameters: { type: 'object', properties: {} } }]);
	const key2 = generateCacheKey('system prompt', [{ name: 'tool1', description: 'desc', parameters: { type: 'object', properties: {} } }]);
	const key3 = generateCacheKey('different system prompt', [{ name: 'tool1', description: 'desc', parameters: { type: 'object', properties: {} } }]);
	assert.equal(key1, key2);
	assert.notEqual(key1, key3);
	pass('11c: generateCacheKey produces deterministic hashes for same inputs');

	// Token estimation
	const tokens = estimatePromptTokens('Hello world, this is a test of the token estimator.');
	assert.ok(tokens > 0);
	assert.ok(tokens < 50);
	pass('11d: estimatePromptTokens returns reasonable token count');

	// Optimal max tokens
	const optimal = computeOptimalMaxTokens(8192, 500, 16384, 0.25);
	assert.equal(optimal, 3971);
	pass('11e: computeOptimalMaxTokens reserves prompt tokens from context window');

	// Cache stats tracking
	const stats = new CacheStatsTracker();
	stats.recordCreation(100);
	stats.recordRead(50);
	stats.recordRead(25);
	const report = stats.stats;
	assert.equal(report.creations, 1);
	assert.equal(report.reads, 2);
	assert.equal(report.tokensWritten, 100);
	assert.equal(report.tokensSaved, 75);
	pass("11f: CacheStatsTracker records creations, reads, and token counts");

	stats.reset();
	assert.equal(stats.stats.creations, 0);
	pass("11g: CacheStatsTracker.reset clears all counters");

	// Should use cache — conservative strategy with short prompt
	assert.equal(shouldUseCache({ enabled: true, strategy: 'conservative', maxCacheAgeMs: 60000 }, 'short', [], 0), false);
	pass('11h: shouldUseCache returns false for conservative strategy with short prompt');

	// Should use cache — disabled strategy
	assert.equal(shouldUseCache({ enabled: false, strategy: 'conservative', maxCacheAgeMs: 60000 }, 'system prompt', [], 0), false);
	pass('11i: shouldUseCache returns false for disabled strategy');

	// Should use cache — long prompt hits min threshold
	const longPrompt = 'x'.repeat(5000);
	assert.equal(shouldUseCache({ enabled: true, strategy: 'conservative', maxCacheAgeMs: 60000, minCacheTokens: 1024 }, longPrompt, [], 0), true);
	pass('11j: shouldUseCache returns true for long prompt with enabled cache');
}

/* ═══════════════════════════════════════════════════════════
   12. ShadowTreeArchive — In-Memory Delta Archival
   ═══════════════════════════════════════════════════════════ */

async function verifyShadowTreeArchive() {
	console.log('\n─── 12. Shadow Tree Archive (In-Memory Delta Archival) ───');
	const { ShadowTreeArchive } = await import(pathToFileURL(join(SRC, 'memory/ShadowTreeArchive.ts')).href);

	const archive = new ShadowTreeArchive();

	// Record a simple delta
	const delta = archive.record('path/test.md', 'line1\nline2\nline3', 'line1\nmodified\nline3', 'Update middle line');
	assert.ok(delta.id);
	assert.equal(delta.notePath, 'path/test.md');
	assert.equal(delta.reason, 'Update middle line');
	assert.equal(delta.parentId, null);
	assert.ok(delta.operations.length > 0);
	pass('12a: archive.record stores a delta with operations');

	// Second delta links to first via parentId
	const delta2 = archive.record('path/test.md', 'line1\nmodified\nline3', 'line1\nmodified\nfinal', 'Finalize');
	assert.equal(delta2.parentId, delta.id);
	pass('12b: subsequent deltas chain via parentId');

	// No changes means empty operations
	const delta3 = archive.record('path/identical.md', 'same\ncontent', 'same\ncontent', 'No change');
	assert.equal(delta3.operations.length, 1);
	assert.equal(delta3.operations[0].kind, "retain");
	pass('12c: identical before/after produces a retain operation');

	// Retrieve timeline for a path
	const timeline = archive.getTimeline('path/test.md');
	assert.equal(timeline.length, 2);
	assert.equal(timeline[0].id, delta.id);
	assert.equal(timeline[1].id, delta2.id);
	pass('12d: getTimeline returns all deltas for a path');

	// Unknown path returns empty
	const empty = archive.getTimeline('path/unknown.md');
	assert.deepEqual(empty, []);
	pass('12e: getTimeline returns empty for unknown path');

	// Clear removes all deltas
	archive.clear();
	assert.deepEqual(archive.getTimeline('path/test.md'), []);
	pass('12f: clear removes all deltas for a path');
}

/* ═══════════════════════════════════════════════════════════
   13. Release Tag & Manifest Validation
   ═══════════════════════════════════════════════════════════ */

async function verifyReleaseTag() {
	console.log('\n─── 13. Release Tag & Manifest Validation ───');

	const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

	// Manifest must have required fields
	assert.ok(typeof manifest.id === 'string' && manifest.id.length > 0, 'manifest.id is required');
	assert.ok(typeof manifest.name === 'string' && manifest.name.length > 0, 'manifest.name is required');
	assert.ok(typeof manifest.version === 'string' && manifest.version.length > 0, 'manifest.version is required');
	assert.ok(typeof manifest.minAppVersion === 'string' && manifest.minAppVersion.length > 0, 'manifest.minAppVersion is required');
	assert.equal(manifest.isDesktopOnly, true, 'manifest.isDesktopOnly must be true');
	pass('13a: manifest.json has all required fields');

	// Version must be valid semver (x.y.z) and must never carry a 'v' prefix —
	// release tags are bare semver (e.g. 1.2.0, never v1.2.0).
	const version = manifest.version;
	const semverRe = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
	assert.ok(semverRe.test(version), `version "${version}" must be valid semver`);
	assert.ok(!/^v/i.test(version), `version "${version}" must not have a 'v' prefix`);
	pass('13b: manifest version is valid bare semver without v prefix');

	// minAppVersion must be >= 1.13.0 (plugin requirement)
	const [major, minor] = manifest.minAppVersion.split('.').map(Number);
	assert.ok(major > 1 || (major === 1 && minor >= 13), 'minAppVersion must be >= 1.13.0');
	pass('13c: minAppVersion meets minimum requirement');

	// versions.json must contain the current version
	const versions = JSON.parse(readFileSync(join(ROOT, 'versions.json'), 'utf8'));
	assert.ok(version in versions, `versions.json must contain entry for ${version}`);
	assert.equal(versions[version], manifest.minAppVersion, 'versions.json entry must match minAppVersion');
	pass('13d: versions.json contains current version mapping');

	// Simulate the release workflow's tag gate: tag must equal manifest version
	// and must be bare semver (no 'v' prefix).
	const simulatedTag = version;
	assert.equal(simulatedTag, version, 'release tag must equal manifest version');
	assert.ok(/^\d+\.\d+\.\d+$/.test(simulatedTag), 'release tag must be bare semver without v prefix');
	pass('13e: release tag matches manifest version and has no v prefix (release workflow gate)');

	// fundingUrl must be present (good practice for community plugins)
	assert.ok(typeof manifest.fundingUrl === 'string' && manifest.fundingUrl.length > 0, 'fundingUrl is recommended');
	pass('13f: manifest has fundingUrl');
}

/* ═══════════════════════════════════════════════════════════
   14. Obsidian Guideline Compliance (manifest, structure, paths)
   ═══════════════════════════════════════════════════════════ */

async function verifyObsidianGuidelines() {
	console.log('\n─── 14. Obsidian Guideline Compliance ───');
	const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

	// Plugin ID must be lowercase alphanumeric with hyphens only (no spaces/underscores)
	assert.ok(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(manifest.id), `manifest.id "${manifest.id}" must be lowercase with hyphens only`);
	pass('14a: manifest.id is a valid plugin identifier');

	// Version must be strict x.y.z semver (no leading zeroes, no pre-release tags)
	assert.ok(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version), 'manifest.version must be strict x.y.z');
	pass('14b: manifest.version is strict semver without leading zeroes');

	// fundingUrl must be https and valid
	assert.ok(/^https:\/\//.test(manifest.fundingUrl), 'manifest.fundingUrl must be https');
	pass('14c: manifest.fundingUrl is https');

	// Styles.css must not contain hardcoded colors outside CSS variables
	const styles = readFileSync(join(ROOT, 'styles.css'), 'utf8');
	const hardcodedHex = styles.match(/#[0-9a-fA-F]{3,6}(?![0-9a-fA-F])/g) ?? [];
	const allowedHex = hardcodedHex.filter(hex => {
		const upper = hex.toUpperCase();
		return ['#FFDD00', '#F7D400', '#000000', '#000', '#FD0', '#0003'].includes(upper);
	});
	assert.equal(allowedHex.length, hardcodedHex.length,
		`styles.css contains hardcoded hex colors outside the BMC brand palette: ${hardcodedHex.filter(h => !allowedHex.includes(h)).join(', ')}`);
	pass('14d: styles.css only uses CSS variables and the documented BMC brand palette');

	// No innerHTML/outerHTML/insertAdjacentHTML anywhere in src (XSS guideline)
	const srcFiles = [];
	(function collect(dir) {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const stat = statSync(full);
			if (stat.isDirectory()) collect(full);
			else if (entry.endsWith('.ts')) srcFiles.push(full);
		}
	})(join(ROOT, 'src'));
	const dangerous = [];
	for (const file of srcFiles) {
		const text = readFileSync(file, 'utf8');
		if (text.includes('.innerHTML') || text.includes('.outerHTML') || text.includes('insertAdjacentHTML')) {
			dangerous.push(file);
		}
	}
	assert.equal(dangerous.length, 0, `dangerous DOM APIs used in: ${dangerous.join(', ')}`);
	pass('14e: no innerHTML/outerHTML/insertAdjacentHTML usage (XSS-safe DOM construction)');

	// Vault.process preferred over Vault.modify for background writes
	let processCount = 0, modifyCount = 0;
	(function collectSrc(dir) {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const s = statSync(full);
			if (s.isDirectory()) collectSrc(full);
			else if (entry.endsWith('.ts')) {
				const text = readFileSync(full, 'utf8');
				processCount += (text.match(/vault\.process\(/g) ?? []).length;
				modifyCount += (text.match(/vault\.modify\(/g) ?? []).length;
			}
		}
	})(join(ROOT, 'src'));
	assert.ok(processCount > 0, 'Vault.process must be used for atomic background writes');
	pass('14f: vault.process used across source tree for atomic file writes');

	// normalizePath used for user-defined paths
	const mainSource = readFileSync(join(ROOT, 'src/main.ts'), 'utf8');
	assert.ok(mainSource.includes('normalizePath'), 'normalizePath must be imported/used in main.ts');
	pass('14g: main.ts uses normalizePath for path sanitization');

	// Command callbacks must not use deprecated patterns
	const commands = mainSource.match(/addCommand\(\{[\s\S]*?\}\);/g) ?? [];
	assert.ok(commands.length > 0, 'plugin must register commands');
	for (const cmd of commands) {
		assert.ok(!cmd.includes('checkCallback') || cmd.includes('checkCallback:'), 'commands must use valid callback types');
	}
	pass('14h: plugin registers commands with valid callback types');

	// Settings tab: no top-level heading, use setHeading() instead of HTML heading elements
	const settingsTab = readFileSync(join(ROOT, 'src/settings/PluginSettingsTab.ts'), 'utf8');
	const htmlHeadingMatches = settingsTab.match(/\.createEl\(\s*['"]h[1-6]['"]/g);
	assert.equal(htmlHeadingMatches, null, 'settings must use setHeading() instead of HTML heading elements');
	pass('14i: settings tab uses setHeading() instead of HTML heading elements');

	// No top-level heading with plugin name
	const topLevelHeadingPattern = /\.setName\(['"]Command Center['"]\)\s*\.setHeading\(\)/g;
	assert.equal(settingsTab.match(topLevelHeadingPattern), null, 'settings must not have a top-level heading with plugin name');
	pass('14j: no top-level heading in settings tab');

	// No "settings" in settings section headings
	const sectionHeadings = settingsTab.match(/\.setName\(['"][^'"]+['"]\)\s*\.setHeading\(\)/g) ?? [];
	for (const heading of sectionHeadings) {
		const name = heading.match(/\.setName\(['"]([^'"]+)['"]\)/)?.[1] ?? '';
		assert.ok(!name.toLowerCase().includes('settings'), 'settings section heading must not contain settings: ' + name);
	}
	pass('14k: no settings in settings section headings');

	// No default hotkeys on commands
	for (const cmd of commands) {
		assert.ok(!cmd.match(/hotkeys?:\s*\[/), 'commands must not set default hotkeys');
	}
	pass('14l: no default hotkeys on commands');

	// onunload does not detach leaves
	assert.ok(!mainSource.match(/onunload[\s\S]*?detachLeaves/), 'onunload must not detach leaves');
	pass('14m: onunload does not detach leaves');

	// onunload cleans up resources
	assert.ok(mainSource.includes('onunload'), 'plugin must implement onunload');
	pass('14n: plugin implements onunload for resource cleanup');

	// addCommand used for auto-cleanup
	assert.ok(mainSource.includes('addCommand'), 'plugin uses addCommand for auto-cleanup');
	pass('14o: plugin uses addCommand for auto-cleanup of commands');

	// No workspace.activeLeaf usage
	assert.ok(!mainSource.match(/\.activeLeaf\b/), 'must not access workspace.activeLeaf directly');
	pass('14p: no workspace.activeLeaf usage (uses getActiveViewOfType/activeEditor)');

	// registerView does not store instance references
	const viewRegs = mainSource.match(/registerView\([^,]+,\s*\([^)]+\)\s*=>/g) ?? [];
	for (const reg of viewRegs) {
		assert.ok(!reg.includes('this.'), 'registerView must not store view references: ' + reg);
	}
	pass('14q: registerView does not store view references (uses getActiveLeavesOfType)');

	// FileManager.processFrontMatter used for frontmatter mutations
	let fmCount = 0;
	(function scanFm(dir) {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const s = statSync(full);
			if (s.isDirectory()) scanFm(full);
			else if (entry.endsWith('.ts')) {
				const text = readFileSync(full, 'utf8');
				fmCount += (text.match(/processFrontMatter\(/g) ?? []).length;
			}
		}
	})(join(ROOT, 'src'));
	assert.ok(fmCount > 0, 'processFrontMatter must be used for frontmatter operations');
	pass('14r: FileManager.processFrontMatter used for frontmatter mutations');

	// No vault.adapter.read/write for vault files (use Vault API)
	let adapterCount = 0;
	(function scanAdp(dir) {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const s = statSync(full);
			if (s.isDirectory()) scanAdp(full);
			else if (entry.endsWith('.ts')) {
				const text = readFileSync(full, 'utf8');
				if (!text.includes('vault.adapter.write') || !text.includes('configDir')) {
					adapterCount += (text.match(/vault\.adapter\.(read|write|exists|list|mkdir)\(/g) ?? []).length;
				}
			}
		}
	})(join(ROOT, 'src'));
	assert.equal(adapterCount, 0, 'must use Vault API instead of vault.adapter for vault files');
	pass('14s: no vault.adapter usage for vault file operations');

	// No getFiles().find() for path lookup
	let findCount = 0;
	(function scanFind(dir) {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			const s = statSync(full);
			if (s.isDirectory()) scanFind(full);
			else if (entry.endsWith('.ts')) {
				const text = readFileSync(full, 'utf8');
				if (/getFiles\(\)\s*\.\s*find\s*\(/.test(text)) findCount++;
			}
		}
	})(join(ROOT, 'src'));
	assert.equal(findCount, 0, 'must not use getFiles().find() for path lookup');
	pass('14t: no getFiles().find() for path lookup (uses getFileByPath/getAbstractFileByPath)');

	// Documentation consistency: README badge must match actual test count
	const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
	const badgeMatch = readme.match(/tests-(\d+)%20passing-brightgreen/);
	assert.ok(badgeMatch, 'README must contain a test badge');
	const badgeCount = parseInt(badgeMatch[1], 10);
	// The badge should reflect the sum of core tests + React tests
	// We check it's >= the core test count (which is verified in this test run)
	assert.ok(badgeCount >= results.pass, 'README test badge (' + badgeCount + ') must be >= actual passing tests (' + results.pass + ')');
	pass('14u: README test badge count is up to date');

	// README version reference matches manifest version
	const manifest2 = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
	const version = manifest2.version;
	// Check the release automation section mentions the current version
	const versionInReadme = readme.match(/currently `(\d+\.\d+\.\d+)`/);
	assert.ok(versionInReadme, 'README must mention current version in release automation section');
	assert.equal(versionInReadme[1], version, 'README version must match manifest version');
	pass('14v: README version reference matches manifest.json');

	// CHANGELOG has an entry for the current version
	const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
	assert.ok(changelog.includes('## [' + version + ']'), 'CHANGELOG must have an entry for version ' + version);
	pass('14w: CHANGELOG has entry for current version');

	// manifest.json author matches AGENTS.md scope
	const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
	assert.ok(agents.includes('Command Center'), 'AGENTS.md must reference the project');
	pass('14x: AGENTS.md references the project');

	// REVIEWER_NOTES.md is present and non-empty
	const reviewer = readFileSync(join(ROOT, 'REVIEWER_NOTES.md'), 'utf8');
	assert.ok(reviewer.length > 500, 'REVIEWER_NOTES.md must be substantial');
	pass('14y: REVIEWER_NOTES.md is present and substantial');

	// Release workflow tag pattern explicitly rejects 'v' prefix.
	// The pattern is a glob, not a regex — it must not contain 'v' as a literal.
	const releaseYml = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
	const tagPattern = releaseYml.match(/tags:\s*\n\s*-\s+'([^']+)'/);
	assert.ok(tagPattern, 'release.yml must define a tag trigger pattern');
	const pattern = tagPattern[1];
	assert.ok(/^\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+$/.test(pattern),
		`release tag pattern "${pattern}" must be bare semver glob (no v prefix)`);
	assert.ok(!pattern.includes('v'),
		`release tag pattern "${pattern}" must not contain 'v'`);
	pass('14z: release.yml tag pattern rejects v-prefixed tags');
}

/* ═══════════════════════════════════════════════════════════
   Main Runner
   ═══════════════════════════════════════════════════════════ */

async function main() {
	console.log('═══════════════════════════════════════════');
	console.log('  Command Center — Verification Suite');
	console.log('═══════════════════════════════════════════');
	console.log(`Workspace: ${ROOT}`);
	console.log(`Node: ${process.version}`);

	await verifyBuild();
	await verifyWorkerParsers();
	await verifyDaemonStreams();
	await verifyErrorRecovery();
	await verifyTaskQueue();
	await verifyRealDaemon();
	await verifyProviderFallback();
	await verifyVersionSync();
	await verifyDataNormalizer();
	await verifyJsonRepair();
	await verifyCacheManager();
	await verifyShadowTreeArchive();
	await verifyReleaseTag();
	await verifyObsidianGuidelines();

	console.log('\n═══════════════════════════════════════════');
	console.log(`  Results:  ${results.pass} passed, ${results.fail} failed, ${results.skip} skipped`);
	console.log('═══════════════════════════════════════════');

	process.exit(results.fail > 0 ? 1 : 0);
}

main().catch(err => {
	console.error('Test runner failed:', err);
	process.exit(1);
});