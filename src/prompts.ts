import { serializeMessages } from "./serialize.ts";
import type { MemoryCandidate, PlainMessage } from "./types.ts";

export const SUMMARIZATION_SYSTEM_PROMPT =
	"You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

export const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Build the one-shot summarization request prompt.
 *
 * The conversation under summary sits between <conversation> tags so the model
 * does not try to continue it. A previous checkpoint summary can be supplied
 * for incremental update (mirrors pi's iterative compaction).
 */
export function buildSummarizationPromptText(
	body: PlainMessage[],
	opts?: {
		previousSummary?: string;
		headText?: string;
		memories?: MemoryCandidate[];
		/** Truncate tool results to this many chars (pi-compatible, B7). */
		truncateToolResults?: number;
	},
): string {
	const conversationText = serializeMessages(body, { truncateToolResults: opts?.truncateToolResults });
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	const contextParts: string[] = [];
	if (opts?.headText) {
		contextParts.push(`The opening messages of this session are retained verbatim for the model. Do NOT restate them; only summarize the conversation above.`);
	}
	if (opts?.memories && opts.memories.length > 0) {
		const lines = opts.memories.map((m) => `- (${m.label}) ${m.text}`).join("\n");
		contextParts.push(`Relevant memories already available to the model:\n${lines}`);
	}
	if (contextParts.length > 0) {
		promptText += `${contextParts.join("\n\n")}\n\n`;
	}
	if (opts?.previousSummary) {
		promptText += `<previous-summary>\n${opts.previousSummary}\n</previous-summary>\n\n`;
		promptText += UPDATE_SUMMARIZATION_INSTRUCTIONS;
	} else {
		promptText += SUMMARIZATION_PROMPT;
	}
	return promptText;
}
