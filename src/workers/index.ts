import type { WorkerProfile, WorkerProfileName } from '../types';

import { profile as orchestratorProfile } from './orchestrator';
import { profile as retrieverProfile } from './retriever';
import { profile as summarizerProfile } from './summarizer';
import { profile as editorProfile } from './editor';

const workerRegistry: Record<WorkerProfileName, WorkerProfile> = {
	orchestrator: orchestratorProfile,
	retriever: retrieverProfile,
	summarizer: summarizerProfile,
	editor: editorProfile,
};

export function getWorkerProfile(name: string): WorkerProfile | undefined {
	return workerRegistry[name as WorkerProfileName];
}

export function getAllWorkerProfiles(): WorkerProfile[] {
	return Object.values(workerRegistry);
}
