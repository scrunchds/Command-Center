import { App, Modal, Notice } from 'obsidian';
import type CommandCenterPlugin from '../main';
import type { ProviderId } from '../providers/provider-types';
import { PROVIDER_REGISTRY } from '../providers/provider-registry';
import { decryptCredentials, encryptCredentials } from './VaultCrypto';

const PROVIDERS = Object.keys(PROVIDER_REGISTRY) as ProviderId[];

export class CredentialVaultModal extends Modal {
	private password = '';
	private errorEl: HTMLElement | null = null;

	constructor(app: App, private readonly plugin: CommandCenterPlugin, private readonly changed: () => void) {
		super(app);
	}

	onOpen(): void { this.renderUnlock(); }
	onClose(): void { this.password = ''; this.contentEl.empty(); }

	private renderUnlock(): void {
		this.contentEl.empty();
		this.setTitle('Air-Gapped Credential Vault');
		this.contentEl.createEl('p', { text: 'The master password and decrypted API keys remain in memory only.' });
		const input = this.contentEl.createEl('input', { type: 'password', cls: 'cc-key-input', attr: { placeholder: 'Vault Master Key', autocomplete: 'current-password', spellcheck: 'false' } });
		input.addEventListener('input', () => { this.password = input.value; });
		this.errorEl = this.contentEl.createDiv({ cls: 'cc-sync-error' });
		const actions = this.contentEl.createDiv({ cls: 'cc-provider-actions-row' });
		const unlock = actions.createEl('button', { text: this.plugin.settings.encryptedCredentialVault ? 'Unlock' : 'Create Vault', cls: 'mod-cta' });
		unlock.addEventListener('click', () => { void this.unlock(); });
		if (this.plugin.credentialVault.unlocked) {
			const manage = actions.createEl('button', { text: 'Manage Credentials' });
			manage.addEventListener('click', () => this.renderEditor());
		}
		const lock = actions.createEl('button', { text: 'Lock' });
		lock.addEventListener('click', () => {
			this.plugin.credentialVault.lock();
			this.plugin.providerFactory.invalidate();
			this.changed(); this.close();
			new Notice('Credential vault locked. Cloud routing is disabled.');
		});
	}

	private async unlock(): Promise<void> {
		if (!this.password) return this.showError('Enter the Vault Master Key.');
		try {
			const payload = this.plugin.settings.encryptedCredentialVault;
			this.plugin.credentialVault.unlock(payload ? await decryptCredentials(payload, this.password) : {});
			this.plugin.providerFactory.invalidate();
			this.renderEditor();
		} catch (error) { this.showError(error instanceof Error ? error.message : 'Unable to unlock credentials.'); }
	}

	private renderEditor(): void {
		if (!this.plugin.credentialVault.unlocked) return this.renderUnlock();
		this.contentEl.empty(); this.setTitle('Manage API Keys');
		this.contentEl.createEl('p', { text: 'Required and optional endpoint keys are AES-GCM encrypted. Existing keys are never displayed; empty fields preserve current values.' });
		const pending = new Map<ProviderId, string>();
		for (const id of PROVIDERS) {
			const meta = PROVIDER_REGISTRY[id];
			const authentication = meta.authentication ?? (meta.requiresKey ? 'required' : 'none');
			if (authentication === 'none') continue;
			const row = this.contentEl.createDiv({ cls: 'cc-credential-row' });
			const label = row.createDiv({ cls: 'cc-credential-label' });
			label.createSpan({ text: meta.label });
			label.createEl('small', { text: authentication === 'required' ? 'Required' : 'Optional bearer token' });
			const input = row.createEl('input', { type: 'password', cls: 'cc-key-input', attr: { placeholder: this.plugin.credentialVault.has(id) ? 'Configured — enter replacement' : authentication === 'required' ? 'Enter API key' : 'Optional API key / bearer token', autocomplete: 'new-password', spellcheck: 'false' } });
			input.addEventListener('input', () => pending.set(id, input.value));
			const remove = row.createEl('button', { text: 'Remove' });
			remove.disabled = !this.plugin.credentialVault.has(id);
			remove.addEventListener('click', () => { this.plugin.credentialVault.set(id, ''); pending.delete(id); input.value = ''; input.placeholder = 'Removed'; remove.disabled = true; });
		}
		this.errorEl = this.contentEl.createDiv({ cls: 'cc-sync-error' });
		const actions = this.contentEl.createDiv({ cls: 'cc-provider-actions-row' });
		const save = actions.createEl('button', { text: 'Encrypt and Save', cls: 'mod-cta' });
		save.addEventListener('click', () => { void this.save(pending); });
		const cancel = actions.createEl('button', { text: 'Cancel' }); cancel.addEventListener('click', () => this.close());
	}

	private async save(pending: ReadonlyMap<ProviderId, string>): Promise<void> {
		if (!this.password) return this.showError('Unlock with the Vault Master Key before saving.');
		try {
			for (const [id, value] of pending) if (value.trim()) this.plugin.credentialVault.set(id, value);
			this.plugin.settings.encryptedCredentialVault = await encryptCredentials(this.plugin.credentialVault.snapshot(), this.password);
			await this.plugin.saveSettings(); this.plugin.providerFactory.invalidate(); this.changed(); this.close();
			new Notice('Credentials encrypted and loaded into memory.');
		} catch (error) { this.showError(error instanceof Error ? error.message : 'Unable to save credentials.'); }
	}

	private showError(message: string): void { this.errorEl?.setText(message); }
}
