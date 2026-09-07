import { formatMemories, formatSummary } from "./layout.ts";
import type { MemoryCandidate, PlainMessage } from "./types.ts";

/** A checkpoint: what the summary currently represents and what is kept verbatim. */
export interface Checkpoint {
	/** Head boundary (messages[0..headEnd) are always shown verbatim). */
	headEnd: number;
	/** Fingerprint of messages[0..headEnd) to detect session/branch changes. */
	headFingerprint: string;
	/** Index where the kept tail starts; everything below is head+summary. */
	foldThrough: number;
	/** Retrieved memory items shown between head and summary. */
	memories: MemoryCandidate[];
	/** Structured summary of messages[headEnd..foldThrough). */
	summary: string;
	/** Token estimate of the context at the fold moment. */
	tokensBefore: number;
}

/** Cheap stable fingerprint over a message prefix (roles + text). */
export function fingerprintMessages(prefix: PlainMessage[]): string {
	let acc = 0;
	for (const m of prefix) {
		acc = ((acc * 31 + hashString(m.role)) | 0) ^ hashString(m.text);
	}
	return (acc >>> 0).toString(36);
}

function hashString(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
	}
	return h;
}

/** Everything the model should see for the current request. */
export interface CompactedView {
	head: PlainMessage[];
	memories: MemoryCandidate[];
	summary: string;
	/** Messages kept verbatim after the summary (recent tail). */
	tail: PlainMessage[];
}

/**
 * Produce the compacted view from messages + checkpoint.
 *
 * head = messages[0..headEnd)
 * tail = messages[foldThrough..]
 * In between: memories + summary.
 */
export function buildView(messages: PlainMessage[], checkpoint: Checkpoint): CompactedView {
	const head = messages.slice(0, checkpoint.headEnd);
	const tail = messages.slice(checkpoint.foldThrough);
	return { head, memories: checkpoint.memories, summary: checkpoint.summary, tail };
}

/** Single injected user-role text block carrying memory + summary. */
export function injectedBlock(memories: MemoryCandidate[], summary: string): string {
	const memoryText = formatMemories(memories);
	const summaryText = formatSummary(summary);
	return memoryText ? `${memoryText}\n\n${summaryText}` : summaryText;
}
