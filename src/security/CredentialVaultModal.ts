import { App, Modal, Notice } from 'obsidian';
import type CommandCenterPlugin from '../main';
import type { ProviderId } from '../providers/provider-types';
import { PROVIDER_REGISTRY } from '../providers/provider-registry';

const PROVIDERS = Object.keys(PROVIDER_REGISTRY) as ProviderId[];

export class CredentialVaultModal extends Modal {
	private legacyPassword = '';
	private errorEl: HTMLElement | null = null;

	constructor(app: App, private readonly plugin: CommandCenterPlugin, private readonly changed: () => void) {
		super(app);
	}

	onOpen(): void { this.render(); }
	onClose(): void { this.legacyPassword = ''; this.contentEl.empty(); }

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass('cc-credential-vault-modal');
		this.setTitle('Manage API keys');
		this.contentEl.createEl('p', {
			text: 'API keys are stored in Obsidian\'s built-in Secret Storage. New values save immediately; leaving a field blank preserves the existing secret.',
		});


		const count = this.plugin.credentialVault.count();
		this.contentEl.createEl('p', {
			cls: 'cc-credential-vault-status',
			text: count > 0
				? `${count} secret${count === 1 ? '' : 's'} stored in Obsidian Secret Storage.`
				: 'No provider secrets are stored yet.',
		});

		for (const id of PROVIDERS) {
			const meta = PROVIDER_REGISTRY[id];
			const authentication = meta.authentication ?? (meta.requiresKey ? 'required' : 'none');
			if (authentication === 'none') continue;
			const row = this.contentEl.createDiv({ cls: 'cc-credential-row' });
			const label = row.createDiv({ cls: 'cc-credential-label' });
			label.createSpan({ text: meta.label });
			label.createEl('small', { text: authentication === 'required' ? 'Required' : 'Optional bearer token' });

			const input = row.createEl('input', {
				type: 'password',
				cls: 'cc-key-input',
				attr: {
					placeholder: this.plugin.credentialVault.has(id)
						? 'Configured — enter replacement'
						: authentication === 'required'
							? 'Enter API key'
							: 'Optional API key / bearer token',
					autocomplete: 'new-password',
					spellcheck: 'false',
				},
			});
			input.addEventListener('input', () => {
				const value = input.value.trim();
				if (value) this.plugin.credentialVault.set(id, value);
				this.syncRowState(id, input, remove);
			});
			input.addEventListener('blur', () => {
				if (input.value.trim()) return;
				this.syncRowState(id, input, remove);
			});

			const remove = row.createEl('button', { text: 'Remove' });
			remove.disabled = !this.plugin.credentialVault.has(id);
			remove.addEventListener('click', () => {
				this.plugin.credentialVault.set(id, '');
				input.value = '';
				this.syncRowState(id, input, remove, true);
				this.changed();
				new Notice(`${meta.label} secret removed from Obsidian Secret Storage.`);
			});

			this.syncRowState(id, input, remove);
		}

		this.errorEl = this.contentEl.createDiv({ cls: 'cc-sync-error' });
		const actions = this.contentEl.createDiv({ cls: 'cc-provider-actions-row' });
		const close = actions.createEl('button', { text: 'Done', cls: 'mod-cta' });
		close.addEventListener('click', () => this.close());
	}

	private syncRowState(id: ProviderId, input: HTMLInputElement, remove: HTMLButtonElement, forceClearPlaceholder = false): void {
		const hasSecret = this.plugin.credentialVault.has(id);
		remove.disabled = !hasSecret;
		input.placeholder = forceClearPlaceholder
			? 'Removed'
			: hasSecret
				? 'Configured — enter replacement'
				: PROVIDER_REGISTRY[id].authentication === 'required'
					? 'Enter API key'
					: 'Optional API key / bearer token';
	}

	private showError(message: string): void { this.errorEl?.setText(message); }
}
