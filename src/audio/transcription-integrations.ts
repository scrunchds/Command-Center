/**
 * TranscriptionIntegrations — vault-native output targets for live transcription.
 *
 * Supports three modes that can be combined:
 *   1. Live into the active note at cursor position
 *   2. Save the raw audio Blob to the vault
 *   3. Create/update a Canvas with transcription text and optional audio node
 */

import { App, Editor, TFile, TFolder, normalizePath } from 'obsidian';
import type CommandCenterPlugin from '../main';
import type { CanvasData, CanvasTextData, CanvasFileData } from 'obsidian/canvas';

export interface TranscriptionOutputOptions {
	/** Insert transcription text into the active note at cursor position. */
	insertIntoNote?: boolean;
	/** Save the raw audio recording to the vault. */
	saveAudio?: boolean;
	/** Folder path for saved audio recordings (default: 'command-center/recordings'). */
	audioFolder?: string;
	/** Create or update a Canvas with the transcription. */
	createCanvas?: boolean;
	/** Canvas filename (without extension). Auto-generated if omitted. */
	canvasName?: string;
	/** Folder for the Canvas file. */
	canvasFolder?: string;
}

export interface TranscriptionOutput {
	text: string;
	audioFile?: TFile;
	canvasFile?: TFile;
}

const DEFAULT_AUDIO_FOLDER = 'command-center/recordings';
const DEFAULT_CANVAS_FOLDER = 'command-center/transcriptions';

/**
 * Write live/interim text into the active editor at the cursor position.
 * Returns the editor instance if successful.
 */
