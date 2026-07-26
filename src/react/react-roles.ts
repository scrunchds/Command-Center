/**
 * Role Specialization Protocol — dynamic persona/role assignment for worker agents.
 *
 * The orchestrator can autonomously assign specialized roles to workers based on
 * task requirements. Each role defines:
 *   - A persona/identity
 *   - A specialized ReAct system prompt
 *   - Recommended tools (subset of all available tools)
 *   - Capability tags for orchestrator discovery
 *
 * Roles are additive on top of worker profiles — a 'retriever' worker can be
 * specialized as a 'researcher', 'fact-checker', or 'archivist' role, each with
 * different prompts and tool preferences.
 */

import type { ToolDefinition } from '../types';
import type { ReActAction } from './react-types';

/* ─── Role Definition ──────────────────────────────────── */

export interface AgentRole {
	/** Unique role identifier. */
	name: string;
	/** Human-readable label. */
	label: string;
	/** Base worker profile this role specializes (retriever/summarizer/editor/orchestrator). */
	baseProfile: string;
	/** Persona description injected into the system prompt. */
	persona: string;
	/** ReAct-mode system prompt override for this role. */
	systemPrompt: string;
	/** Capability tags for orchestrator discovery. */
	capabilities: string[];
	/** Tool names recommended for this role (subset of available tools). */
	recommendedTools: string[];
	/** Task patterns this role excels at (for orchestrator matching). */
	expertise: string[];
	/** Runtime-enforced allow/deny policy. Generated automatically for custom roles. */
	toolPermissions?: RoleToolPermissions;
	/** Role-specific checks injected into the worker prompt. */
	validationRules?: string[];
	/** True only for an on-the-fly role generated during a session. */
	dynamic?: boolean;
}

export interface RoleToolPermissions {
	allowed: string[];
	denied: string[];
	/** Destructive writes require an explicit action target. */
	requireTargetPathForWrite: boolean;
}

const KNOWN_ROLE_TOOLS = ['read_note', 'write_note', 'append_note', 'search_vault', 'searchVault', 'list_files', 'get_active_note'] as const;
const PROFILE_TOOL_CEILINGS: Record<string, readonly string[]> = {
	retriever: ['read_note', 'search_vault', 'searchVault', 'list_files', 'get_active_note'],
	summarizer: ['read_note', 'search_vault', 'searchVault', 'get_active_note'],
	editor: ['read_note', 'write_note', 'append_note', 'search_vault', 'searchVault', 'get_active_note'],
	orchestrator: ['read_note', 'search_vault', 'searchVault', 'list_files', 'get_active_note'],
};

/* ─── Role Registry ─────────────────────────────────────── */

function staticRole(
	name: string, label: string, baseProfile: string, persona: string, focus: string,
	capabilities: string[], recommendedTools: string[], expertise: string[],
): AgentRole {
	return {
		name, label, baseProfile, persona, capabilities, recommendedTools, expertise,
		systemPrompt: `You are the ${label.toLowerCase()} agent. ${focus}

Work iteratively: inspect evidence, use only available tools, verify the result, then return JSON with finalAnswer. Available tools: ${recommendedTools.join(', ')}.`,
	};
}

