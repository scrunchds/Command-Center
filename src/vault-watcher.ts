/**
 * Vault Watcher — polls vault for file changes using Obsidian's native Vault API.
 *
 * No direct fs access: uses vault.getFiles() / vault.getAbstractFileByPath()
 * so it works in desktop and mobile Obsidian consistently.
 */

import { Vault, TFile } from 'obsidian';
import type { VaultEvent, VaultEventType } from './types';

export type VaultWatcherCallback = (event: VaultEvent) => void;

export class VaultWatcher {
	private vault: Vault;
	private callbacks: VaultWatcherCallback[] = [];
	private knownFiles = new Map<string, number>(); // path → mtime
	private pollTimer: number | null = null;
	private debounceMs: number;

	constructor(vault: Vault, debounceMs: number = 2000) {
		this.vault = vault;
		this.debounceMs = debounceMs;
	}

	start(): void {
		if (this.pollTimer) return;
		this.snapshot();
		this.pollTimer = window.setInterval(() => this.poll(), 3000);
	}

	stop(): void {
		if (this.pollTimer) { window.clearInterval(this.pollTimer); this.pollTimer = null; }
	}

	on(callback: VaultWatcherCallback): void { this.callbacks.push(callback); }
	off(callback: VaultWatcherCallback): void { this.callbacks = this.callbacks.filter(cb => cb !== callback); }
	isWatching(): boolean { return this.pollTimer !== null; }

	private snapshot(): void {
		for (const file of this.vault.getFiles()) {
			this.knownFiles.set(file.path, file.stat.mtime);
		}
	}

	private poll(): void {
		const current = new Map<string, number>();
		const files = this.vault.getFiles();

		for (const file of files) {
			current.set(file.path, file.stat.mtime);
			const prev = this.knownFiles.get(file.path);
			if (prev === undefined) {
				this.emit({ type: 'created', filePath: file.path, timestamp: Date.now() });
			} else if (file.stat.mtime > prev) {
				this.emit({ type: 'modified', filePath: file.path, timestamp: Date.now() });
			}
		}

		// Detect deletions
		for (const [path] of this.knownFiles) {
			if (!current.has(path)) {
				this.emit({ type: 'deleted', filePath: path, timestamp: Date.now() });
			}
		}

		this.knownFiles = current;
	}

	private emit(event: VaultEvent): void {
		for (const cb of this.callbacks) {
			try { cb(event); } catch { /* guard */ }
		}
	}
}
