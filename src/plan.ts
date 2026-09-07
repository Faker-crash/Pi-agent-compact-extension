import { isTurnStartRole } from "./serialize.ts";
import type { MemoryCandidate, MemoryCompactSettings, PlainMessage } from "./types.ts";

/** A safe boundary index: the index of the first message that starts a new turn. */
export interface HeadPlan {
	/** Index of the first message NOT kept in the head (head = messages[0..headEnd)). */
	headEnd: number;
	/** Whether head includes a real user request (at least one user-like message). */
	hasUserContent: boolean;
}

/**
 * Choose the head boundary for the memory-anchored compact:
 * keep at least `settings.headMessages` messages, then extend forward to the
 * start of the next turn so the head never ends mid tool round.
 *
 * Head = messages[0..headEnd). Stable across requests because pi only appends
 * messages (native compaction is disabled while this extension is active).
 */
export function planHead(messages: PlainMessage[], settings: MemoryCompactSettings): HeadPlan {
	const n = Math.max(1, Math.floor(settings.headMessages));
	if (messages.length === 0) {
		return { headEnd: 0, hasUserContent: false };
	}
	// Start from the requested count, then walk forward to a turn-start boundary.
	let headEnd = Math.min(n, messages.length);
	while (headEnd < messages.length && !isTurnStartRole(messages[headEnd].role)) {
		headEnd++;
	}
	let hasUserContent = false;
	for (let i = 0; i < headEnd; i++) {
		if (isTurnStartRole(messages[i].role)) {
			hasUserContent = true;
			break;
		}
	}
	if (!hasUserContent) {
		// Degenerate session (e.g., restored mid-turn): force a clean boundary at
		// the first user-like message.
		const first = messages.findIndex((m) => isTurnStartRole(m.role));
		if (first > 0) {
			headEnd = first;
		}
	}
	return { headEnd, hasUserContent };
}

/** Rough char/4 token estimate (mirrors pi's conservative estimator). */
export function estimateTokens(messages: PlainMessage[]): number {
	let chars = 0;
	for (const m of messages) {
		chars += m.text.length;
	}
	return Math.ceil(chars / 4);
}

export interface ContextEstimate {
	/** Best-known token count: last assistant usage + estimated trailing messages. */
	tokens: number;
	/** Index of the assistant message whose usage was used, or -1. */
	lastUsageIndex: number;
	/** Tokens taken verbatim from provider usage. */
	usageTokens: number;
	/** Estimated tokens of messages after the last usage point. */
	trailingTokens: number;
}

/**
 * Usage-aware context estimate (B8): like pi's estimateContextTokens, if the
 * most recent assistant message carries confirmed provider usage, reuse it as
 * the exact context size up to that message and only estimate the trailing
 * messages (tool results etc.). Without any usage it degrades to chars/4.
 */
export function estimateContextTokens(messages: PlainMessage[]): ContextEstimate {
	let lastUsageIndex = -1;
	let usageTokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant" && typeof m.usageTokens === "number" && m.usageTokens > 0) {
			lastUsageIndex = i;
			usageTokens = m.usageTokens;
			break;
		}
	}
	if (lastUsageIndex === -1) {
		const trailing = estimateTokens(messages);
		return { tokens: trailing, lastUsageIndex: -1, usageTokens: 0, trailingTokens: trailing };
	}
	const trailingTokens = estimateTokens(messages.slice(lastUsageIndex + 1));
	return { tokens: usageTokens + trailingTokens, lastUsageIndex, usageTokens, trailingTokens };
}

export interface CompactDecision {
	/** Whether a (new) fold should be produced now. */
	shouldFold: boolean;
	/** Token estimate of the full incoming context. */
	tokens: number;
}

/**
 * Trigger rule: fold when projected tokens exceed
 * `settings.triggerRatio` of the model context window.
 */
export function shouldCompactNow(
	messages: PlainMessage[],
	contextWindow: number,
	settings: MemoryCompactSettings,
): CompactDecision {
	const tokens = estimateTokens(messages);
	const shouldFold = contextWindow > 0 && tokens > contextWindow * settings.triggerRatio;
	return { shouldFold, tokens };
}

export type FoldPolicy = "keep-latest-turn" | "fold-all";

