/** File-level coordination primitives shared by worker dispatch and vault tools. */

/** Raised when a worker cannot safely modify a path already claimed in its cycle. */
export class FileBusyError extends Error {
	readonly path: string;
	constructor(path: string) {
		super(`FileBusyError: vault note "${path}" is already being modified.`);
		this.name = 'FileBusyError';
		this.path = path;
	}
}

/** FIFO, file-level mutex. Different paths remain fully independent. */
export class FileLockManager {
	private tails = new Map<string, Promise<void>>();

	isLocked(path: string): boolean { return this.tails.has(normalizeLockPath(path)); }

	async withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
		const key = normalizeLockPath(path);
		const previous = this.tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const turn = new Promise<void>(resolve => { release = resolve; });
		const tail = previous.then(() => turn);
		this.tails.set(key, tail);
		await previous;
		try { return await operation(); }
		finally {
			release();
			if (this.tails.get(key) === tail) this.tails.delete(key);
		}
	}
}

/** One lock namespace per vault/App owner, shared by UI, CLI, and background services. */
const ownerLockManagers = new WeakMap<object, FileLockManager>();

export function getSharedFileLockManager(owner: object): FileLockManager {
	let manager = ownerLockManagers.get(owner);
	if (!manager) {
		manager = new FileLockManager();
		ownerLockManagers.set(owner, manager);
	}
	return manager;
}

export function normalizeLockPath(path: string): string {
	return path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}
