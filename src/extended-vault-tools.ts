/**
 * Extended Vault Tools — additional vault mutation operations for the
 * Capability Registry and agent tool surface.
 *
 * Provides: edit_note, delete_note, create_folder, delete_folder,
 * rename_note, move_note
 *
 * Every tool enforces the same sanitization, locking, and confirmation
 * patterns as the base obsidian-tools.ts.
 */

import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type { ToolDefinition, ToolConfirmationRequest } from './types';

import { getCapabilityRegistry } from './capabilities/CapabilityRegistry';
import { getSharedFileLockManager } from './file-lock';

const SANITIZE = {
	MAX_PATH_LENGTH: 512,
	// eslint-disable-next-line no-control-regex -- null/control chars in regex used for input sanitization.
	FORBIDDEN_PATH_CHARS: /[\u0000-\u001f<>:"|?*\u007f]/,
	MAX_ERROR_LENGTH: 256,
};

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000;

function sanitizePath(raw: unknown): [true, string] | [false, string] {
	if (typeof raw !== 'string' || raw.length === 0) return [false, 'Path must be a non-empty string.'];
	if (raw.length > SANITIZE.MAX_PATH_LENGTH) return [false, `Path too long (max ${SANITIZE.MAX_PATH_LENGTH} chars).`];
	if (SANITIZE.FORBIDDEN_PATH_CHARS.test(raw)) return [false, 'Path contains forbidden characters.'];
	if (raw.includes('..')) return [false, 'Path traversal (..) not allowed.'];
	if (/^[a-zA-Z]:[\\/]/.test(raw)) return [false, 'Absolute Windows paths not allowed.'];
	const cleaned = normalizePath(raw.trim());
	if (!cleaned || cleaned === '.') return [false, 'Path is empty after normalization.'];
	return [true, cleaned];
}

function sanitizeError(err: unknown): string {
	let msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
	msg = msg.replace(/(?:[A-Za-z]:[\\/]|\/[^\s:]*\/)[^\s:]*/g, '[path]').replace(/\\/g, '/');
	return msg.length > SANITIZE.MAX_ERROR_LENGTH ? msg.slice(0, SANITIZE.MAX_ERROR_LENGTH) + '...' : msg;
}

function okRsp(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: 'text', text }], details };
}

function errRsp(text: string) {
	return { content: [{ type: 'text', text }], details: { isError: true } };
}

function confirmDelete(app: App, toolName: string, params: Record<string, unknown>): ToolConfirmationRequest | null {
	const [ok, path] = sanitizePath(params.path);
	if (!ok) return null;
	const file = app.vault.getAbstractFileByPath(path);
	if (file instanceof TFile) {
		return { toolName, targetPaths: [path], proposedChanges: `Delete note: ${path}`, timeoutMs: DEFAULT_CONFIRMATION_TIMEOUT_MS };
	}
	if (file instanceof TFolder) {
		return { toolName, targetPaths: [path], proposedChanges: `Delete folder: ${path}`, timeoutMs: DEFAULT_CONFIRMATION_TIMEOUT_MS };
	}
	return null;
}

/* ─── edit_note ─────────────────────────────────────────── */

export function createEditNoteTool(app: App): ToolDefinition {
	return {
		name: 'edit_note', label: 'Edit Note',
		description: 'Apply a targeted search-and-replace edit to an existing note. Provide surrounding context for uniqueness.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'Note path' },
			oldText: { type: 'string', description: 'Text to find (include surrounding lines for uniqueness)' },
			newText: { type: 'string', description: 'Replacement text' },
		}, required: ['path', 'oldText', 'newText'] },
		confirmation: (params: Record<string, unknown>): Promise<ToolConfirmationRequest | null> => {
			const [ok, path] = sanitizePath(params.path);
			if (!ok) return Promise.resolve(null);
			return Promise.resolve({
				toolName: 'edit_note',
				targetPaths: [path],
				proposedChanges: `Replace "${String(params.oldText).slice(0, 200)}" with "${String(params.newText).slice(0, 200)}"`,
				timeoutMs: DEFAULT_CONFIRMATION_TIMEOUT_MS,
			});
		},
		execute: async (_id: string, params: Record<string, unknown>) => {
			try {
				const [ok, path] = sanitizePath(params.path);
				if (!ok) return errRsp(path);
				if (typeof params.oldText !== 'string' || !params.oldText) return errRsp('oldText must be a non-empty string.');
				if (typeof params.newText !== 'string') return errRsp('newText must be a string.');

				return await getSharedFileLockManager(app).withLock(path, async () => {
					const file = app.vault.getAbstractFileByPath(path);
					if (!file || !(file instanceof TFile)) return errRsp('Note not found.');

					const raw = await app.vault.read(file);
					const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
					const oldNorm = (params.oldText as string).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
					const newNorm = (params.newText as string).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

					const idx = normalized.indexOf(oldNorm);
					if (idx === -1) return errRsp('Could not find the specified text. Try including more surrounding context.');

					const modified = normalized.slice(0, idx) + newNorm + normalized.slice(idx + oldNorm.length);
					await app.vault.modify(file, modified);
					return okRsp('Edit applied successfully.', { path });
				});
			} catch (err) { return errRsp(sanitizeError(err)); }
		},
	};
}

