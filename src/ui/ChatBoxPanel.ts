/**
 * ChatBoxPanel — a lightweight, always-on conversational surface for the
 * dashboard.
 *
 * Distinct from the Orchestrator widget: the Orchestrator is the workflow-
 * building surface (reasoning tier, proposals routed to Mutation approvals).
 * The Chatbox is a fast, simple Q&A — ask anything, get a streamed answer,
 * no workflow scaffolding. It reuses the same ModelRouter backend so every
 * configured provider and fallback applies, but it asks the fast tier for
 * snappy responses.
 *
 * Conversation state is in-memory only; closing the dashboard clears it. This
 * keeps the widget stateless and predictable, matching the calendar's detail
 * pane rather than the persistent orchestrator log.
 */

import { type App, setIcon } from 'obsidian';

export interface ChatBoxRouteResult {
	/** Final assembled content, if the call succeeded. */
	content: string;
	/** Error message, if the call failed. */
	error?: string;
}

export interface ChatBoxPanelOptions {
	/**
	 * Route a prompt through the plugin's ModelRouter, streaming deltas back.
	 * The panel is agnostic to how this is implemented so it stays testable.
	 */
	routePrompt: (prompt: string, onStream: (delta: string) => void) => Promise<ChatBoxRouteResult>;
	/** Optional read-aloud hook; when omitted the "Read aloud" button is hidden. */
	onSpeak?: (text: string) => void;
}

interface ChatMessage {
	role: 'user' | 'assistant' | 'error';
	text: string;
}

const MAX_MESSAGES = 60;

export class ChatBoxPanel {
	private hostEl: HTMLElement | null = null;
	private messagesEl: HTMLElement | null = null;
	private inputEl: HTMLTextAreaElement | null = null;
	private sendEl: HTMLButtonElement | null = null;
	private readonly messages: ChatMessage[] = [];
	private busy = false;

	constructor(
		private readonly app: App,
		private readonly options: ChatBoxPanelOptions,
	) {}

	/** Attach the panel's DOM to `host`. Idempotent. */
	mount(host: HTMLElement): void {
		this.hostEl = host;
		host.empty();
		host.addClass('cc-chatbox');

		this.messagesEl = host.createDiv({
			cls: 'cc-chatbox-messages',
			attr: { role: 'log', 'aria-live': 'polite', 'aria-label': 'Chatbox conversation' },
		});

		this.inputEl = host.createEl('textarea', {
			cls: 'cc-chatbox-input',
			attr: {
				rows: '2',
				placeholder: 'Ask anything…',
				'aria-label': 'Chatbox prompt',
			},
		});

		const controls = host.createDiv({ cls: 'cc-chatbox-controls' });
		this.sendEl = controls.createEl('button', {
			cls: 'cc-chatbox-send',
			text: 'Send',
			attr: { 'aria-label': 'Send chatbox prompt' },
		});
		controls.createDiv({
			cls: 'cc-chatbox-hint',
			text: 'Enter to send · Shift+Enter for a new line',
		});

		this.renderWelcome();

		this.sendEl.addEventListener('click', () => void this.submit());
		this.inputEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void this.submit();
			}
		});
		this.inputEl.addEventListener('input', () => this.resizeInput());
		this.resizeInput();
	}

	dispose(): void {
		this.hostEl = null;
		this.messagesEl = null;
		this.inputEl = null;
		this.sendEl = null;
	}

	/** Focus the input — used when the operator jumps to this widget. */
	focusInput(): void {
		this.inputEl?.focus();
	}

	private resizeInput(): void {
		const el = this.inputEl;
		if (!el) return;
		const minimum = 44;
		const maximum = 160;
		el.setCssStyles({ height: 'auto', overflowY: 'hidden' });
		const height = Math.min(maximum, Math.max(minimum, el.scrollHeight));
		el.setCssStyles({ height: `${height}px`, overflowY: el.scrollHeight > maximum ? 'auto' : 'hidden' });
	}

	private renderWelcome(): void {
		if (!this.messagesEl) return;
		this.messagesEl.empty();
		const row = this.messagesEl.createDiv({ cls: 'cc-chatbox-message is-assistant is-welcome' });
		row.createDiv({ text: 'Quick chat ready. Ask a question and I will answer straight away — no workflow proposals, no approvals.', cls: 'cc-chatbox-bubble' });
	}

	private appendMessage(role: ChatMessage['role'], text: string): HTMLElement | null {
		if (!this.messagesEl) return null;
		// Trim very old messages so the panel never grows unbounded.
		this.messages.push({ role, text });
		if (this.messages.length > MAX_MESSAGES) {
			this.messages.shift();
			const first = this.messagesEl.firstElementChild;
			if (first instanceof HTMLElement) first.remove();
		}
		const row = this.messagesEl.createDiv({ cls: `cc-chatbox-message is-${role}` });
		const bubble = row.createDiv({ cls: 'cc-chatbox-bubble' });
		bubble.setText(text);
		if (role === 'assistant' && text.trim() && this.options.onSpeak) {
			const read = bubble.createEl('button', {
				cls: 'cc-chatbox-read',
				attr: { 'aria-label': 'Read answer aloud', title: 'Read aloud' },
			});
			setIcon(read, 'volume-2');
			read.addEventListener('click', () => this.options.onSpeak?.(text));
		}
		this.scrollToBottom();
		return bubble;
	}

	private scrollToBottom(): void {
		const el = this.messagesEl;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}

	private async submit(): Promise<void> {
		const el = this.inputEl;
		const send = this.sendEl;
		if (!el || !send || this.busy) return;
		const prompt = el.value.trim();
		if (!prompt) return;
		this.busy = true;
		send.disabled = true;
		el.value = '';
		this.resizeInput();

		this.appendMessage('user', prompt);
		const responseBubble = this.appendMessage('assistant', '');
		if (responseBubble) {
			responseBubble.addClass('is-typing');
			responseBubble.createSpan({ cls: 'cc-chatbox-typing', text: '…' });
		}

		let streamed = '';
		try {
			const result = await this.options.routePrompt(
				prompt,
				(delta) => {
					if (!delta) return;
					streamed += delta;
					if (responseBubble) {
						const typing = responseBubble.querySelector('.cc-chatbox-typing');
						if (typing) typing.remove();
						responseBubble.removeClass('is-typing');
						responseBubble.appendText(delta);
						this.scrollToBottom();
					}
				},
			);
			if (responseBubble) {
				const typing = responseBubble.querySelector('.cc-chatbox-typing');
				if (typing) typing.remove();
				responseBubble.removeClass('is-typing');
				if (result.error) {
					// Replace the partial/empty bubble with the error via a fresh message.
					responseBubble.setText(result.error);
					responseBubble.parentElement?.addClass('is-error');
				} else if (!streamed) {
					responseBubble.setText(result.content || 'Done.');
				}
			}
			this.scrollToBottom();
		} catch (error) {
			if (responseBubble) {
				responseBubble.setText((error as Error).message || 'Request failed.');
				responseBubble.parentElement?.addClass('is-error');
			}
		} finally {
			this.busy = false;
			send.disabled = false;
			this.scrollToBottom();
		}
	}
}
