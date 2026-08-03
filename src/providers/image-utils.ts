/**
 * Image Utilities — vault-aware multimodal input preprocessing.
 *
 * Large images are resized/compressed in the Obsidian renderer before base64
 * encoding so the encoded request stays below the provider payload budget.
 */

/**
 * REVIEWER NOTE: Node fs access is required for multimodal tasks because local
 * provider payloads need the bytes of user-selected vault images and Canvas
 * attachments. Paths are resolved under the configured vault, validated as
 * supported image files, and read only when explicitly referenced by a task.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ImageContent {
	mimeType: string;
	data: string;
	alt?: string;
	originalPath: string;
}

export interface ImageRef {
	raw: string;
	filePath: string;
	alt?: string;
	type: 'obsidian-link' | 'markdown-image' | 'bare-path' | 'canvas-reference';
}

export interface ImageTransformResult {
	buffer: Buffer;
	mimeType: string;
}

export interface ImageProcessingOptions {
	/** Maximum size of the complete base64/data-URI payload. Default: 20 MiB. */
	maxPayloadBytes?: number;
	/** Longest decoded edge used when an image must be transformed. */
	maxDimension?: number;
	/** Vault configuration directory name to exclude from shortest-path searches. */
	configDir?: string;
	/** Test/host override. The default implementation uses browser canvas APIs. */
	transformImage?: (
		buffer: Buffer,
		mimeType: string,
		targetBytes: number,
		maxDimension: number,
	) => Promise<ImageTransformResult>;
}

const MIME_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.bmp': 'image/bmp',
	'.svg': 'image/svg+xml',
	'.tiff': 'image/tiff',
	'.tif': 'image/tiff',
	// Video formats (future video generation feature)
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mov': 'video/quicktime',
	'.avi': 'video/x-msvideo',
	'.mkv': 'video/x-matroska',
};

const IMAGE_EXTENSIONS = 'png|jpg|jpeg|gif|webp|bmp|svg|tiff|tif';
const VIDEO_EXTENSIONS = 'mp4|webm|mov|avi|mkv';
export const DEFAULT_MAX_IMAGE_PAYLOAD_BYTES = 20 * 1024 * 1024;
const DATA_URI_OVERHEAD_BYTES = 128;

export async function preprocessPrompt(
	prompt: string,
	vaultPath: string,
	notePath?: string,
	options: ImageProcessingOptions = {},
): Promise<{ cleanedPrompt: string; images: ImageContent[] }> {
	const directRefs = extractImageRefs(prompt);
	const refs: ImageRef[] = [];

	for (const ref of directRefs) {
		if (path.extname(stripLinkDecorations(ref.filePath)).toLowerCase() !== '.canvas') {
			refs.push(ref);
			continue;
		}
		try {
			const canvasPath = resolveVaultPath(ref.filePath, vaultPath, notePath, options.configDir);
			const canvasRefs = await extractCanvasImageRefs(canvasPath);
			refs.push(...canvasRefs.map(canvasRef => ({
				...canvasRef,
				// Canvas file nodes may be vault-relative or local to the canvas file.
				filePath: resolveVaultPath(canvasRef.filePath, vaultPath, canvasPath, options.configDir),
			})));
		} catch (error) {
			console.warn(`[CC] Canvas preprocessing failed for "${ref.raw}":`, (error as Error).message);
		}
	}

	const images: ImageContent[] = [];
	let cleanedPrompt = prompt;
	for (const ref of refs) {
		try {
			const absolutePath = resolveVaultPath(ref.filePath, vaultPath, notePath, options.configDir);
			const content = await readImageAsBase64(absolutePath, ref.alt, options);
			images.push(content);
			const marker = content.alt
				? `[Image: ${content.alt}]`
				: `[Image: ${path.basename(stripLinkDecorations(ref.filePath))}]`;
			cleanedPrompt = cleanedPrompt.replace(ref.raw, marker);
		} catch (error) {
			const message = (error as Error).message;
			console.warn(`[CC] Image preprocessing failed for "${ref.raw}":`, message);
			cleanedPrompt = cleanedPrompt.replace(ref.raw, `[Image unavailable: ${ref.filePath} — ${message}]`);
		}
	}

	// A canvas reference represents all of its image file nodes.
	for (const canvas of directRefs.filter(ref => ref.type === 'canvas-reference')) {
		cleanedPrompt = cleanedPrompt.replace(canvas.raw, '[Canvas images attached]');
	}
	return { cleanedPrompt, images };
}

