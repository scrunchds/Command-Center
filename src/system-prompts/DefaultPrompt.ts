/**
 * Default system prompt — isolated from obsidian imports so it can be
 * imported by tests without triggering the full module chain.
 */

import type { SystemPrompt } from './SystemPromptManager';

export const DEFAULT_PROMPT: SystemPrompt = {
	meta: {
		id: 'default',
		name: 'Default Assistant',
		description: 'A helpful, general-purpose assistant persona.',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		isDefault: true,
		variables: ['vault', 'date', 'time'],
		category: 'general',
	},
	body: `You are a helpful assistant integrated into the Obsidian vault "{{vault}}".

Current date: {{date}}
Current time: {{time}}

Answer the user's questions based on your knowledge and the context provided.
Be concise, accurate, and cite sources when possible.
{{style}}
{{memory}}`,
};