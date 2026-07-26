/** Data contracts for stationary Command Center folder indexes. */

/** Human-authored semantic declaration for one managed vault folder. */
export interface FolderPurposeDeclaration {
	/** Vault-relative folder path. */
	path: string;
	/** Concise reason the folder exists (normally 2–3 short lines/sentences). */
	purpose: string;
	/** Expected note/content types used for semantic routing. */
	scope?: string;
	/** Structured alternative to `scope`; rendered as a comma-separated list. */
	contentTypes?: string[];
}

/** One direct-child file represented in an `_index.md` manifest. */
export interface FileManifestEntry {
	path: string;
	description: string;
	/** Markdown-ready status, such as `` `status: active` ``. */
	status: string;
	/** Local timestamp formatted as YYYY-MM-DD HH:mm. */
	lastModified: string;
}

/** Metadata describing one generated stationary index. */
export interface FolderIndexMetadata {
	folderPath: string;
	folderName: string;
	indexPath: string;
	purpose: string;
	scope: string;
	generatedAt: string;
	fileCount: number;
	manifest: FileManifestEntry[];
}

export interface FolderIndexResult extends FolderIndexMetadata {
	operation: 'created' | 'updated' | 'unchanged';
}

/** Token-efficient semantic routing header read from an index. */
export interface FolderPurposeHeader {
	folderPath: string;
	purpose: string;
	scope: string;
}

export interface FolderMatch extends FolderPurposeHeader {
	score: number;
}

export interface FolderIndexerOptions {
	/** Delay used to coalesce vault events. Defaults to 750ms. */
	debounceMs?: number;
	/** Maximum characters retained from a note-derived summary. Defaults to 180. */
	maxSummaryLength?: number;
	/** Frontmatter keys checked, in order, for manifest state. */
	statusKeys?: string[];
}
