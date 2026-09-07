import type { MemoryCandidate } from "./types.ts";

/**
 * Memory sources from pi's own session/tree artifacts.
 *
 * This module is pure: it parses strings (JSONL session content, AGENTS.md
 * text). The pi extension adapter does the file I/O and feeds the parsed
 * content here, so the logic stays unit-testable without pi installed.
 */

/** Recency in (0,1] from an age in whole days. */
export function recencyFromAgeDays(ageDays: number): number {
	if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
	return Math.exp(-ageDays / 14); // half-life ~10 days
}

interface ParsedSessionEntry {
	type?: string;
	customType?: string;
	summary?: string;
	fromId?: string;
	message?: {
		role?: string;
		content?: string | { type?: string; text?: string }[] | null;
	};
}

/** Parse a session JSONL body into candidate memories (compaction/branch summaries + first user message). */
export function parseSessionCandidates(
	content: string,
	opts: { label: string; recency: number; includeFirstUser?: boolean },
): MemoryCandidate[] {
	const candidates: MemoryCandidate[] = [];
	let firstUserText: string | undefined;
	const lines = content.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: ParsedSessionEntry;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (entry?.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim()) {
			candidates.push({
				label: `${opts.label} (compaction)`,
				text: entry.summary.trim(),
				recency: opts.recency,
			});
		} else if (entry?.type === "branch_summary" && typeof entry.summary === "string" && entry.summary.trim()) {
			candidates.push({
				label: `${opts.label} (branch)`,
				text: entry.summary.trim(),
				recency: opts.recency,
			});
		} else if (entry?.type === "message" && entry.message?.role === "user" && firstUserText === undefined) {
			firstUserText = extractUserText(entry.message.content);
		}
	}
	if (opts.includeFirstUser !== false && firstUserText && firstUserText.trim()) {
		candidates.push({
			label: `${opts.label} (first user)`,
			text: firstUserText.trim(),
			recency: opts.recency,
		});
	}
	return candidates;
}

function extractUserText(content: string | { type?: string; text?: string }[] | null | undefined): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join(" ")
		.trim();
}

/** AGENTS.md / CLAUDE.md content → one candidate (documents are atomic for BM25). */
export function parseContextFileCandidates(
	content: string,
	opts: { label: string; recency: number; maxChars?: number },
): MemoryCandidate[] {
	const text = content.trim();
	if (!text) return [];
	const maxChars = opts.maxChars ?? 20000;
	return [{ label: opts.label, text: text.slice(0, maxChars), recency: opts.recency }];
}

/** Minimal view of a pi session entry for tree-sourced candidates. */
export interface TreeEntryLike {
	type?: string;
	summary?: string;
	customType?: string;
}

/**
 * Current-session tree memories: earlier `compaction` entries and
 * `branch_summary` entries on the active branch (DESIGN.md §3.3 source #1).
 * Feed it `sessionManager.getBranch()` output. Current-session entries are the
 * most recent context, so recency is 1.
 */
export function parseSessionTreeCandidates(entries: TreeEntryLike[], labelPrefix = "current session"): MemoryCandidate[] {
	const candidates: MemoryCandidate[] = [];
	for (const entry of entries) {
		if (entry?.type === "compaction" && typeof entry.summary === "string" && entry.summary.trim()) {
			candidates.push({
				label: `${labelPrefix} (compaction)`,
				text: entry.summary.trim(),
				recency: 1,
			});
		} else if (entry?.type === "branch_summary" && typeof entry.summary === "string" && entry.summary.trim()) {
			candidates.push({
				label: `${labelPrefix} (branch)`,
				text: entry.summary.trim(),
				recency: 1,
			});
		}
	}
	return candidates;
}