export const ROLE_REGISTRY: AgentRole[] = [
	staticRole('researcher', 'Researcher', 'retriever',
		'Meticulous vault researcher who cross-references sources and reports paths and direct evidence.',
		'Find and synthesize vault information; broaden, drill down, and cross-reference before reporting.',
		['search', 'retrieve', 'cross-reference', 'synthesize'], ['search_vault', 'read_note', 'list_files', 'get_active_note'],
		['finding information', 'vault exploration', 'cross-referencing', 'literature review']),
	staticRole('analyst', 'Analyst', 'summarizer',
		'Sharp analyst who extracts patterns, contradictions, gaps, themes, and actionable conclusions.',
		'Produce structured analysis with key points, themes, actions, and a concise summary.',
		['analyze', 'summarize', 'pattern-recognition', 'structure'], ['read_note', 'search_vault', 'get_active_note'],
		['data analysis', 'pattern recognition', 'summarization', 'trend identification']),
	staticRole('writer', 'Writer', 'editor',
		'Technical writer who creates clear, concise, well-structured content with formatting and citations.',
		'Draft, review, polish, and format content for the requested audience and target.',
		['write', 'edit', 'format', 'cite'], ['read_note', 'write_note', 'append_note', 'search_vault'],
		['content creation', 'technical writing', 'documentation', 'editing']),
	staticRole('reviewer', 'Reviewer', 'editor',
		'Critical reviewer who identifies quality issues and proposes specific, prioritized improvements.',
		'Evaluate clarity, accuracy, completeness, structure, and tone; separate findings from recommendations.',
		['review', 'critique', 'improve', 'quality-assurance'], ['read_note', 'search_vault', 'write_note', 'append_note'],
		['code review', 'content review', 'quality assurance', 'feedback']),
	staticRole('planner', 'Planner', 'orchestrator',
		'Strategic planner who decomposes complex goals into actionable dependency-aware roadmaps.',
		'Identify constraints, ordered steps, prerequisites, effort, ownership, and completion criteria.',
		['plan', 'structure', 'decompose', 'estimate'], ['read_note', 'search_vault', 'list_files'],
		['project planning', 'task decomposition', 'workflow design', 'estimation']),
	staticRole('fact-checker', 'Fact Checker', 'retriever',
		'Rigorous fact-checker who verifies claims against vault sources and flags unsupported statements.',
		'Classify each claim as verified, refuted, or unverifiable and cite supporting paths.',
		['verify', 'fact-check', 'cite', 'validate'], ['search_vault', 'read_note', 'get_active_note'],
		['fact verification', 'claim checking', 'source validation', 'accuracy']),
];

/* ─── Registry Lookup ───────────────────────────────────── */

/** Runtime registry for dynamically discovered/created roles. */
const dynamicRoles = new Map<string, AgentRole>();

/** Find a role by exact name (checks dynamic roles first). */
export function getRole(name: string): AgentRole | undefined {
	const dyn = dynamicRoles.get(name);
	if (dyn) return dyn;
	return ROLE_REGISTRY.find(r => r.name === name);
}

/** List all available roles (static + dynamic). */
export function listRoles(): AgentRole[] {
	return [...ROLE_REGISTRY, ...dynamicRoles.values()];
}

/** Find roles matching a capability or expertise tag. */
export function findRolesByCapability(capability: string): AgentRole[] {
	const q = capability.toLowerCase();
	return ROLE_REGISTRY.filter(r =>
		r.capabilities.some(c => c.toLowerCase().includes(q)) ||
		r.expertise.some(e => e.toLowerCase().includes(q))
	);
}

/** Build a human-readable role catalog for the orchestrator prompt. */
export function buildRoleCatalog(): string {
	const allRoles = [...ROLE_REGISTRY, ...dynamicRoles.values()];
	return allRoles.map(r =>
		`- **${r.label}** (\`${r.name}\`) — ${r.persona.slice(0, 120)}... [base: ${r.baseProfile}, tools: ${r.recommendedTools.join(', ')}]`
	).join('\n');
}

/* ─── Dynamic Role Registration ─────────────────────────── */

/**
 * Register a new role at runtime (e.g., discovered by the orchestrator
 * during a ReAct session or created from a user prompt).
 * Returns false if a role with the same name already exists.
 */
export function registerDynamicRole(role: AgentRole): boolean {
	const name = role.name.trim().toLowerCase();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
		ROLE_REGISTRY.some(r => r.name === name) || dynamicRoles.has(name)) {
		return false;
	}

	const generated = generateDynamicRolePolicy({ ...role, name });
	dynamicRoles.set(name, generated);
	return true;
}

