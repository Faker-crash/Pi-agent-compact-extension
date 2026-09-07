import type { MemoryCandidate, PlainMessage } from "./types.ts";

/**
 * Layout produced for the model: the head is kept verbatim, memories and the
 * summary are injected between the head and the (kept verbatim) tail.
 *
 * This is an ordered, linear view; the adapter decides how to materialize it
 * as real provider messages.
 */
export interface CompactLayout {
	/** Messages kept verbatim from the start of the conversation. */
	head: PlainMessage[];
	/** Retrieved memory items (rendered by the adapter). */
	memories: MemoryCandidate[];
	/** Summary text covering everything folded since the last checkpoint. */
	summary: string;
	/** Messages kept verbatim after the summary (recent / active turns). */
	tail: PlainMessage[];
}

export function buildLayout(
	head: PlainMessage[],
	memories: MemoryCandidate[],
	summary: string,
	tail: PlainMessage[],
): CompactLayout {
	return { head, memories, summary, tail };
}

/** Rough budget: head + memories + summary should stay small; only tail grows. */
export function estimateLayoutTokens(layout: CompactLayout): number {
	let chars = 0;
	for (const m of layout.head) {
		chars += m.text.length;
	}
	for (const mem of layout.memories) {
		chars += mem.text.length;
	}
	chars += layout.summary.length;
	for (const m of layout.tail) {
		chars += m.text.length;
	}
	return Math.ceil(chars / 4);
}

export const MEMORY_OPEN = "<memory>";
export const MEMORY_CLOSE = "</memory>";
export const SUMMARY_OPEN = "<summary>";
export const SUMMARY_CLOSE = "</summary>";

/** Format memories for injection (numbered list, source labels). */
export function formatMemories(memories: MemoryCandidate[]): string {
	if (memories.length === 0) {
		return "";
	}
	const lines = memories.map((m, i) => `[${i + 1}] (${m.label}) ${m.text}`);
	return `${MEMORY_OPEN}\n${lines.join("\n")}\n${MEMORY_CLOSE}`;
}

/** Format the summary block (mirrors pi's compaction summary framing). */
export function formatSummary(summary: string): string {
	return `The conversation history between the opening messages above and the recent messages below was compacted into the following summary:\n\n${SUMMARY_OPEN}\n${summary}\n${SUMMARY_CLOSE}`;
}
