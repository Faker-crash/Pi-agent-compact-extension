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

// ============================================================================
// Checkpoint persistence helpers (Route A: custom session entries)
// ============================================================================

/** Custom-entry type used to persist a checkpoint inside the session. */
export const CHECKPOINT_ENTRY_TYPE = "pi-memory-compact.checkpoint";

/** Custom-entry type used to mark "reset": any earlier checkpoint is stale. */
export const RESET_ENTRY_TYPE = "pi-memory-compact.reset";

/** Minimal shape of a persisted custom entry as read back from the session. */
export interface CustomEntryLike<T = unknown> {
	type: "custom";
	customType: string;
	data?: T;
	timestamp?: string | number;
}

/** Serializable snapshot of a Checkpoint (memories included). */
export function serializeCheckpoint(cp: Checkpoint): unknown {
	return cp;
}

/**
 * Restore the latest valid checkpoint from a list of custom entries.
 * A reset marker invalidates everything before it; only the newest checkpoint
 * after the newest reset is used. Malformed payloads are skipped.
 */
export function restoreCheckpoint(entries: CustomEntryLike[]): Checkpoint | undefined {
	let latestResetAt = -1;
	const candidates: { index: number; data: unknown }[] = [];
	entries.forEach((entry, index) => {
		if (entry?.type !== "custom") return;
		if (entry.customType === RESET_ENTRY_TYPE) {
			latestResetAt = index;
			candidates.length = 0; // any checkpoint before reset is stale
			return;
		}
		if (entry.customType === CHECKPOINT_ENTRY_TYPE) {
			candidates.push({ index, data: entry.data });
		}
	});
	if (candidates.length === 0) return undefined;
	const last = candidates[candidates.length - 1];
	if (last.index <= latestResetAt) return undefined;
	return parseCheckpoint(last.data);
}

function parseCheckpoint(data: unknown): Checkpoint | undefined {
	if (!data || typeof data !== "object") return undefined;
	const d = data as Partial<Checkpoint>;
	if (
		typeof d.headEnd !== "number" ||
		typeof d.headFingerprint !== "string" ||
		typeof d.foldThrough !== "number" ||
		typeof d.summary !== "string" ||
		typeof d.tokensBefore !== "number" ||
		!Array.isArray(d.memories)
	) {
		return undefined;
	}
	const memories = d.memories.filter(
		(m): m is MemoryCandidate =>
			!!m &&
			typeof m.text === "string" &&
			typeof m.label === "string" &&
			typeof m.recency === "number",
	);
	if (memories.length !== d.memories.length) return undefined;
	return {
		headEnd: d.headEnd,
		headFingerprint: d.headFingerprint,
		foldThrough: d.foldThrough,
		memories,
		summary: d.summary,
		tokensBefore: d.tokensBefore,
	};
}