/** Derive least-privilege tool permissions and output checks from a runtime persona. */
function generateDynamicRolePolicy(role: AgentRole): AgentRole {
	const ceiling = PROFILE_TOOL_CEILINGS[role.baseProfile] ?? PROFILE_TOOL_CEILINGS['retriever']!;
	const requested = role.recommendedTools.filter((tool, index, tools) =>
		KNOWN_ROLE_TOOLS.includes(tool as typeof KNOWN_ROLE_TOOLS[number]) && tools.indexOf(tool) === index
	);
	const allowed = (requested.length > 0 ? requested : inferTools(role)).filter(tool => ceiling.includes(tool));
	// A custom role must never gain arbitrary tools or write access outside an editor profile.
	const safeAllowed = allowed.length > 0 ? allowed : ceiling.filter(tool => tool !== 'write_note' && tool !== 'append_note').slice(0, 2);
	const denied = KNOWN_ROLE_TOOLS.filter(tool => !safeAllowed.includes(tool));
	const validationRules = inferValidationRules(role, safeAllowed);
	return {
		...role,
		name: role.name.trim().toLowerCase(),
		label: role.label.trim() || role.name,
		persona: role.persona.slice(0, 600),
		recommendedTools: [...safeAllowed],
		toolPermissions: {
			allowed: [...safeAllowed],
			denied: [...denied],
			requireTargetPathForWrite: safeAllowed.includes('write_note') || safeAllowed.includes('append_note'),
		},
		validationRules,
		dynamic: true,
	};
}

function inferTools(role: AgentRole): string[] {
	const signals = `${role.persona} ${role.capabilities.join(' ')} ${role.expertise.join(' ')}`.toLowerCase();
	const tools = new Set<string>();
	if (/search|research|find|fact|verify|source|cite/.test(signals)) tools.add('search_vault');
	if (/read|review|analy|summar|source|fact|document/.test(signals)) tools.add('read_note');
	if (/inventory|catalog|archive|file|structure/.test(signals)) tools.add('list_files');
	if (/active|current note/.test(signals)) tools.add('get_active_note');
	if (role.baseProfile === 'editor' && /write|edit|author|draft|update|refactor/.test(signals)) tools.add('write_note');
	if (role.baseProfile === 'editor' && /append|extend|add/.test(signals)) tools.add('append_note');
	return [...tools];
}

function inferValidationRules(role: AgentRole, allowedTools: string[]): string[] {
	const signals = `${role.name} ${role.persona} ${role.capabilities.join(' ')} ${role.expertise.join(' ')}`.toLowerCase();
	const rules = [
		'Satisfy the action expectedOutput explicitly before returning finalAnswer.',
		'Do not claim a tool result, source, or file change that was not observed.',
	];
	if (/research|search|fact|verify|source|cite/.test(signals)) rules.push('Cite vault paths for material claims and mark unsupported claims as unverified.');
	if (/review|critic|quality|audit/.test(signals)) rules.push('Separate observed defects from suggestions and assign a concrete severity or priority.');
	if (/analy|summar|pattern/.test(signals)) rules.push('Distinguish evidence, inference, contradictions, and unresolved gaps.');
	if (/plan|architect|strategy|decompos/.test(signals)) rules.push('Include ordered steps, dependencies, constraints, and completion criteria.');
	if (/write|edit|author|draft|refactor/.test(signals)) rules.push('Preserve unrelated content and report the exact path and scope of every proposed change.');
	if (allowedTools.includes('write_note') || allowedTools.includes('append_note')) rules.push('Never call write_note or append_note without the explicit target path from the action.');
	return rules;
}

/**
 * Unregister a dynamically added role. Static roles cannot be removed.
 * Returns false if the role is static or doesn't exist.
 */
export function unregisterDynamicRole(name: string): boolean {
	if (ROLE_REGISTRY.some(r => r.name === name)) return false;
	return dynamicRoles.delete(name);
}

/** Get all dynamically registered roles. */
export function listDynamicRoles(): AgentRole[] {
	return [...dynamicRoles.values()];
}

/**
 * Build a prompt snippet for the orchestrator that enables it to
 * define a new custom role when no existing role fits the task.
 */
