/**
 * Provider-agnostic repair for model-generated structured JSON.
 *
 * This is intentionally used for model output (ReAct envelopes and tool
 * arguments), not provider HTTP/SSE protocol frames: malformed transport data
 * should remain visible rather than being silently reinterpreted.
 */

/** Remove a surrounding Markdown JSON fence, including prose around the fence. */
export function stripJsonCodeFence(input: string): string {
	const fenced = input.match(/```(?:json|jsonl|javascript|js)?\s*([\s\S]*?)```/i);
	if (fenced) return fenced[1]!.trim();
	return input.trim()
		.replace(/^```(?:json|jsonl|javascript|js)?\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim();
}

/** Best-effort normalization of common model JSON formatting mistakes. */
export function repairModelJson(input: string): string {
	let value = extractJsonCandidate(stripJsonCodeFence(input));
	value = escapeUnescapedQuotes(value);
	value = removeTrailingCommas(value);
	value = closeTruncatedJson(value);
	return removeTrailingCommas(value);
}

/** Parse model-generated JSON, retrying once with conservative auto-repair. */
export function parseModelJson<T = unknown>(input: string): T {
	const stripped = stripJsonCodeFence(input);
	try {
		return JSON.parse(stripped) as T;
	} catch (initialError) {
		const repaired = repairModelJson(stripped);
		try {
			return JSON.parse(repaired) as T;
		} catch (repairError) {
			const initial = initialError instanceof Error ? initialError.message : String(initialError);
			const repairedMessage = repairError instanceof Error ? repairError.message : String(repairError);
			throw new SyntaxError(`Invalid model JSON after auto-repair: ${repairedMessage} (original: ${initial})`);
		}
	}
}

function extractJsonCandidate(input: string): string {
	const objectAt = input.indexOf('{');
	const arrayAt = input.indexOf('[');
	const starts = [objectAt, arrayAt].filter(i => i >= 0);
	if (starts.length === 0) return input.trim();
	const start = Math.min(...starts);
	let candidate = input.slice(start).trim();

	// Remove ordinary prose after a visibly complete object/array. Truncated
	// payloads deliberately retain their tail so the balancing pass can close it.
	const opener = candidate[0];
	const closer = opener === '{' ? '}' : ']';
	const end = candidate.lastIndexOf(closer);
	if (end >= 0) candidate = candidate.slice(0, end + 1);
	return candidate;
}

/**
 * Escape quotes embedded in a JSON string. A quote closes a string only when
 * followed by JSON structure (colon, a genuine value separator, a closer, or
 * end-of-input); otherwise it is treated as model-authored prose.
 */
function escapeUnescapedQuotes(input: string): string {
	let output = '';
	let inString = false;
	let escaped = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (!inString) {
			output += ch;
			if (ch === '"') inString = true;
			continue;
		}
		if (escaped) {
			output += ch;
			escaped = false;
			continue;
		}
		if (ch === '\\') {
			output += ch;
			escaped = true;
			continue;
		}
		if (ch !== '"') {
			output += ch;
			continue;
		}
		if (isClosingQuote(input, i)) {
			output += ch;
			inString = false;
		} else {
			output += '\\"';
		}
	}
	return output;
}

function isClosingQuote(input: string, quoteAt: number): boolean {
	let i = quoteAt + 1;
	while (i < input.length && /\s/.test(input[i]!)) i++;
	if (i >= input.length) return true;
	const next = input[i]!;
	if (next === ':' || next === '}' || next === ']') return true;
	if (next !== ',') return false;
	// A comma is structural when followed by another key/value or a closer.
	i++;
	while (i < input.length && /\s/.test(input[i]!)) i++;
	return i >= input.length || input[i] === '"' || input[i] === '{' ||
		input[i] === '[' || input[i] === '}' || input[i] === ']' ||
		/[-0-9tfn]/.test(input[i]!);
}

function removeTrailingCommas(input: string): string {
	let output = '';
	let inString = false;
	let escaped = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (inString) {
			output += ch;
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') { inString = true; output += ch; continue; }
		if (ch === ',') {
			let j = i + 1;
			while (j < input.length && /\s/.test(input[j]!)) j++;
			if (input[j] === '}' || input[j] === ']') continue;
		}
		output += ch;
	}
	return output;
}

function closeTruncatedJson(input: string): string {
	let output = input.trim();
	const stack: string[] = [];
	let inString = false;
	let escaped = false;

	for (const ch of output) {
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{') stack.push('}');
		else if (ch === '[') stack.push(']');
		else if ((ch === '}' || ch === ']') && stack[stack.length - 1] === ch) stack.pop();
	}

	if (escaped) output += '\\';
	if (inString) output += '"';
	output = output.replace(/,\s*$/, '');
	if (/:\s*$/.test(output)) output += ' null';
	while (stack.length > 0) output += stack.pop();
	return output;
}
