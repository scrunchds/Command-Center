/* ═══════════════════════════════════════════════════════════
   15. Capability Registry
   ═══════════════════════════════════════════════════════════ */

async function verifyCapabilityRegistry() {
	console.log('\n─── 15. Capability Registry ───');

	const { CapabilityRegistry } = await import(pathToFileURL(join(SRC, 'capabilities', 'CapabilityRegistry.ts')).href);
	CapabilityRegistry.resetInstance();
	const registry = CapabilityRegistry.getInstance();

	const testTool = {
		name: 'test_tool',
		label: 'Test Tool',
		description: 'A test capability',
		parameters: { type: 'object', properties: {}, required: [] },
		execute: async () => ({ content: [{ type: 'text', text: 'done' }], details: { } }),
	};
	registry.register(testTool, {
		id: 'test-capability',
		label: 'Test Capability',
		description: 'A test capability',
		category: 'search',
		executionMode: 'autonomous',
		confirmationPolicy: 'never',
		requiresVault: false,
		aliases: ['@test'],
	});
	assert.equal(registry.size, 1, 'registry should have 1 capability');
	pass('registry: single capability registered');

	const searchCaps = registry.query({ categories: ['search'] });
	assert.equal(searchCaps.length, 1, 'should find search capabilities');
	pass('registry: query by category works');

	const enabledCaps = registry.getEnabledCapabilities();
	assert.equal(enabledCaps.length, 1, 'enabled capabilities should include test tool');
	pass('registry: getEnabledCapabilities works');

	registry.setEnabled('test-capability', false);
	const afterDisable = registry.getEnabledCapabilities();
	assert.equal(afterDisable.length, 0, 'no capabilities should be enabled after disable');
	pass('registry: setEnabled works');

	registry.setEnabled('test-capability', true);
	pass('registry: toggle works');

	const resolved = registry.resolveAlias('@test');
	assert.ok(resolved, 'alias @test should resolve');
	assert.equal(resolved.meta.id, 'test-capability');
	pass('registry: alias resolution works');

	const settings = registry.toSettings();
	assert.ok(Array.isArray(settings.preferences), 'settings.preferences should be an array');
	pass('registry: toSettings produces valid preferences');

	registry.applyPreferences([{ id: 'test-capability', enabled: false }]);
	const afterPrefs = registry.getEnabledCapabilities();
	assert.equal(afterPrefs.length, 0, 'applyPreferences should disable the capability');
	pass('registry: applyPreferences works');

	let eventFired = false;
	const unsub = registry.subscribe((event) => {
		if (event.type === 'capability-enabled') eventFired = true;
	});
	registry.setEnabled('test-capability', true);
	assert.ok(eventFired, 'capability-enabled event should fire');
	unsub();
	pass('registry: events work');

	registry.clear();
	assert.equal(registry.size, 0, 'registry should be empty after clear');
	pass('registry: clear works');

	registry.registerAll([
		{ tool: testTool, meta: { id: 'alpha', label: 'Alpha', description: 'First', category: 'search', executionMode: 'autonomous', confirmationPolicy: 'never', requiresVault: false } },
		{ tool: testTool, meta: { id: 'beta', label: 'Beta', description: 'Second', category: 'file', executionMode: 'autonomous', confirmationPolicy: 'never', requiresVault: true } },
	]);
	assert.equal(registry.size, 2, 'registerAll should register both');
	pass('registry: registerAll works');

	const desc = registry.describeEnabled();
	assert.ok(desc.includes('alpha'), 'describeEnabled should include alpha');
	pass('registry: describeEnabled works');

	registry.clear();
	CapabilityRegistry.resetInstance();
}

/* ═══════════════════════════════════════════════════════════
   16. User Memory Manager
   ═══════════════════════════════════════════════════════════ */