export function buildDynamicRoleCreationPrompt(): string {
	return `## Dynamic Role Creation
If no built-in role fits, add customRole with: kebab-case name, concise persona, 2-4 capabilities, and only required tools from read_note, write_note, append_note, search_vault, list_files, get_active_note. Runtime least-privilege policy restricts tools by worker profile; writes require an editor and explicit targetPath.
Example: {"worker":"retriever","role":"code-archaeologist","customRole":{"name":"code-archaeologist","persona":"Trace decisions to primary sources.","capabilities":["code-search","source-validation"],"recommendedTools":["search_vault","read_note"]},"prompt":"...","expectedOutput":"..."}`;
}

/**
 * Try to register a dynamic role from an incoming ReActAction that
 * includes a customRole definition. Returns the role name if successful.
 */
export function tryRegisterDynamicRole(action: ReActAction & { customRole?: Partial<AgentRole> }): string | null {
	if (!action.customRole?.name || !action.customRole?.persona) return null;
	const cr = action.customRole;
	const role: AgentRole = {
		name: cr.name!,
		label: cr.label ?? cr.name!,
		baseProfile: action.worker,
		persona: cr.persona!,
		systemPrompt: cr.systemPrompt ?? `You are a ${cr.name} agent. ${cr.persona!}\n\nWork step by step. Use tools as needed. Return a finalAnswer when done.`,
		capabilities: cr.capabilities ?? [],
		recommendedTools: cr.recommendedTools ?? [],
		expertise: cr.expertise ?? [],
	};
	const ok = registerDynamicRole(role);
	return ok ? role.name : null;
}

/* ─── Prompt & Tool Helpers ─────────────────────────────── */

/**
 * Build a ReAct-structured prompt for a worker with an assigned role.
 * If no role is specified, falls back to the default worker prompt.
 */
export function buildRolePrompt(
	action: ReActAction & { role?: string },
): string {
	const role = action.role ? getRole(action.role) : undefined;

	if (role) {
		const permissions = role.toolPermissions
			? `\n## Runtime Tool Permissions\nAllowed: ${role.toolPermissions.allowed.join(', ') || '(none)'}\nDenied: ${role.toolPermissions.denied.join(', ') || '(none)'}${role.toolPermissions.requireTargetPathForWrite ? '\nwrite_note and append_note require the explicit target path in this action.' : ''}`
			: '';
		const validation = role.validationRules?.length
			? `\n## Validation Rules\n${role.validationRules.map((rule, index) => `${index + 1}. ${rule}`).join('\n')}`
			: '';
		return `${role.systemPrompt}${permissions}${validation}

## Task
${action.prompt.slice(0, 3000)}${action.targetPath ? `\n**Target path:** ${action.targetPath}` : ''}

## Expected Output
${action.expectedOutput}

## Instructions
Work through this task step by step using your specialized role as ${role.label}. Use tools as needed. When done, return a JSON object with your finalAnswer.`;
	}

	// Fallback: generic worker prompt
	return `You are a ${action.worker} agent.

## Task
${action.prompt.slice(0, 3000)}${action.targetPath ? `\n**Target path:** ${action.targetPath}` : ''}

## Expected Output
${action.expectedOutput}

Work step by step. Use tools as needed. Return a finalAnswer when done.`;
}

/**
 * Filter tools to only those recommended for a given role.
 * If no role or the role has no recommendations, returns all tools.
 */
export function filterToolsForRole(roleName: string | undefined, allTools: ToolDefinition[]): ToolDefinition[] {
	if (!roleName) return allTools;
	const role = getRole(roleName);
	if (!role || role.recommendedTools.length === 0) return allTools;
	const allowed = role.toolPermissions?.allowed ?? role.recommendedTools;
	const denied = new Set(role.toolPermissions?.denied ?? []);
	return allTools.filter(tool => {
		const equivalentName = tool.name === 'searchVault' ? 'search_vault' : tool.name;
		return (allowed.includes(tool.name) || allowed.includes(equivalentName)) &&
			!denied.has(tool.name) && !denied.has(equivalentName);
	});
}