/* ─── delete_note ───────────────────────────────────────── */

export function createDeleteNoteTool(app: App): ToolDefinition {
	return {
		name: 'delete_note', label: 'Delete Note',
		description: 'Move a note to Obsidian trash.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'Note path to delete' },
		}, required: ['path'] },
		confirmation: (params: Record<string, unknown>): Promise<ToolConfirmationRequest | null> =>
			Promise.resolve(confirmDelete(app, 'delete_note', params)),
		execute: async (_id: string, params: Record<string, unknown>) => {
			try {
				const [ok, path] = sanitizePath(params.path);
				if (!ok) return errRsp(path);
				const file = app.vault.getAbstractFileByPath(path);
				if (!file || !(file instanceof TFile)) return errRsp('Note not found.');
				await app.fileManager.trashFile(file);
				return okRsp('Note moved to trash.', { path });
			} catch (err) { return errRsp(sanitizeError(err)); }
		},
	};
}

/* ─── create_folder ─────────────────────────────────────── */

export function createCreateFolderTool(app: App): ToolDefinition {
	return {
		name: 'create_folder', label: 'Create Folder',
		description: 'Create a new folder in the vault. Parent folders are created automatically.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'Folder path to create (e.g., "Projects/New Project")' },
		}, required: ['path'] },
		confirmation: (params: Record<string, unknown>): Promise<ToolConfirmationRequest | null> => {
			const [ok, path] = sanitizePath(params.path);
			if (!ok) return Promise.resolve(null);
			return Promise.resolve({
				toolName: 'create_folder',
				targetPaths: [path],
				proposedChanges: `Create folder: ${path}`,
				timeoutMs: DEFAULT_CONFIRMATION_TIMEOUT_MS,
			});
		},
		execute: async (_id: string, params: Record<string, unknown>) => {
			try {
				const [ok, path] = sanitizePath(params.path);
				if (!ok) return errRsp(path);
				const existing = app.vault.getAbstractFileByPath(path);
				if (existing instanceof TFolder) return okRsp('Folder already exists.', { path });
				if (existing) return errRsp(`A file blocks folder creation at ${path}.`);
				await ensureFolder(app, path);
				return okRsp('Folder created.', { path });
			} catch (err) { return errRsp(sanitizeError(err)); }
		},
	};
}

/** Recursively create a folder and any missing parents, mirroring the
 * tool's documented "parent folders are created automatically" contract.
 * Obsidian's vault.createFolder throws when the parent is absent, so the
 * agent would otherwise loop on nested managed-folder paths during onboarding. */
async function ensureFolder(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	if (!normalized || normalized === '.') return;
	const entry = app.vault.getAbstractFileByPath(normalized);
	if (entry instanceof TFolder) return;
	if (entry) throw new Error(`A file blocks folder creation at ${normalized}.`);
	const parent = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
	if (parent) await ensureFolder(app, parent);
	await app.vault.createFolder(normalized);
}

/** Create the parent folder chain for a target file/folder path before a
 * renameFile call. Obsidian's renameFile fails when the destination parent
 * folder does not exist, so an agent renaming or moving into a proposed
 * (but not yet created) folder would otherwise fail and retry in a loop. */
async function ensureParentOf(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	const at = normalized.lastIndexOf('/');
	if (at <= 0) return;
	await ensureFolder(app, normalized.slice(0, at));
}

/* ─── delete_folder ─────────────────────────────────────── */

export function createDeleteFolderTool(app: App): ToolDefinition {
	return {
		name: 'delete_folder', label: 'Delete Folder',
		description: 'Delete a folder from the vault. All contents are moved to trash.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'Folder path to delete' },
		}, required: ['path'] },
		confirmation: (params: Record<string, unknown>): Promise<ToolConfirmationRequest | null> =>
			Promise.resolve(confirmDelete(app, 'delete_folder', params)),
		execute: async (_id: string, params: Record<string, unknown>) => {
			try {
				const [ok, path] = sanitizePath(params.path);
				if (!ok) return errRsp(path);
				const folder = app.vault.getAbstractFileByPath(path);
				if (!folder || !(folder instanceof TFolder)) return errRsp('Folder not found.');
				// Trash the folder and all its contents in one operation. This respects
				// the user's file-deletion preference (system trash vs. local trash)
				// via FileManager.trashFile, matching the tool's 'moved to trash' contract.
				await app.fileManager.trashFile(folder);
				return okRsp('Folder deleted.', { path });
			} catch (err) { return errRsp(sanitizeError(err)); }
		},
	};
}

