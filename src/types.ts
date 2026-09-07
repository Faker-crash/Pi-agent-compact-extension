/**
 * Shared pure types for the memory-anchored compact mechanism.
 *
 * These types are intentionally model-agnostic: the extension adapter maps
 * pi's AgentMessage to PlainMessage before calling the pure core.
 */

/** A role that matters for compaction boundary logic. */
export type PlainRole =
	| "user"
	| "assistant"
	| "toolResult"
	| "bashExecution"
	| "custom"
	| "branchSummary"
	| "compactionSummary";

/** Minimal structural view of a message the pure core can reason about. */
export interface PlainMessage {
	role: PlainRole;
	/** Rendered text used for serialization / retrieval / anchoring. */
	text: string;
	/** True when the message must never be cut away from its tool call. */
	isToolResult: boolean;
	/** True when this message can start a turn (user-like). */
	isTurnStart: boolean;
	/** Stable identity across rewrites, when available (entry id). */
	anchorId?: string;
	/** Confirmed context tokens from provider usage, when available (assistant msgs). */
	usageTokens?: number;
}

/** Serialized conversation block fed to the summarizer. */
export interface SerializedMessage {
	role: string;
	text: string;
}

/** One memory candidate produced by the memory source adapter. */
export interface MemoryCandidate {
	/** Source label shown to the model, e.g. "2026-09-05 session". */
	label: string;
	/** Candidate text (may be truncated at the adapter). */
	text: string;
	/** Recency weight in (0,1]; higher = more recent. */
	recency: number;
}

/** Configuration for the memory-anchored compact mechanism. */
export interface MemoryCompactSettings {
	/** Whether the whole mechanism is enabled. */
	enabled: boolean;
	/** N: number of leading messages kept verbatim (turn-complete). */
	headMessages: number;
	/** Number of memory items injected into the compacted context. */
	memoryItems: number;
	/** Trigger when projected context tokens exceed this fraction of the window. */
	triggerRatio: number;
	/** Path to the extension root, for reading memory sources (AGENTS.md etc). */
	cwd: string;
	/** pi agent dir, for global AGENTS.md. */
	agentDir: string;
	/** Session dir of the current pi session (siblings = project memory). */
	sessionDir: string;
	/** Current session file path (for excluding the live session). */
	sessionFile?: string;
	/** Include AGENTS.md/CLAUDE.md files as memory candidates. */
	useAgentsMd: boolean;
	/** Include sibling session files in the same session dir. */
	useSiblingSessions: boolean;
	/** BM25 k1 parameter. */
	bm25K1: number;
	/** BM25 b parameter. */
	bm25B: number;
	/** Max chars per memory candidate injected. */
	maxMemoryItemChars: number;
	/** Truncate tool results to this many chars when serialized for summarization. */
	maxToolResultChars: number;
}

/** Defaults mirroring pi's reserve/keep philosophy scaled to head-keeping. */
export function defaultSettings(partial?: Partial<MemoryCompactSettings>): MemoryCompactSettings {
	return {
		enabled: true,
		headMessages: 5,
		memoryItems: 5,
		triggerRatio: 0.75,
		cwd: process.cwd(),
		agentDir: "",
		sessionDir: "",
		useAgentsMd: true,
		useSiblingSessions: true,
		bm25K1: 1.5,
		bm25B: 0.75,
		maxMemoryItemChars: 1200,
		maxToolResultChars: 2000,
		...partial,
	};
}
