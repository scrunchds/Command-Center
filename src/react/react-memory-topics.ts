/** Pure, deterministic topic clustering for persisted ReAct session summaries. */

const MAX_CLUSTER_SUMMARY_CHARS = 480;

const TOPIC_SEEDS: Record<string, string[]> = {
	'Code Refactoring': ['refactor', 'refactoring', 'architecture', 'module', 'class', 'function', 'typescript', 'javascript', 'code', 'cleanup'],
	'Vault Reorganization': ['vault', 'reorganize', 'reorganization', 'folder', 'folders', 'note', 'notes', 'attachment', 'move', 'rename', 'taxonomy'],
	'Bug Fixes': ['bug', 'bugs', 'fix', 'fixed', 'failure', 'error', 'crash', 'regression', 'issue', 'debug', 'timeout'],
	'Documentation': ['documentation', 'docs', 'readme', 'guide', 'explain', 'reference'],
	'Testing & Quality': ['test', 'tests', 'testing', 'coverage', 'lint', 'benchmark', 'validation'],
	'Performance': ['performance', 'optimize', 'optimization', 'latency', 'cache', 'memory', 'throughput'],
};

const TOPIC_STOP_WORDS = new Set([
	'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'was', 'were', 'are', 'has', 'have',
	'had', 'not', 'but', 'task', 'cycle', 'react', 'session', 'summary', 'observation', 'thought', 'action',
	'to', 'of', 'in', 'on', 'a', 'an', 'is', 'it', 'as', 'by', 'or', 'be', 'using', 'used', 'completed',
]);

export interface TopicMemoryNote {
	path: string;
	sessionId: string;
	task: string;
	content: string;
	timestamp: number;
}

export interface TopicCluster {
	id: string;
	label: string;
	keywords: string[];
	summary: string;
	notePaths: string[];
	sessionIds: string[];
	latestTimestamp: number;
}

interface WorkingCluster {
	label?: string;
	notes: TopicMemoryNote[];
	tokens: Set<string>;
}

function topicTokens(text: string): string[] {
	return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])
		.map(token => token.endsWith('ing') && token.length > 6 ? token.slice(0, -3) : token)
		.filter(token => !TOPIC_STOP_WORDS.has(token));
}

function seededTopic(tokens: string[]): string | undefined {
	let best: string | undefined;
	let bestScore = 0;
	for (const [label, seeds] of Object.entries(TOPIC_SEEDS)) {
		const score = seeds.reduce((sum, seed) => sum + tokens.filter(token => token === seed || token.startsWith(seed)).length, 0);
		if (score > bestScore) { best = label; bestScore = score; }
	}
	return bestScore > 0 ? best : undefined;
}

function tokenSimilarity(left: Set<string>, right: Set<string>): number {
	let intersection = 0;
	for (const token of left) if (right.has(token)) intersection++;
	return intersection / Math.max(1, Math.min(left.size, right.size));
}

/** Deterministically group session summaries into compact thematic context hubs. */
export function generateTopicClusters(notes: TopicMemoryNote[]): TopicCluster[] {
	const working: WorkingCluster[] = [];
	for (const note of [...notes].sort((a, b) => b.timestamp - a.timestamp)) {
		const tokens = topicTokens(`${note.task} ${note.content}`);
		const tokenSet = new Set(tokens);
		const label = seededTopic(tokens);
		let cluster = label ? working.find(item => item.label === label) : undefined;
		if (!cluster) {
			const closest = working
				.filter(item => !label || !item.label)
				.map(item => ({ item, similarity: tokenSimilarity(tokenSet, item.tokens) }))
				.sort((a, b) => b.similarity - a.similarity)[0];
			cluster = closest && closest.similarity >= 0.2 ? closest.item : undefined;
		}
		if (!cluster) {
			cluster = { label, notes: [], tokens: new Set() };
			working.push(cluster);
		}
		cluster.notes.push(note);
		for (const token of tokenSet) cluster.tokens.add(token);
	}

	return working.map((cluster, index) => {
		const frequency = new Map<string, number>();
		for (const note of cluster.notes) for (const token of new Set(topicTokens(`${note.task} ${note.content}`))) {
			frequency.set(token, (frequency.get(token) ?? 0) + 1);
		}
		const keywords = [...frequency.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([token]) => token);
		const label = cluster.label ?? (keywords.slice(0, 3).map(word => word[0]!.toUpperCase() + word.slice(1)).join(' & ') || 'General Work');
		const taskDigest = [...new Set(cluster.notes.map(note => note.task.trim()).filter(Boolean))]
			.slice(0, 4).map(task => `- ${task.slice(0, 120)}`).join('\n');
		return {
			id: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index}`,
			label,
			keywords,
			summary: taskDigest.slice(0, MAX_CLUSTER_SUMMARY_CHARS),
			notePaths: cluster.notes.map(note => note.path),
			sessionIds: [...new Set(cluster.notes.map(note => note.sessionId).filter(Boolean))],
			latestTimestamp: Math.max(...cluster.notes.map(note => note.timestamp), 0),
		};
	}).sort((a, b) => b.latestTimestamp - a.latestTimestamp);
}

/** Rank context hubs by query overlap, recognized intent, size, and recency. */
export function rankTopicClusters(query: string, clusters: TopicCluster[], limit: number = 2): TopicCluster[] {
	const queryTokens = topicTokens(query);
	const querySet = new Set(queryTokens);
	const queryTopic = seededTopic(queryTokens);
	return clusters.map(cluster => {
		const searchable = new Set(topicTokens(`${cluster.label} ${cluster.keywords.join(' ')} ${cluster.summary}`));
		let overlap = 0;
		for (const token of querySet) if (searchable.has(token)) overlap++;
		const topicBoost = queryTopic === cluster.label ? 4 : 0;
		const sizeBoost = Math.min(1, cluster.notePaths.length / 5);
		return { cluster, score: overlap * 2 + topicBoost + sizeBoost };
	}).filter(item => item.score > 0)
		.sort((a, b) => b.score - a.score || b.cluster.latestTimestamp - a.cluster.latestTimestamp)
		.slice(0, Math.max(0, limit)).map(item => item.cluster);
}