/* ─── rename_note ───────────────────────────────────────── */

export function createRenameNoteTool(app: App): ToolDefinition {
	return {
		name: 'rename_note', label: 'Rename File',
		description: 'Rename a vault note or folder. Pass a new path (filename or folder path).',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'Current file or folder path' },
			newPath: { type: 'string', description: 'New file or folder path' },
		}, required: ['path', 'newPath'] },
		confirmation: (params: Record<string, unknown>): Promise<ToolConfirmationRequest | null> => {
			const [ok, path] = sanitizePath(params.path);
			if (!ok) return Promise.resolve(null);
			const file = app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) && !(file instanceof TFolder)) return Promise.resolve(null);
			return Promise.resolve({
				toolName: 'rename_note',
				targetPaths: [path],
				proposedChanges: `Rename: ${path} → ${String(params.newPath)}`,
				timeoutMs: DEFAULT_CONFIRMATION_TIMEOUT_MS,
			});
		},
		execute: async (_id: string, params: Record<string, unknown>) => {
			try {
				const [ok, path] = sanitizePath(params.path);
				if (!ok) return errRsp(path);
				const [ok2, newPath] = sanitizePath(params.newPath);
				if (!ok2) return errRsp(newPath);
				const file = app.vault.getAbstractFileByPath(path);
				if (!file || (!(file instanceof TFile) && !(file instanceof TFolder))) return errRsp('File or folder not found.');
				await ensureParentOf(app, newPath);
				await app.fileManager.renameFile(file, newPath);
				return okRsp('Renamed successfully.', { path, newPath });
			} catch (err) { return errRsp(sanitizeError(err)); }
		},
	};
}

/* ─── move_note ─────────────────────────────────────────── */

export function createMoveNoteTool(app: App): ToolDefinition {
	return {
		name: 'move_note', label: 'Move File',
		description: 'Move a note or folder to a different destination folder.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'Current file or folder path' },
			destination: { type: 'string', description: 'Destination folder path (e.g., "Projects/Archive/")' },
		}, required: ['path', 'destination'] },
		confirmation: (params: Record<string, unknown>): Promise<ToolConfirmationRequest | null> => {
			const [ok, path] = sanitizePath(params.path);
			if (!ok) return Promise.resolve(null);
			const file = app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile) && !(file instanceof TFolder)) return Promise.resolve(null);
			return Promise.resolve({
				toolName: 'move_note',
				targetPaths: [path],
				proposedChanges: `Move: ${path} → ${String(params.destination)}`,
				timeoutMs: DEFAULT_CONFIRMATION_TIMEOUT_MS,
			});
		},
		execute: async (_id: string, params: Record<string, unknown>) => {
			try {
				const [ok, path] = sanitizePath(params.path);
				if (!ok) return errRsp(path);
				const [ok2, dest] = sanitizePath(params.destination);
				if (!ok2) return errRsp(dest);
				const file = app.vault.getAbstractFileByPath(path);
				if (!file || (!(file instanceof TFile) && !(file instanceof TFolder))) return errRsp('File or folder not found.');
				const fileName = path.split('/').pop() ?? path;
				const newPath = dest.endsWith('/') ? dest + fileName : dest + '/' + fileName;
				await ensureFolder(app, dest.endsWith('/') ? dest.slice(0, -1) : dest);
				await app.fileManager.renameFile(file, newPath);
				return okRsp('Moved successfully.', { path, newPath });
			} catch (err) { return errRsp(sanitizeError(err)); }
		},
	};
}

/**
 * Register all extended vault tools into the Capability Registry.
 */
export function registerExtendedVaultTools(app: App): void {
	const registry = getCapabilityRegistry();

	const tools: Array<{ tool: ToolDefinition; destructive: boolean }> = [
		{ tool: createEditNoteTool(app), destructive: false },
		{ tool: createDeleteNoteTool(app), destructive: true },
		{ tool: createCreateFolderTool(app), destructive: false },
		{ tool: createDeleteFolderTool(app), destructive: true },
		{ tool: createRenameNoteTool(app), destructive: false },
		{ tool: createMoveNoteTool(app), destructive: false },
	];

	for (const { tool, destructive } of tools) {
		registry.register(tool, {
			id: `vault-${tool.name}`,
			label: tool.label,
			description: tool.description,
			category: 'file',
			executionMode: 'autonomous',
			confirmationPolicy: destructive ? 'always' : 'on-threshold',
			requiresVault: true,
			timeoutMs: 0,
		});
	}
}