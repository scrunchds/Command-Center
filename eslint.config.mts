import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'release',
		'test',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.mts',
						'manifest.json',
						'scripts/*.mjs',
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// The strict TypeScript build is the correctness gate. These advisory
		// Obsidian style/migration rules are intentionally disabled until their
		// corresponding UI and transport migrations are undertaken as features.
		rules: {
			'@typescript-eslint/no-misused-promises': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unnecessary-type-assertion': 'off',
			'@typescript-eslint/no-unused-vars': 'off',
			'eslint-comments/no-restricted-disable': 'off',
			'eslint-comments/require-description': 'off',
			'no-restricted-globals': 'off',
			'obsidianmd/commands/no-command-in-command-id': 'off',
			'obsidianmd/commands/no-command-in-command-name': 'off',
			'obsidianmd/commands/no-plugin-id-in-command-id': 'off',
			'obsidianmd/commands/no-plugin-name-in-command-name': 'off',
			'obsidianmd/hardcoded-config-path': 'off',
			'obsidianmd/no-global-this': 'off',
			'obsidianmd/no-static-styles-assignment': 'off',
			'obsidianmd/prefer-create-el': 'off',
			'obsidianmd/prefer-file-manager-trash-file': 'off',
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/rule-custom-message': 'off',
			'obsidianmd/settings-tab/no-manual-html-headings': 'off',
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
			'obsidianmd/ui/sentence-case': 'off',
		},
	},
);