/**
 * Compute a fold boundary.
 *
 * Contract: body = messages[bodyStart..foldEnd) is summarized;
 * tail = messages[foldEnd..] stays verbatim in the model context.
 *
 * - keep-latest-turn (default, auto mode): the newest user-like turn start is
 *   the boundary, so the current (possibly in-flight) turn is never folded and
 *   tool pairing inside the kept tail is never broken. Folding only ever
 *   absorbs already-completed turns.
 * - fold-all (manual /memory-compact or overflow emergency): fold everything
 *   except a trailing unanswered user prompt, which must stay visible so the
 *   model can answer it. Emptying the tail is safe: no kept tool message
 *   depends on a folded assistant message.
 */
export function foldBoundary(
	messages: PlainMessage[],
	bodyStart: number,
	policy: FoldPolicy,
): number {
	const clamped = Math.min(Math.max(0, bodyStart), messages.length);
	if (clamped >= messages.length) return messages.length;
	if (policy === "fold-all") {
		const last = messages.length - 1;
		if (last >= clamped && messages[last].role === "user") {
			// Keep the trailing unanswered user prompt visible.
			return last;
		}
		return messages.length;
	}
	// keep-latest-turn: newest user-like message at/after bodyStart.
	for (let i = messages.length - 1; i >= clamped; i--) {
		if (isTurnStartRole(messages[i].role)) {
			return i;
		}
	}
	return clamped;
}

export interface FoldPlan {
	/** Messages to summarize (bodyStart .. foldEnd). */
	body: PlainMessage[];
	/** Messages kept verbatim after the summary (tail). */
	tail: PlainMessage[];
	/** Index of the first message NOT folded. */
	foldEnd: number;
}

export function planFold(
	messages: PlainMessage[],
	bodyStart: number,
	policy: FoldPolicy,
): FoldPlan {
	const foldEnd = foldBoundary(messages, bodyStart, policy);
	return {
		body: messages.slice(bodyStart, foldEnd),
		tail: messages.slice(foldEnd),
		foldEnd,
	};
}

export interface FoldRequest {
	messages: PlainMessage[];
	headCount: number;
	contextWindow: number;
	settings: MemoryCompactSettings;
	/** Fold point of the previous checkpoint (index where the kept tail started). */
	lastFoldThrough?: number;
	/** Previous checkpoint summary for incremental update, if any. */
	previousSummary?: string;
	/** Manual compact: ignore the pressure threshold. */
	force?: boolean;
	/** Fold the whole remainder (manual/emergency). */
	policy?: FoldPolicy;
	/** Minimum estimated tokens of new content before auto-folding again. */
	minNewTokens?: number;
	/** Memory candidates from the adapter. */
	memoryCandidates?: MemoryCandidate[];
}

export interface FoldResult {
	/** Whether to fold now. */
	fold: boolean;
	/** Index where the new summary input starts. */
	bodyStart: number;
	/** Fold plan (body/tail). */
	plan: FoldPlan;
	/** Token estimate of the incoming context. */
	tokens: number;
}

/**
 * Decide whether a fold is warranted and what it covers.
 *
 * Body for the first fold: completed turns after the head.
 * Body for later folds: messages since the previous fold point up to the fold
 * boundary. Auto folds only when enough new content has accrued and pressure
 * is high; manual folds ignore pressure.
 */
export function prepareFold(request: FoldRequest): FoldResult {
	const { messages, headCount, contextWindow, settings, force } = request;
	const { headEnd } = planHead(messages, { ...settings, headMessages: headCount });
	const bodyStart =
		request.lastFoldThrough !== undefined && request.lastFoldThrough >= headEnd
			? request.lastFoldThrough
			: headEnd;
	const plan = planFold(messages, bodyStart, request.policy ?? "keep-latest-turn");
	const { shouldFold, tokens } = shouldCompactNow(messages, contextWindow, settings);
	const minNewTokens = request.minNewTokens ?? 2048;
	const newTokens = estimateTokens(plan.body);
	const enoughNew = newTokens >= minNewTokens;
	const fold = plan.body.length > 0 && (force ? true : shouldFold && enoughNew);
	return { fold, bodyStart, plan, tokens };
}
