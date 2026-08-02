const VERSION = 1 as const;
const PBKDF2_ITERATIONS = 310_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

export interface EncryptedCredentialPayload {
	version: typeof VERSION;
	algorithm: 'AES-GCM';
	kdf: 'PBKDF2-SHA-256';
	iterations: number;
	salt: string;
	iv: string;
	ciphertext: string;
}

export type DecryptedCredentials = Record<string, string>;

function webCrypto(): Crypto {
	if (!window.crypto?.subtle) throw new Error('Web Crypto is unavailable.');
	return window.crypto;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number, usage: KeyUsage): Promise<CryptoKey> {
	if (!password) throw new Error('The Vault Master Key is required.');
	const passwordBytes = new TextEncoder().encode(password);
	try {
		const material = await webCrypto().subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
		return await webCrypto().subtle.deriveKey(
			{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
			material,
			{ name: 'AES-GCM', length: 256 },
			false,
			[usage],
		);
	} finally {
		passwordBytes.fill(0);
	}
}

export async function encryptCredentials(
	credentials: DecryptedCredentials,
	masterPassword: string,
): Promise<EncryptedCredentialPayload> {
	const crypto = webCrypto();
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
	try {
		const key = await deriveKey(masterPassword, salt, PBKDF2_ITERATIONS, 'encrypt');
		const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
		return {
			version: VERSION,
			algorithm: 'AES-GCM',
			kdf: 'PBKDF2-SHA-256',
			iterations: PBKDF2_ITERATIONS,
			salt: encodeBase64(salt),
			iv: encodeBase64(iv),
			ciphertext: encodeBase64(new Uint8Array(ciphertext)),
		};
	} finally {
		plaintext.fill(0);
	}
}

export async function decryptCredentials(
	payload: EncryptedCredentialPayload,
	masterPassword: string,
): Promise<DecryptedCredentials> {
	if (payload.version !== VERSION || payload.algorithm !== 'AES-GCM' || payload.kdf !== 'PBKDF2-SHA-256') {
		throw new Error('Unsupported encrypted credential format.');
	}
	if (!Number.isInteger(payload.iterations) || payload.iterations < 100_000) {
		throw new Error('Invalid credential derivation parameters.');
	}
	const salt = new Uint8Array(decodeBase64(payload.salt));
	const iv = new Uint8Array(decodeBase64(payload.iv));
	const ciphertext = new Uint8Array(decodeBase64(payload.ciphertext));
	try {
		const key = await deriveKey(masterPassword, salt, payload.iterations, 'decrypt');
		let cleartext: ArrayBuffer;
		try {
			cleartext = await webCrypto().subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
		} catch {
			throw new Error('Incorrect Vault Master Key or damaged credential vault.');
		}
		const bytes = new Uint8Array(cleartext);
		try {
			const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid credential vault contents.');
			const result: DecryptedCredentials = {};
			for (const [id, value] of Object.entries(parsed)) if (typeof value === 'string' && value) result[id] = value;
			return result;
		} finally {
			bytes.fill(0);
		}
	} finally {
		salt.fill(0);
		iv.fill(0);
		ciphertext.fill(0);
	}
}

/** Obsidian Secret Storage-backed vault boundary. */
export interface SecretStorageLike {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
	listSecrets(): string[];
}

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
