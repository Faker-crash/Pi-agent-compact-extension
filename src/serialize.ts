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

/** Serialize messages into the same labelled format pi uses for summarization input. */
export function serializeMessages(messages: PlainMessage[]): string {
	return messages.map(serializeOne).join("\n");
}

function serializeOne(msg: PlainMessage): string {
	const text = msg.text;
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
