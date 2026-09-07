import type { PlainMessage, SerializedMessage } from "./types.ts";

/**
 * Content text of an assistant message: tool calls, text, thinking.
 * This mirrors pi's agent-message shapes so the pure core never has to know
 * the concrete pi types.
 */
export interface AssistantContentPart {
	type: "text" | "thinking" | "toolCall" | "image";
	text?: string;
	name?: string;
	args?: string;
}

/** Extract plain text for serialization and retrieval. */
export function messageText(msg: PlainMessage): string {
	return msg.text;
}

const TURN_START_ROLES: ReadonlySet<string> = new Set([
	"user",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
]);

export function isTurnStartRole(role: string): boolean {
	return TURN_START_ROLES.has(role);
}

/**
 * Truncate a message's text, keeping the tail and adding a marker.
 * Mirrors pi's tool-result truncation so huge bash/read outputs do not blow up
 * the summarization request (B7). Truncation only affects the text projection
 * used for serialization/token estimation — the verbatim head is untouched.
 */
export function truncateMessageText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const head = text.slice(0, Math.max(0, Math.floor(maxChars * 0.6)));
	const tail = text.slice(text.length - Math.floor(maxChars * 0.4));
	return `${head}\n…[truncated ${text.length - maxChars} chars]…\n${tail}`;
}

/** Serialize messages into the same labelled format pi uses for summarization input. */
export function serializeMessages(
	messages: PlainMessage[],
	opts?: { truncateToolResults?: number },
): string {
	return messages.map((m) => serializeOne(m, opts?.truncateToolResults)).join("\n");
}

function serializeOne(msg: PlainMessage, truncateToolResults?: number): string {
	let text = msg.text;
	if (truncateToolResults && msg.isToolResult) {
		text = truncateMessageText(text, truncateToolResults);
	}
	switch (msg.role) {
		case "user":
			return `[User]: ${text}`;
		case "assistant":
			return `[Assistant]: ${text}`;
		case "toolResult":
			return `[Tool result]: ${text}`;
		case "bashExecution":
			return `[Bash]: ${text}`;
		case "custom":
			return `[Custom]: ${text}`;
		case "branchSummary":
			return `[Branch summary]: ${text}`;
		case "compactionSummary":
			return `[Summary]: ${text}`;
		default:
			return `[${msg.role}]: ${text}`;
	}
}

/** Convert to the SerializedMessage form used by unit tests / prompts. */
export function toSerialized(messages: PlainMessage[]): SerializedMessage[] {
	return messages.map((m) => ({ role: m.role, text: m.text }));
}
