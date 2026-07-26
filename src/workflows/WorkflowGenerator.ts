import { App, normalizePath, TFile, TFolder } from 'obsidian';
import { CONFIG_DIRECTORY } from '../engine/ConfigSerializer';
import { safeAssetName } from '../templates/TemplateGenerator';
import { WorkflowBuilder } from './WorkflowBuilder';
import type { WorkflowDefinition } from './workflow-types';

export const GENERATED_WORKFLOW_DIRECTORY = `${CONFIG_DIRECTORY}/workflows`;

export interface WorkflowProposal {
	id: string;
	name: string;
	description: string;
	fileName: string;
	definition: WorkflowDefinition;
}

/** Persists approved workflows only after enforcing explicit role/tier binding. */
export class WorkflowGenerator {
	private readonly builder = new WorkflowBuilder();
	constructor(private readonly app: App) {}

	async generate(proposals: ReadonlyArray<WorkflowProposal>): Promise<string[]> {
		await this.ensureDirectory(GENERATED_WORKFLOW_DIRECTORY);
		const paths: string[] = [];
		for (const proposal of proposals) {
			const plan = this.builder.build(proposal.definition);
			const fileName = safeAssetName(proposal.fileName, '.json');
			const path = normalizePath(`${GENERATED_WORKFLOW_DIRECTORY}/${fileName}`);
			await this.upsert(path, `${JSON.stringify(plan, null, 2)}\n`);
			paths.push(path);
		}
		return paths;
	}

	private async ensureDirectory(path: string): Promise<void> {
		let current = '';
		for (const segment of path.split('/')) {
			current = normalizePath(current ? `${current}/${segment}` : segment);
			const entry = this.app.vault.getAbstractFileByPath(current);
			if (entry instanceof TFolder) continue;
			if (entry) throw new Error(`A file blocks generated asset directory ${current}.`);
			await this.app.vault.createFolder(current);
		}
	}
	private async upsert(path: string, content: string): Promise<void> {
		const entry = this.app.vault.getAbstractFileByPath(path);
		if (entry instanceof TFile) await this.app.vault.modify(entry, content);
		else if (entry) throw new Error(`${path} is not a file.`);
		else await this.app.vault.create(path, content);
	}
}
