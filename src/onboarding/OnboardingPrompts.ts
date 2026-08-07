import { INTERVIEW_COMPLETE_SIGNAL } from './InterviewEngine';

/** Compatibility export delegated to the agnostic interview architecture. */
export const ONBOARDING_WELCOME = 'Describe how your vault is organized, or ask me to inspect its existing folders before proposing managed indexes.';

/** Compatibility prompt with no operational defaults. */
export const ONBOARDING_SYSTEM_PROMPT = `Conduct an agnostic, one-question-at-a-time workflow interview. Never assume paths, metrics, thresholds, caps, task syntax, handling policy, style, or persona. Discover topology, life tracks, capacity rules, triage and rollover rules, focus rules, and writing/persona preferences. If uncertain, offer context-specific options without selecting one. Never request or accept credentials. After explicit confirmation return only a JSON envelope with signal ${INTERVIEW_COMPLETE_SIGNAL} and a complete configuration derived solely from user answers.`;

export function buildOnboardingUserPrompt(history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>, message: string): string {
	const transcript = history.map(turn => `${turn.role === 'user' ? 'User' : 'Interviewer'}: ${turn.content}`).join('\n\n');
	return `${transcript ? `Interview so far:\n${transcript}\n\n` : ''}User: ${message}\n\nContinue adaptively. Ask one focused unanswered question and do not invent defaults.`;
}
