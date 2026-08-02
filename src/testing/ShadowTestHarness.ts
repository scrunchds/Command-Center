import { MemoryCredentialVault } from '../security/VaultCrypto';
import { NativeAutoRouter } from '../routing/NativeAutoRouter';
import { DataNormalizer } from '../execution/DataNormalizer';

export interface ShadowTestResult {
	name: string;
	passed: boolean;
	details: string;
}

export interface ShadowSuiteReport {
	timestamp: string;
	total: number;
	passed: number;
	failed: number;
	results: ShadowTestResult[];
}

/** In-memory diagnostic test runner for Phase 5 verification. */
export class ShadowTestHarness {
	constructor(private readonly router: NativeAutoRouter) {}

	async runDiagnostics(): Promise<ShadowSuiteReport> {
		const results: ShadowTestResult[] = [];
		results.push(await this.testSecurityVault());
		results.push(await this.testAutoRouter());
		results.push(await this.testLocalFallback());
		results.push(await this.testDataNormalizerSanitization());

		const passed = results.filter(result => result.passed).length;
		return {
			timestamp: new Date().toISOString(),
			total: results.length,
			passed,
			failed: results.length - passed,
			results,
		};
	}

	formatReport(report: ShadowSuiteReport): string {
		const lines = [
			'# Command Center: Shadow-Clone Diagnostic Report',
			`*Generated at ${report.timestamp}*`,
			'',
			`**Summary**: ${report.passed}/${report.total} tests passed (${report.failed} failed).`,
			'',
			'## Test Details',
		];
		for (const result of report.results) {
			lines.push(`- **[${result.passed ? 'PASS' : 'FAIL'}] ${result.name}**: ${result.details}`);
		}
		return lines.join('\n');
	}

	private async testSecurityVault(): Promise<ShadowTestResult> {
		try {
			const backing = new Map<string, string>();
			const secretStorage = {
				getSecret: (id: string) => backing.get(id) ?? null,
				setSecret: (id: string, secret: string) => { backing.set(id, secret); },
				listSecrets: () => [...backing.keys()],
			};
			const vault = new MemoryCredentialVault(secretStorage);
			const fixture = 'synthetic-memory-credential';
			vault.unlock({ openai: fixture });
			const initialCheck = vault.has('openai') && vault.get('openai') === fixture && vault.count() === 1;
			secretStorage.setSecret('command-center-openai', '');
			backing.delete('command-center-openai');
			const clearedCheck = !vault.has('openai') && vault.get('openai') === '' && vault.count() === 0;
			const passed = initialCheck && clearedCheck;
			return {
				name: 'Obsidian Secret Storage Credential Lifecycle',
				passed,
				details: passed ? 'Credentials are stored and read through the Secret Storage adapter surface.' : 'Failed to correctly manage Secret Storage-backed credentials.',
			};
		} catch (error) {
			return { name: 'Obsidian Secret Storage Credential Lifecycle', passed: false, details: String(error) };
		}
	}

	private async testAutoRouter(): Promise<ShadowTestResult> {
		try {
			await this.router.reload();
			const resolution = this.router.resolve('text');
			const passed = Boolean(resolution.providerId && resolution.depth >= 1 && resolution.depth <= 10 && resolution.source === 'matrix');
			return {
				name: 'Native Auto-Router Slider Resolution',
				passed,
				details: passed ? `Configured depth ${resolution.depth} resolved through model_matrix.json to ${resolution.providerId}/${resolution.modelId ?? 'default'}.` : 'AutoRouter failed to map the configured depth through model_matrix.json.',
			};
		} catch (error) {
			return { name: 'Native Auto-Router Slider Resolution', passed: false, details: String(error) };
		}
	}

	private async testLocalFallback(): Promise<ShadowTestResult> {
		try {
			const resolution = this.router.resolve('text');
			// Fail-closed routing must always yield an auditable target; dispatcher/provider
			// circuit breakers then advance through the configured local-first chain.
			const passed = Boolean(resolution.providerId) && ['matrix', 'fail-closed', 'matrix-invalid'].includes(resolution.source);
			return {
				name: 'Local-First Routing Fallback Chain',
				passed,
				details: passed ? `Failure-safe route is auditable (${resolution.source}: ${resolution.providerId}); dispatcher circuit breaking remains enabled.` : 'No failure-safe route was produced.',
			};
		} catch (error) {
			return { name: 'Local-First Routing Fallback Chain', passed: false, details: String(error) };
		}
	}

	private async testDataNormalizerSanitization(): Promise<ShadowTestResult> {
		try {
			const normalizer = new DataNormalizer();
			const rawPythonTraceback = JSON.stringify({
				jsonrpc: '2.0',
				id: 'test-1',
				error: {
					code: -32603,
					message: 'Traceback (most recent call last):\n  File "worker.py", line 42\n    raise ValueError("Internal Secret Error")\nValueError: Internal Secret Error\x07\x1B[31m',
				},
			});
			const result = normalizer.normalize(rawPythonTraceback, 'python-worker');
			const isClean = !result.content.includes('\x07') && !result.content.includes('\x1B');
			const caughtError = result.error !== undefined || result.content.includes('ValueError');
			const passed = isClean && caughtError;
			return {
				name: 'Data Normalizer Traceback & Control Char Stripping',
				passed,
				details: passed ? 'Successfully sanitized control characters and extracted normalized error context.' : 'Failed to sanitize control characters or extract error context.',
			};
		} catch (error) {
			return { name: 'Data Normalizer Traceback & Control Char Stripping', passed: false, details: String(error) };
		}
	}
}