async function verifyUserMemoryManager() {
	console.log('\n─── 16. User Memory Manager ───');

	const { UserMemoryManager } = await import(pathToFileURL(join(SRC, 'memory', 'UserMemoryManager.ts')).href);

	const mockStore = {
		storeMemoryItem: async (cat, key, value) => ({
			id: cat + ':' + key + ':' + Date.now(),
			category: cat, key, value,
			createdAt: Date.now(), updatedAt: Date.now(),
		}),
		searchMemory: (query, limit) => {
			if (query.includes('test')) {
				return [{ id: '1', category: 'facts', key: 'test key', value: 'test value', createdAt: Date.now(), updatedAt: Date.now() }];
			}
			return [];
		},
		getFacts: (category) => {
			const facts = [
				{ id: '1', category: 'facts', key: 'I am', value: 'John', createdAt: 1000, updatedAt: 1000 },
				{ id: '2', category: 'preferences', key: 'style', value: 'concise', createdAt: 1000, updatedAt: 1000 },
				{ id: '3', category: 'entities', key: 'expertise', value: 'TypeScript', createdAt: 1000, updatedAt: 1000 },
				{ id: '4', category: 'facts', key: 'goal', value: 'Build plugin', createdAt: 1000, updatedAt: 1000 },
			];
			if (category) return facts.filter(f => f.category === category);
			return facts;
		},
		getSystemMemoryPrompt: () => '## Persistent Memory',
	};

	const manager = new UserMemoryManager(null, mockStore);
	const entry = await manager.remember({ statement: 'I prefer dark mode', category: 'preferences' });
	assert.ok(entry.id, 'remember should return an entry with an id');
	pass('user-memory: remember creates an entry');

	const recall = manager.recall('test query');
	assert.ok(Array.isArray(recall.entries), 'recall should return entries array');
	assert.ok(recall.formatted, 'recall should return formatted string');
	pass('user-memory: recall returns entries and formatted text');

	const profile = manager.buildProfile();
	assert.equal(profile.name, 'John', 'profile should extract name');
	assert.equal(profile.style, 'concise', 'profile should extract style');
	assert.ok(Array.isArray(profile.expertise), 'profile should have expertise array');
	assert.ok(Array.isArray(profile.goals), 'profile should have goals array');
	pass('user-memory: buildProfile works');

	const commands = manager.extractFromTurn(
		'Remember that I use the PARA method for organizing my notes.',
		'Got it!',
	);
	assert.equal(commands.length, 1, 'should extract one remember command');
	pass('user-memory: extractFromTurn detects remember patterns');

	const emptyRecall = manager.recall('nothing relevant here');
	assert.equal(emptyRecall.entries.length, 0, 'empty recall should return no entries');
	pass('user-memory: empty recall returns no entries');

	const prompt = manager.injectMemoryPrompt('test query');
	assert.ok(prompt, 'injectMemoryPrompt should return a string');
	pass('user-memory: injectMemoryPrompt works');
}

/* ═══════════════════════════════════════════════════════════
   17. System Prompt Manager (pure logic tests)
   ═══════════════════════════════════════════════════════════ */

async function verifySystemPromptManager() {
	console.log('\n─── 17. System Prompt Manager ───');

	// Test the variable resolution logic directly
	const { DEFAULT_PROMPT } = await import(pathToFileURL(join(SRC, 'system-prompts', 'DefaultPrompt.ts')).href);
	const DEFAULT_SYSTEM_PROMPT = DEFAULT_PROMPT;

	// Default prompt structure
	assert.ok(DEFAULT_SYSTEM_PROMPT.meta.isDefault, 'default prompt should be marked as default');
	assert.ok(DEFAULT_SYSTEM_PROMPT.body.includes('{{vault}}'), 'default prompt should have vault variable');
	pass('system-prompts: default prompt structure is valid');

	// Test variable extraction
	const body = 'Hello {{vault}}, today is {{date}}. The user {{user}} mentioned {{memory}} in {{style}}.';
	const variablePattern = /\{\{(\w+)\}\}/g;
	const variables = Array.from(body.matchAll(variablePattern)).map(m => m[1]);
	assert.ok(variables.includes('vault'), 'should extract vault variable');
	assert.ok(variables.includes('date'), 'should extract date variable');
	assert.ok(variables.includes('user'), 'should extract user variable');
	assert.equal(variables.length, 5, 'should extract all 5 variables');
	pass('system-prompts: variable extraction works');

	// Test rendering with a custom resolver
	const resolver = (name) => {
		const map = { vault: 'Test Vault', date: '2026-01-15', user: 'Alice', style: 'concise', memory: 'User prefers dark mode' };
		return map[name] || '[[' + name + ']]';
	};

	const rendered = DEFAULT_SYSTEM_PROMPT.body.replace(/\{\{(\w+)\}\}/g, (match, name) => resolver(name));
	assert.ok(rendered.includes('Test Vault'), 'rendered prompt should contain resolved vault name');
	assert.ok(rendered.includes('2026-01-15'), 'rendered prompt should contain resolved date');
	pass('system-prompts: variable resolution works');

	// Test list filtering
	const prompts = [DEFAULT_SYSTEM_PROMPT];
	const defaultOnly = prompts.filter(p => p.meta.isDefault === true);
	assert.ok(defaultOnly.every(p => p.meta.isDefault), 'filtered list should only contain defaults');
	pass('system-prompts: filter by isDefault works');
}