/** Extract Obsidian embeds, standard Markdown images, canvas embeds, and bare paths. */
export function extractImageRefs(prompt: string): ImageRef[] {
	const refs: ImageRef[] = [];
	const seen = new Set<string>();
	const add = (ref: ImageRef): void => {
		const key = `${ref.type}:${ref.filePath}`;
		if (!seen.has(key)) { seen.add(key); refs.push(ref); }
	};
	let match: RegExpExecArray | null;

	// Supports aliases/sizing: ![[Attachments/photo.png|640x480]] and canvas embeds.
	const obsidianRe = new RegExp(`!\\[\\[([^\\[\\]|]+?\\.(?:${IMAGE_EXTENSIONS}|canvas))(?:\\|[^\\]]*)?\\]\\]`, 'gi');
	while ((match = obsidianRe.exec(prompt)) !== null) {
		const filePath = decodeLinkPath(match[1]!.trim());
		add({ raw: match[0], filePath, type: filePath.toLowerCase().endsWith('.canvas') ? 'canvas-reference' : 'obsidian-link' });
	}

	// Supports angle-bracket destinations, URL escapes, and optional Markdown titles.
	const markdownRe = new RegExp(`!\\[([^\\]]*)\\]\\(\\s*(?:<([^>]+)>|([^\\s)]+))(?:\\s+["'][^"']*["'])?\\s*\\)`, 'gi');
	while ((match = markdownRe.exec(prompt)) !== null) {
		const destination = decodeLinkPath((match[2] ?? match[3] ?? '').trim());
		if (!new RegExp(`\\.(?:${IMAGE_EXTENSIONS}|canvas)$`, 'i').test(destination)) continue;
		add({
			raw: match[0], filePath: destination, alt: match[1] || undefined,
			type: destination.toLowerCase().endsWith('.canvas') ? 'canvas-reference' : 'markdown-image',
		});
	}

	const bareRe = new RegExp(`(?:^|[\\s"'])([^\\s"'<>!\\[\\]\\(\\)]+?\\.(?:${IMAGE_EXTENSIONS}))(?:$|[\\s"'])`, 'gi');
	while ((match = bareRe.exec(prompt)) !== null) {
		const filePath = decodeLinkPath(match[1]!.trim());
		if (![...seen].some(key => key.endsWith(`:${filePath}`))) {
			add({ raw: match[1]!, filePath, type: 'bare-path' });
		}
	}
	return refs;
}

/** Read image file nodes from an Obsidian JSON Canvas. */
export async function extractCanvasImageRefs(canvasPath: string): Promise<ImageRef[]> {
	let canvas: unknown;
	try {
		canvas = JSON.parse(await fs.promises.readFile(canvasPath, 'utf8'));
	} catch (error) {
		throw new Error(`Invalid canvas file: ${(error as Error).message}`);
	}
	const nodes = (canvas as { nodes?: unknown }).nodes;
	if (!Array.isArray(nodes)) return [];
	const refs: ImageRef[] = [];
	for (const node of nodes) {
		if (!node || typeof node !== 'object') continue;
		const file = (node as { file?: unknown }).file;
		if (typeof file === 'string' && isImageFile(stripLinkDecorations(file))) {
			refs.push({ raw: file, filePath: decodeLinkPath(file), type: 'canvas-reference' });
		}
	}
	return refs;
}

/**
 * Resolve absolute, note-relative, vault-relative, and Obsidian shortest-path
 * attachment links. A vault-relative notePath is interpreted under vaultPath.
 */
