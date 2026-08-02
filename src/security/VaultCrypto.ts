/** Obsidian Secret Storage-backed vault boundary. */
export interface SecretStorageLike {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
	listSecrets(): string[];
}

export type DecryptedCredentials = Record<string, string>;

/**
 * Lightweight adapter around Obsidian's native Secret Storage.
 *
 * Command Center stores provider secrets in Obsidian's built-in secure store
 * instead of maintaining a custom encrypted vault file.
 */
export class MemoryCredentialVault {
	private readonly secretStorage: SecretStorageLike | null;
	private readonly namespace: string;

	constructor(secretStorage?: SecretStorageLike, namespace = 'command-center') {
		this.secretStorage = secretStorage ?? null;
		this.namespace = namespace;
	}

	get unlocked(): boolean { return this.secretStorage !== null; }

	get(providerId: string): string {
		if (!this.secretStorage) return '';
		return this.secretStorage.getSecret(this.key(providerId))?.trim() ?? '';
	}

	has(providerId: string): boolean { return Boolean(this.get(providerId)); }

	unlock(values: DecryptedCredentials): void {
		if (!this.secretStorage) throw new Error('Obsidian Secret Storage is unavailable in this environment.');
		for (const [providerId, value] of Object.entries(values)) {
			if (value.trim()) this.secretStorage.setSecret(this.key(providerId), value.trim());
		}
	}

	set(providerId: string, value: string): void {
		if (!this.secretStorage) throw new Error('Obsidian Secret Storage is unavailable in this environment.');
		this.secretStorage.setSecret(this.key(providerId), value.trim());
	}

	snapshot(): DecryptedCredentials {
		if (!this.secretStorage) return {};
		const snapshot: DecryptedCredentials = {};
		for (const secretId of this.listSecretIds()) {
			const value = this.secretStorage.getSecret(secretId)?.trim();
			if (!value) continue;
			const providerId = this.unkey(secretId);
			if (providerId) snapshot[providerId] = value;
		}
		return snapshot;
	}

	count(): number {
		if (!this.secretStorage) return 0;
		return this.listSecretIds().length;
	}

	lock(): void {
		// Secrets are persisted by Obsidian and managed through the built-in API.
	}

	private listSecretIds(): string[] {
		if (!this.secretStorage) return [];
		return this.secretStorage
			.listSecrets()
			.filter(id => id.startsWith(`${this.namespace}-`))
			.filter(id => Boolean(this.secretStorage?.getSecret(id)?.trim()));
	}

	private key(providerId: string): string {
		return `${this.namespace}-${providerId}`;
	}

	private unkey(secretId: string): string {
		return secretId.startsWith(`${this.namespace}-`) ? secretId.slice(this.namespace.length + 1) : '';
	}
}