export function insertIntoActiveEditor(app: App, text: string, replace = false): Editor | null {
	const editor = app.workspace.activeEditor?.editor;
	if (!editor) return null;

	const cursor = editor.getCursor();
	if (replace) {
		// Replace the entire current line content (used for live updates)
		const line = editor.getLine(cursor.line);
		editor.replaceRange(text, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
	} else {
		// Insert at cursor position (used for final insertion)
		editor.replaceRange(text, cursor);
	}
	return editor;
}

/**
 * Save an audio Blob to the vault as a .webm file.
 * Returns the created TFile.
 */
export async function saveAudioToVault(
	app: App,
	audio: Blob,
	folderPath = DEFAULT_AUDIO_FOLDER,
): Promise<TFile> {
	// Ensure the folder exists
	const normalizedFolder = normalizePath(folderPath);
	await ensureFolder(app, normalizedFolder);

	// Generate a timestamped filename
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const filename = `${normalizedFolder}/${timestamp}.webm`;

	// Convert Blob to ArrayBuffer
	const arrayBuffer = await audio.arrayBuffer();
	const file = await app.vault.createBinary(filename, arrayBuffer);
	return file;
}

/**
 * Create a Canvas with a text node (transcription) and optional audio file node.
 * Opens the canvas in the workspace.
 */
export async function createTranscriptionCanvas(
	app: App,
	text: string,
	audioFile?: TFile,
	folderPath = DEFAULT_CANVAS_FOLDER,
	name?: string,
): Promise<TFile> {
	const normalizedFolder = normalizePath(folderPath);
	await ensureFolder(app, normalizedFolder);

	const canvasName = name ?? `Transcription ${new Date().toISOString().slice(0, 10)}`;
	const filename = `${normalizedFolder}/${canvasName}.canvas`;

	// Check if a canvas with this name already exists
	const existing = app.vault.getAbstractFileByPath(normalizePath(filename));
	if (existing instanceof TFile) {
		// Update existing canvas: add a new text node
		await appendToCanvas(app, existing, text, audioFile);
		await app.workspace.getLeaf(false).openFile(existing);
		return existing;
	}

	// Build the canvas data with text node and optional audio node
	const nodes: (CanvasTextData | CanvasFileData)[] = [];
	const edges: { id: string; fromNode: string; fromSide: 'bottom'; toNode: string; toSide: 'top' }[] = [];

	const textNodeId = generateId();
	nodes.push({
		id: textNodeId,
		type: 'text',
		text,
		x: 100,
		y: 100,
		width: 400,
		height: Math.max(100, Math.min(600, text.length * 0.3)),
		color: '1',
	});

	if (audioFile) {
		const audioNodeId = generateId();
		nodes.push({
			id: audioNodeId,
			type: 'file',
			file: audioFile.path,
			x: 100,
			y: 600,
			width: 400,
			height: 80,
			color: '3',
		});
		edges.push({
			id: generateId(),
			fromNode: textNodeId,
			fromSide: 'bottom',
			toNode: audioNodeId,
			toSide: 'top',
		});
	}

	const canvasData: CanvasData = { nodes, edges };
	const content = JSON.stringify(canvasData, null, 2);
	const file = await app.vault.create(filename, content);
	await app.workspace.getLeaf(false).openFile(file);
	return file;
}

/**
 * Append a new text node to an existing canvas, optionally with an audio file node.
 */
async function appendToCanvas(
	app: App,
	canvasFile: TFile,
	text: string,
	audioFile?: TFile,
): Promise<void> {
	const content = await app.vault.read(canvasFile);
	let canvasData: CanvasData;
	try {
		canvasData = JSON.parse(content) as CanvasData;
	} catch {
		// If the canvas is malformed, overwrite with a fresh one
		canvasData = { nodes: [], edges: [] };
	}

	const textNodeId = generateId();
	const offsetY = canvasData.nodes.length > 0
		? Math.max(...canvasData.nodes.map(n => n.y + n.height)) + 50
		: 100;

	canvasData.nodes.push({
		id: textNodeId,
		type: 'text',
		text,
		x: 100,
		y: offsetY,
		width: 400,
		height: Math.max(100, Math.min(600, text.length * 0.3)),
		color: '1',
	});

	if (audioFile) {
		const audioNodeId = generateId();
		canvasData.nodes.push({
			id: audioNodeId,
			type: 'file',
			file: audioFile.path,
			x: 100,
			y: offsetY + 500,
			width: 400,
			height: 80,
			color: '3',
		});
		canvasData.edges.push({
			id: generateId(),
			fromNode: textNodeId,
			fromSide: 'bottom',
			toNode: audioNodeId,
			toSide: 'top',
		});
	}

	// canvasData already contains the full content (original + new nodes/edges).
	await app.vault.process(canvasFile, () => JSON.stringify(canvasData, null, 2));
}

/**
 * Insert transcription text into a note file at the cursor position.
 * Text is appended to the end of the note with a timestamp header.
 */
export async function insertIntoNoteFile(
	app: App,
	text: string,
	saveAudio?: boolean,
	audioFile?: TFile,
): Promise<void> {
	const activeFile = app.workspace.getActiveFile();
	if (!activeFile || activeFile.extension !== 'md') return;

	// Build the content to insert
	const timestamp = `> [!transcription]+ Transcription • ${new Date().toLocaleString()}\n> ${text.replace(/\n/g, '\n> ')}\n\n`;
	let insertion = timestamp;

	if (saveAudio && audioFile) {
		insertion += `🔊 [Audio recording](${encodeURI(audioFile.path)})\n\n`;
	}

	// Try to insert at cursor first, fall back to appending to the file
	const editor = app.workspace.activeEditor?.editor;
	if (editor) {
		editor.replaceRange(insertion, editor.getCursor());
	} else {
		// Append to end of file
		await app.vault.process(activeFile, (content) => content + '\n' + insertion);
	}
}

/**
 * Process all transcription outputs after a recording completes.
 */
export async function processTranscriptionOutput(
	plugin: CommandCenterPlugin,
	text: string,
	audioBlob?: Blob,
	options: TranscriptionOutputOptions = {},
): Promise<TranscriptionOutput> {
	const result: TranscriptionOutput = { text };
	const { app } = plugin;

	// 1. Save audio file if requested
	if (options.saveAudio && audioBlob) {
		try {
			result.audioFile = await saveAudioToVault(app, audioBlob, options.audioFolder);
		} catch (error) {
			console.error('Failed to save audio recording:', error);
		}
	}

	// 2. Insert into active note if requested
	if (options.insertIntoNote) {
		try {
			await insertIntoNoteFile(app, text, options.saveAudio, result.audioFile);
		} catch (error) {
			console.error('Failed to insert into note:', error);
		}
	}

	// 3. Create/update Canvas if requested
	if (options.createCanvas) {
		try {
			result.canvasFile = await createTranscriptionCanvas(
				app,
				text,
				result.audioFile,
				options.canvasFolder,
				options.canvasName,
			);
		} catch (error) {
			console.error('Failed to create transcription canvas:', error);
		}
	}

	return result;
}

/* ─── Helpers ──────────────────────────────────────────── */

function generateId(): string {
	return `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureFolder(app: App, path: string): Promise<TFolder> {
	const normalized = normalizePath(path);
	const existing = app.vault.getAbstractFileByPath(normalized);
	if (existing instanceof TFolder) return existing;

	const parent = normalizePath(normalized.split('/').slice(0, -1).join('/') || '/');
	await ensureFolder(app, parent);
	return await app.vault.createFolder(normalized);
}