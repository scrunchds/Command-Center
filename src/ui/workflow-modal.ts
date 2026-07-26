import { App, Modal, Setting } from 'obsidian';
import type { WorkflowDefinition, WorkflowInputSchema } from '../workflows/workflow-types';

export type WorkflowInputSubmit = (inputs: Record<string, unknown>, batchConcurrency?: number) => void;

export interface WorkflowInputModalOptions {
	/** Show a Base-queue concurrency slider (1–10). */
	batchConcurrency?: number;
}

/** Native Obsidian form for collecting and validating workflow arguments. */
export class WorkflowInputModal extends Modal {
	private readonly values: Record<string, unknown> = {};
	private errorEl: HTMLElement | null = null;
	private submitted = false;
	private batchConcurrency: number;

	constructor(
		app: App,
		private readonly workflow: WorkflowDefinition,
		private readonly onSubmit: WorkflowInputSubmit,
		private readonly onCancel?: () => void,
		private readonly options: WorkflowInputModalOptions = {},
	) {
		super(app);
		this.batchConcurrency = Math.max(1, Math.min(10, Math.floor(options.batchConcurrency ?? 1)));
		for (const [name, schema] of Object.entries(workflow.inputs)) {
			if (schema.default !== undefined) this.values[name] = schema.default;
			else if (schema.type === 'boolean') this.values[name] = false;
		}
	}

	onOpen(): void {
		this.contentEl.empty();
		this.contentEl.createEl('h2', { text: `Execute workflow: ${this.workflow.name}` });
		if (this.workflow.description) this.contentEl.createEl('p', { text: this.workflow.description });

		for (const [name, schema] of Object.entries(this.workflow.inputs)) {
			this.addInput(name, schema);
		}
		if (this.options.batchConcurrency !== undefined) {
			new Setting(this.contentEl)
				.setName('Batch Concurrency')
				.setDesc('Queue notes processed at the same time (1–10).')
				.addSlider(slider => slider
					.setLimits(1, 10, 1)
					.setDynamicTooltip()
					.setValue(this.batchConcurrency)
					.onChange(value => { this.batchConcurrency = value; }));
		}
		this.errorEl = this.contentEl.createDiv({ cls: 'cc-workflow-input-error' });

		new Setting(this.contentEl)
			.addButton(button => button
				.setButtonText('Cancel')
				.onClick(() => this.close()))
			.addButton(button => button
				.setButtonText('Execute')
				.setCta()
				.onClick(() => this.submit()));
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.submitted) this.onCancel?.();
	}

	private addInput(name: string, schema: WorkflowInputSchema): void {
		const setting = new Setting(this.contentEl)
			.setName(`${name}${schema.required ? ' *' : ''}`)
			.setDesc(schema.description ?? '');

		if (schema.type === 'boolean') {
			setting.addToggle(toggle => toggle
				.setValue(Boolean(this.values[name]))
				.onChange(value => { this.values[name] = value; }));
			return;
		}

		if (schema.options?.length) {
			setting.addDropdown(dropdown => {
				for (const [index, option] of schema.options!.entries()) {
					dropdown.addOption(String(index), this.displayValue(option));
				}
				const selected = schema.options!.findIndex(option => Object.is(option, this.values[name]));
				if (selected >= 0) dropdown.setValue(String(selected));
				else if (schema.options!.length > 0) this.values[name] = schema.options![0];
				dropdown.onChange(index => { this.values[name] = schema.options![Number(index)]; });
			});
			return;
		}

		setting.addText(input => {
			input.setPlaceholder(schema.type === 'number' ? 'Enter a number' : `Enter ${name}`);
			input.setValue(this.inputValue(this.values[name]));
			input.onChange(value => { this.values[name] = value; });
		});
	}

	private submit(): void {
		try {
			const validated: Record<string, unknown> = {};
			for (const [name, schema] of Object.entries(this.workflow.inputs)) {
				const value = this.coerce(name, schema, this.values[name]);
				if (schema.required && (value === undefined || value === '')) {
					throw new Error(`${name} is required.`);
				}
				if (value !== undefined && schema.options?.length && !schema.options.some(option => Object.is(option, value))) {
					throw new Error(`${name} must be one of the available options.`);
				}
				if (value !== undefined) validated[name] = value;
			}
			this.submitted = true;
			this.close();
			this.onSubmit(validated, this.options.batchConcurrency === undefined ? undefined : this.batchConcurrency);
		} catch (error) {
			if (this.errorEl) this.errorEl.textContent = (error as Error).message;
		}
	}

	private coerce(name: string, schema: WorkflowInputSchema, value: unknown): unknown {
		if (typeof value !== 'string') return value;
		const trimmed = value.trim();
		if (!trimmed && !schema.required) return undefined;
		if (schema.type === 'number') {
			const parsed = Number(trimmed);
			if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid number.`);
			return parsed;
		}
		if (schema.type === 'array' || schema.type === 'object') {
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (schema.type === 'array' ? !Array.isArray(parsed) : parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
					throw new Error('wrong shape');
				}
				return parsed;
			} catch {
				throw new Error(`${name} must be valid JSON ${schema.type}.`);
			}
		}
		return value;
	}

	private inputValue(value: unknown): string {
		return this.scalarValue(value, '');
	}

	private displayValue(value: unknown): string {
		return this.scalarValue(value, 'null');
	}

	private scalarValue(value: unknown, undefinedValue: string): string {
		if (value === undefined) return undefinedValue;
		if (value === null) return 'null';
		if (typeof value === 'object') return JSON.stringify(value);
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
		return '';
	}
}

/** Open the modal as a cancellable promise. */
export function collectWorkflowInputs(app: App, workflow: WorkflowDefinition): Promise<Record<string, unknown> | null> {
	return new Promise(resolve => {
		let settled = false;
		const finish = (value: Record<string, unknown> | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		new WorkflowInputModal(app, workflow, inputs => finish(inputs), () => finish(null)).open();
	});
}

/** Collect workflow inputs plus Base queue execution concurrency. */
export function collectWorkflowBatchInputs(
	app: App,
	workflow: WorkflowDefinition,
	defaultConcurrency = 1,
): Promise<{ inputs: Record<string, unknown>; concurrency: number } | null> {
	return new Promise(resolve => {
		let settled = false;
		const finish = (value: { inputs: Record<string, unknown>; concurrency: number } | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		new WorkflowInputModal(
			app,
			workflow,
			(inputs, concurrency) => finish({ inputs, concurrency: concurrency ?? 1 }),
			() => finish(null),
			{ batchConcurrency: defaultConcurrency },
		).open();
	});
}