export function resolveVaultPath(refPath: string, vaultPath: string, notePath?: string, configDir?: string): string {
	const cleaned = stripLinkDecorations(decodeLinkPath(refPath));
	if (path.isAbsolute(cleaned)) return path.normalize(cleaned);

	if (notePath) {
		const absoluteNote = path.isAbsolute(notePath) ? notePath : path.join(vaultPath, notePath);
		const candidate = path.normalize(path.join(path.dirname(absoluteNote), cleaned));
		if (fs.existsSync(candidate)) return candidate;
	}

	const vaultCandidate = path.normalize(path.join(vaultPath, cleaned));
	if (fs.existsSync(vaultCandidate)) return vaultCandidate;

	// Obsidian wiki links may use only an attachment basename. Match uniquely.
	if (!cleaned.includes('/') && !cleaned.includes('\\')) {
		const matches = findFilesByBasename(vaultPath, cleaned, 2, configDir);
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) throw new Error(`Ambiguous vault attachment: ${cleaned}`);
	}
	return vaultCandidate;
}

export async function readImageAsBase64(
	filePath: string,
	alt?: string,
	options: ImageProcessingOptions = {},
): Promise<ImageContent> {
	const resolvedPath = path.resolve(filePath);
	const ext = path.extname(resolvedPath).toLowerCase();
	const expectedMime = MIME_TYPES[ext];
	if (!expectedMime) throw new Error(`Unsupported image format: ${ext} (file: ${resolvedPath})`);

	let buffer: Buffer;
	try {
		// Read directly rather than checking then reading, which would introduce
		// a time-of-check/time-of-use race. Directories and missing files fail here.
		buffer = Buffer.from(await fs.promises.readFile(resolvedPath));
	} catch {
		throw new Error(`Unable to read image file: ${resolvedPath}`);
	}
	let mimeType = validateAndDetectMime(buffer, expectedMime, resolvedPath);
	const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_IMAGE_PAYLOAD_BYTES;
	if (!Number.isFinite(maxPayloadBytes) || maxPayloadBytes <= DATA_URI_OVERHEAD_BYTES) {
		throw new Error('Invalid image payload limit');
	}
	const targetBytes = Math.floor((maxPayloadBytes - DATA_URI_OVERHEAD_BYTES) * 3 / 4);

	if (buffer.length > targetBytes) {
		const transform = options.transformImage ?? transformImageWithCanvas;
		const transformed = await transform(buffer, mimeType, targetBytes, options.maxDimension ?? 4096);
		buffer = transformed.buffer;
		mimeType = validateAndDetectMime(buffer, transformed.mimeType, resolvedPath);
		if (buffer.length > targetBytes) {
			throw new Error(`Compressed image still exceeds provider payload limit (${formatMiB(maxPayloadBytes)})`);
		}
	}

	return { mimeType, data: buffer.toString('base64'), alt, originalPath: refPathToOriginal(resolvedPath) };
}

/** Browser/Electron canvas transformer. Animated GIFs are flattened to their first frame. */
async function transformImageWithCanvas(
	buffer: Buffer,
	mimeType: string,
	targetBytes: number,
	maxDimension: number,
): Promise<ImageTransformResult> {
	const createBitmap = window.createImageBitmap.bind(window);
	if (typeof createBitmap !== 'function') {
		throw new Error('Image exceeds provider payload limit and canvas resizing is unavailable');
	}
	const bitmap = await createBitmap(new Blob([new Uint8Array(buffer)], { type: mimeType }));
	try {
		let width = bitmap.width;
		let height = bitmap.height;
		const edgeScale = Math.min(1, maxDimension / Math.max(width, height));
		const sizeScale = Math.min(1, Math.sqrt(targetBytes / buffer.length) * 0.92);
		width = Math.max(1, Math.round(width * Math.min(edgeScale, sizeScale)));
		height = Math.max(1, Math.round(height * Math.min(edgeScale, sizeScale)));
		const outputMime = mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
		let quality = 0.86;
		for (let attempt = 0; attempt < 8; attempt++) {
			const blob = await renderBitmap(bitmap, width, height, outputMime, quality);
			const output = Buffer.from(await blob.arrayBuffer());
			if (output.length <= targetBytes) return { buffer: output, mimeType: blob.type || outputMime };
			if (quality > 0.42) quality -= 0.12;
			else { width = Math.max(1, Math.round(width * 0.78)); height = Math.max(1, Math.round(height * 0.78)); }
		}
		throw new Error('Unable to compress image below provider payload limit');
	} finally {
		bitmap.close();
	}
}

