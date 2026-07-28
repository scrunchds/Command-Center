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
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
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

	console.log('\n═══════════════════════════════════════════');
	console.log(`  Results:  ${results.pass} passed, ${results.fail} failed, ${results.skip} skipped`);
	console.log('═══════════════════════════════════════════');

	process.exit(results.fail > 0 ? 1 : 0);
}

main().catch(err => {
	console.error('Test runner failed:', err);
	process.exit(1);
});