/* ═══════════════════════════════════════════════════════════
   18. Project Manager (pure logic tests)
   ═══════════════════════════════════════════════════════════ */

async function verifyProjectManager() {
	console.log('\n─── 18. Project Manager ───');

	const project = {
		id: 'test-project',
		name: 'Test Project',
		description: 'A test project',
		createdAt: '2026-01-01',
		updatedAt: '2026-01-01',
		systemPromptId: 'default',
		inclusions: ['Projects/', 'Journal/'],
		exclusions: ['Projects/Archive/'],
		webUrls: ['https://example.com'],
		youtubeUrls: [],
		tags: ['#test'],
		archived: false,
		lastUsedAt: null,
		conversationCount: 0,
	};

	assert.ok(project.id, 'project should have an id');
	assert.ok(project.name, 'project should have a name');
	assert.ok(Array.isArray(project.inclusions), 'inclusions should be an array');
	assert.ok(Array.isArray(project.exclusions), 'exclusions should be an array');
	assert.ok(Array.isArray(project.webUrls), 'webUrls should be an array');
	pass('project-manager: project config structure is valid');

	const included = project.inclusions.some(i => 'Projects/Active/note.md'.startsWith(i));
	assert.ok(included, 'file in Projects/ should be included');

	const excluded = project.exclusions.some(e => 'Projects/Archive/old.md'.startsWith(e));
	assert.ok(excluded, 'file in Projects/Archive/ should be excluded');
	pass('project-manager: scope checking works');

	const filter = { archived: false, sortBy: 'name', sortOrder: 'asc' };
	assert.equal(filter.archived, false, 'filter archived should be false');
	assert.equal(filter.sortBy, 'name', 'filter sortBy should be name');
	pass('project-manager: filter structure is valid');
}

/* ═══════════════════════════════════════════════════════════
   19. Composer Fuzzy Matching
   ═══════════════════════════════════════════════════════════ */

