#!/usr/bin/env node

/**
 * Portable Pi 0.82 RPC test double.
 *
 * It intentionally implements only the JSONL lifecycle consumed by
 * PiAgentDaemon: prompt acknowledgement, streamed text, agent_end, and
 * agent_settled. No network access, model credentials, or installed pi binary
 * are required.
 */

import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const modeIndex = args.indexOf('--mode');
if (modeIndex < 0 || args[modeIndex + 1] !== 'rpc') {
	process.stderr.write('mock-pi-daemon requires --mode rpc\n');
	process.exitCode = 2;
} else {
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	let chain = Promise.resolve();

	const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
	const handle = async (line) => {
		if (!line.trim()) return;
		let command;
		try { command = JSON.parse(line); }
		catch {
			process.stderr.write('Invalid JSONL command\n');
			return;
		}

		if (command.type === 'prompt' && typeof command.id === 'string') {
			emit({ type: 'response', id: command.id, command: 'prompt', success: true });
			const output = 'Mock Pi summary: test-note.md says hello world.';
			for (const delta of ['Mock Pi summary: ', 'test-note.md ', 'says hello world.']) {
				emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
				await new Promise(resolve => setTimeout(resolve, 2));
			}
			emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', content: output } });
			emit({
				type: 'agent_end',
				messages: [
					{ role: 'user', content: [{ type: 'text', text: String(command.message ?? '') }] },
					{ role: 'assistant', content: [{ type: 'text', text: output }] },
				],
			});
			emit({ type: 'agent_settled' });
			return;
		}

		if (command.type === 'abort' || command.type === 'steer' || command.type === 'follow_up') {
			emit({ type: 'response', id: command.id, command: command.type, success: true });
			return;
		}
		if (command.type === 'tool_result') return;
		emit({ type: 'response', id: command.id, command: command.type, success: false, error: 'Unsupported mock command' });
	};

	lines.on('line', (line) => { chain = chain.then(() => handle(line)); });
	lines.on('close', () => { void chain.then(() => process.exit(0)); });
}
