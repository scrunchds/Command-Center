/**
 * Vault Watcher — observes file changes via Obsidian's native vault events.
 *
 * Uses vault.on('create'|'modify'|'delete'|'rename') instead of polling
 * getFiles(), which is more efficient and avoids guideline violations.
 *
 * The public API (start/stop/on/off) is unchanged from the polling version,
 * so existing consumers need no updates.
 */

import { Vault, EventRef } from 'obsidian';
import type { VaultEvent } from './types';

export type VaultWatcherCallback = (event: VaultEvent) => void;

export class VaultWatcher {
	private vault: Vault;
	private callbacks: VaultWatcherCallback[] = [];
	private started = false;
	private refs: EventRef[] = [];

	constructor(vault: Vault) {
		this.vault = vault;
	}

	start(): void {
		if (this.started) return;
		this.started = true;

		// Register native vault event listeners
		this.refs.push(this.vault.on('create', (file) => {
			this.emit({ type: 'created', filePath: file.path, timestamp: Date.now() });
		}));

		this.refs.push(this.vault.on('modify', (file) => {
			this.emit({ type: 'modified', filePath: file.path, timestamp: Date.now() });
		}));

		this.refs.push(this.vault.on('delete', (file) => {
			this.emit({ type: 'deleted', filePath: file.path, timestamp: Date.now() });
		}));

		this.refs.push(this.vault.on('rename', (file, oldPath) => {
			this.emit({ type: 'deleted', filePath: oldPath, timestamp: Date.now() });
			this.emit({ type: 'created', filePath: file.path, timestamp: Date.now() });
		}));
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		// Detach all event listeners
		for (const ref of this.refs) {
			try { this.vault.offref(ref); } catch { /* guard */ }
		}
		this.refs = [];
	}

	on(callback: VaultWatcherCallback): void { this.callbacks.push(callback); }
	off(callback: VaultWatcherCallback): void { this.callbacks = this.callbacks.filter(cb => cb !== callback); }
	isWatching(): boolean { return this.started; }

	private emit(event: VaultEvent): void {
		for (const cb of this.callbacks) {
			try { cb(event); } catch { /* guard */ }
		}
	}
}