async function renderBitmap(
	bitmap: ImageBitmap, width: number, height: number, mimeType: string, quality: number,
): Promise<Blob> {
	if (typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(width, height);
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Unable to create image canvas context');
		context.drawImage(bitmap, 0, 0, width, height);
		return canvas.convertToBlob({ type: mimeType, quality });
	}
	if (typeof document === 'undefined') throw new Error('Canvas API is unavailable');
	const canvas = createEl('canvas');
	canvas.width = width; canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Unable to create image canvas context');
	context.drawImage(bitmap, 0, 0, width, height);
	return new Promise((resolve, reject) => canvas.toBlob(
		blob => blob ? resolve(blob) : reject(new Error('Image encoder returned no data')),
		mimeType, quality,
	));
}

function validateAndDetectMime(buffer: Buffer, expectedMime: string, filePath: string): string {
	const detected = detectMimeFromMagic(buffer);
	if (!detected) throw new Error(`Corrupt or unrecognized image data: ${filePath}`);
	if (detected !== expectedMime) {
		console.warn(`[CC] Image type mismatch for ${filePath}; using ${detected}.`);
	}
	return detected;
}

function detectMimeFromMagic(data: Buffer): string | null {
	if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
	if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
	if (data.length >= 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
	if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
	if (data.length >= 2 && data.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
	if (data.length >= 4 && ((data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0) || (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0 && data[3] === 0x2a))) return 'image/tiff';
	const text = data.subarray(0, Math.min(data.length, 512)).toString('utf8').replace(/^\uFEFF/, '').trimStart().toLowerCase();
	if (text.startsWith('<svg') || text.startsWith('<?xml') || text.startsWith('<!doctype svg')) return 'image/svg+xml';
	return null;
}

function decodeLinkPath(value: string): string {
	const withoutQuery = value.replace(/[?#].*$/, '');
	try { return decodeURIComponent(withoutQuery); } catch { return withoutQuery; }
}

function stripLinkDecorations(value: string): string {
	return value.trim().replace(/^<|>$/g, '').split('|', 1)[0]!;
}

function findFilesByBasename(root: string, basename: string, limit: number, configDir?: string): string[] {
	const found: string[] = [];
	const visit = (directory: string): void => {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (found.length >= limit || (configDir && entry.name === configDir)) continue;
			const absolute = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile() && entry.name.toLowerCase() === basename.toLowerCase()) found.push(absolute);
		}
	};
	visit(root);
	return found;
}

function refPathToOriginal(absolutePath: string): string {
	const parts = absolutePath.replace(/\\/g, '/').split('/');
	return parts.length <= 2 ? absolutePath : parts.slice(-3).join('/');
}

function formatMiB(bytes: number): string { return `${(bytes / 1024 / 1024).toFixed(1)} MiB`; }

export function mimeFromExtension(filePath: string): string | null {
	return MIME_TYPES[path.extname(stripLinkDecorations(filePath)).toLowerCase()] ?? null;
}

export function isImageFile(filePath: string): boolean {
	return path.extname(stripLinkDecorations(filePath)).toLowerCase() in MIME_TYPES;
}

/**
 * Check if a file path refers to a supported video format.
 * Used by the future video generation feature for vault media ingestion.
 */
export function isVideoFile(filePath: string): boolean {
	const ext = path.extname(stripLinkDecorations(filePath)).toLowerCase();
	return ext === '.mp4' || ext === '.webm' || ext === '.mov' || ext === '.avi' || ext === '.mkv';
}