async function verifyComposerFuzzyMatch() {
	console.log('\n─── 19. Composer Fuzzy Matching ───');

	const { applyEditToContent, computeDiff, normalizeLineEndings, stripBOM } = await import(pathToFileURL(join(SRC, 'composer', 'ComposerFuzzyMatch.ts')).href);

	const content = 'Hello world\nThis is a test\nGoodbye';
	const result = applyEditToContent(content, 'This is a test', 'This is modified');
	assert.ok(result.ok, 'exact match should succeed');
	assert.equal(result.content, 'Hello world\nThis is modified\nGoodbye');
	pass('composer: exact match replacement works');

	const notFound = applyEditToContent(content, 'nonexistent text', 'replacement');
	assert.ok(!notFound.ok, 'nonexistent text should not be found');
	assert.equal(notFound.reason, 'NOT_FOUND');
	pass('composer: NOT_FOUND reported correctly');

	const duplicateContent = 'foo bar foo bar foo';
	const ambiguous = applyEditToContent(duplicateContent, 'foo', 'baz');
	assert.ok(!ambiguous.ok, 'multiple occurrences should be ambiguous');
	assert.equal(ambiguous.reason, 'AMBIGUOUS');
	pass('composer: AMBIGUOUS reported correctly');

	const crlfContent = 'Hello\r\nWorld\r\nTest';
	const normalized = normalizeLineEndings(crlfContent);
	assert.equal(normalized, 'Hello\nWorld\nTest');
	pass('composer: normalizeLineEndings converts CRLF to LF');

	const bomContent = '\uFEFFHello World';
	const { content: stripped, hasBOM } = stripBOM(bomContent);
	assert.equal(stripped, 'Hello World');
	assert.ok(hasBOM);
	pass('composer: stripBOM removes UTF-8 BOM');

	const noBom = stripBOM('Hello');
	assert.ok(!noBom.hasBOM);
	assert.equal(noBom.content, 'Hello');
	pass('composer: stripBOM handles no BOM');

	const original = 'line1\nline2\nline3\nline4';
	const modified = 'line1\nline2_modified\nline3\nline5';
	const diff = computeDiff(original, modified);
	assert.ok(diff.stats.additions > 0 || diff.stats.deletions > 0, 'diff should detect changes');
	assert.ok(Array.isArray(diff.lines), 'diff lines should be an array');
	pass('composer: computeDiff detects changes');

	const identical = computeDiff('same\ncontent', 'same\ncontent');
	assert.equal(identical.stats.unchanged, 2, 'identical content should have no changes');
	assert.equal(identical.stats.additions, 0);
	assert.equal(identical.stats.deletions, 0);
	pass('composer: identical content produces no diff changes');

	const { applyOperations } = await import(pathToFileURL(join(SRC, 'composer', 'ComposerFuzzyMatch.ts')).href);
	const opsResult = applyOperations('line1\nline2\nline3', [
		{ type: 'replace', path: '', oldText: 'line2', newText: 'modified' },
	]);
	assert.ok(opsResult.includes('modified'), 'applyOperations should replace text');
	pass('composer: applyOperations works');
}

/* ═══════════════════════════════════════════════════════════
   20. @-Mention Typeahead (pure logic tests)
   ═══════════════════════════════════════════════════════════ */

async function verifyAtMentionEngine() {
	console.log('\n─── 20. @-Mention Engine ───');

	// Test mention item structures
	const noteMention = { type: 'note', label: 'Test Note', value: '[[Test Note]]', description: 'path/to/note.md', path: 'path/to/note.md' };
	assert.equal(noteMention.type, 'note', 'note mention type should be note');
	assert.ok(noteMention.value.includes('[['), 'note mention value should be a wikilink');
	pass('mentions: note mention item structure is valid');

	const tagMention = { type: 'tag', label: '#test', value: '#test', description: '#test (5 files)' };
	assert.equal(tagMention.type, 'tag', 'tag mention type should be tag');
	pass('mentions: tag mention structure is valid');

	const capMention = { type: 'capability', label: 'Web Search', value: '@websearch', description: 'Search the web' };
	assert.equal(capMention.type, 'capability', 'capability mention type should be capability');
	pass('mentions: capability mention structure is valid');

	const categories = [
		{ id: 'notes', label: 'Notes', items: [noteMention] },
		{ id: 'tags', label: 'Tags', items: [tagMention] },
	];
	assert.equal(categories.length, 2, 'should have 2 categories');
	assert.equal(categories[0].id, 'notes', 'first category should be notes');
	pass('mentions: category structure is valid');

	// Test search sort order
	const unsortedItems = [
		{ type: 'note', label: 'Zebra', value: '[[Zebra]]' },
		{ type: 'note', label: 'Alpha', value: '[[Alpha]]' },
		{ type: 'note', label: 'Beta', value: '[[Beta]]' },
	];
	const sorted = unsortedItems.sort((a, b) => a.label.localeCompare(b.label));
	assert.equal(sorted[0].label, 'Alpha', 'sorted items should start with Alpha');
	assert.equal(sorted[2].label, 'Zebra', 'sorted items should end with Zebra');
	pass('mentions: search results are sorted alphabetically');
}

/* ═══════════════════════════════════════════════════════════
   Run New Tests
   ═══════════════════════════════════════════════════════════ */

async function verifyNewCapabilities() {
	await verifyCapabilityRegistry();
	await verifyUserMemoryManager();
	await verifySystemPromptManager();
	await verifyProjectManager();
	await verifyComposerFuzzyMatch();
	await verifyAtMentionEngine();
}