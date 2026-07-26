import { App, normalizePath, TFile, TFolder } from 'obsidian';
import { CONFIG_DIRECTORY } from '../engine/ConfigSerializer';

export const TEMPLATE_DIRECTORY = `${CONFIG_DIRECTORY}/templates`;

export interface TemplateProposal {
	id: string;
	name: string;
	description: string;
	fileName: string;
	content: string;
}

/** Writes only explicitly approved, interview-synthesized templates. */
export class TemplateGenerator {
	constructor(private readonly app: App) {}

	async generate(proposals: ReadonlyArray<TemplateProposal>): Promise<string[]> {
		await this.ensureDirectory(TEMPLATE_DIRECTORY);
		const paths: string[] = [];
		for (const proposal of proposals) {
			const fileName = safeAssetName(proposal.fileName, '.md');
			const path = normalizePath(`${TEMPLATE_DIRECTORY}/${fileName}`);
			await this.upsert(path, `${proposal.content.trim()}\n`);
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

export function safeAssetName(value: string, extension: '.md' | '.json'): string {
	const leaf = value.trim().replace(/\\/g, '/').split('/').pop()?.replace(/[^\p{L}\p{N}._ -]+/gu, '-').trim();
	if (!leaf || leaf === '.' || leaf === '..') throw new Error('Generated asset has an invalid file name.');
	return leaf.toLocaleLowerCase().endsWith(extension) ? leaf : `${leaf}${extension}`;
}
