import { App, Modal, Setting } from 'obsidian';

/**
 * Minimal single-text-input modal for collecting a natural-language workflow
 * goal. Resolves with the entered text on submit, or `null` if the operator
 * cancels (Esc / close). Mirrors the lifecycle of `collectWorkflowInputs`.
 */
export class GoalPromptModal extends Modal {
	private inputEl!: HTMLTextAreaElement;
	private settled = false;

	constructor(
		app: App,
		private readonly resolve: (goal: string | null) => void,
	) {
		super(app);
	}

	static prompt(app: App): Promise<string | null> {
		return new Promise<string | null>(resolve => new GoalPromptModal(app, resolve).open());
	}

	open(): void {
		super.open();
		this.titleEl.setText('Generate & run agentic workflow');
		const content = this.contentEl.createDiv({ cls: 'cc-goal-prompt' });
		content.createEl('p', {
			text: 'Describe a goal. Command center will design a multi-step workflow whose steps run as autonomous, tool-calling sub-agents, then ask you to approve it before execution.',
		});
		const setting = new Setting(content).setName('Goal');
		this.inputEl = setting.controlEl.createEl('textarea', {
			cls: 'cc-goal-prompt-input',
			attr: {
				rows: '4',
				'aria-label': 'Workflow goal',
				placeholder: 'E.g. Research the latest rag techniques and draft a note in reports/ summarizing the top three.',
			},
		});
		const actions = new Setting(content);
		actions.addButton(btn => {
			btn.setButtonText('Generate').setCta();
			btn.onClick(() => this.submit());
		});
		actions.addExtraButton(btn => {
			btn.setIcon('cross').setTooltip('Cancel');
			btn.onClick(() => this.cancel());
		});
		window.setTimeout(() => this.inputEl.focus(), 0);
		this.scope.register([], 'Enter', evt => {
			if (evt.ctrlKey || evt.metaKey) { evt.preventDefault(); this.submit(); return false; }
			return true;
		});
		this.scope.register([], 'Escape', () => { this.cancel(); return false; });
	}

	onClose(): void {
		this.settle(null);
	}

	private submit(): void {
		const goal = this.inputEl.value.trim();
		if (!goal) return;
		this.settle(goal);
		this.close();
	}

	private cancel(): void {
		this.settle(null);
		this.close();
	}

	private settle(value: string | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(value);
	}
}
