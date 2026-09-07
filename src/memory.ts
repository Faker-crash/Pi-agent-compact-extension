import type { MemoryCandidate } from "./types.ts";

/**
 * Memory retrieval — a light BM25 over token streams with CJK bigram support.
 * No embeddings, no network: works offline over pi's own session artifacts.
 */

/** Split a mixed text into CJK bigrams + latin/ascii word tokens. */
export function tokenize(text: string): string[] {
	const normalized = text.normalize("NFKC").toLowerCase();
	const tokens: string[] = [];
	// ASCII words + numbers
	for (const m of normalized.match(/[a-z0-9_][a-z0-9_\-]*/g) ?? []) {
		if (m.length >= 2) tokens.push(m);
		else if (m.length === 1) tokens.push(m);
	}
	// CJK: bigrams over consecutive ideographs
	const cjkRuns = normalized.match(/[\u3400-\u9fff]+/g) ?? [];
	for (const run of cjkRuns) {
		if (run.length === 1) {
			tokens.push(run);
			continue;
		}
		for (let i = 0; i < run.length - 1; i++) {
			tokens.push(run.slice(i, i + 2));
		}
	}
	return tokens;
}

interface ScoredDoc {
	index: number;
	score: number;
}

/**
 * BM25-style ranking (k1, b configurable) over a list of candidate docs.
 * Corpus statistics are computed over the supplied candidates, so this is
 * deterministic and dependency-free.
 */
export function rankMemories(
	query: string,
	candidates: MemoryCandidate[],
	topK: number,
	opts?: { k1?: number; b?: number },
): MemoryCandidate[] {
	if (candidates.length === 0) {
		return [];
	}
	const k1 = opts?.k1 ?? 1.5;
	const b = opts?.b ?? 0.75;
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) {
		// Nothing to match on: fall back to recency order.
		return [...candidates]
			.sort((a, z) => z.recency - a.recency)
			.slice(0, topK);
	}
	const tokenized = candidates.map((c) => tokenize(c.text));
	const avgdl =
		tokenized.reduce((sum, toks) => sum + Math.max(1, toks.length), 0) /
		Math.max(1, candidates.length);

	// Document frequency per query token.
	const df = new Map<string, number>();
	for (const toks of tokenized) {
		const seen = new Set(toks);
		for (const t of seen) {
			df.set(t, (df.get(t) ?? 0) + 1);
		}
	}
	const N = candidates.length;

	const scored: ScoredDoc[] = tokenized.map((toks, index) => {
		const dl = Math.max(1, toks.length);
		const tf = new Map<string, number>();
		for (const t of toks) {
			tf.set(t, (tf.get(t) ?? 0) + 1);
		}
		let score = 0;
		for (const qt of queryTokens) {
			const f = tf.get(qt) ?? 0;
			if (f === 0) continue;
			const n = df.get(qt) ?? 0;
			const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
			score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgdl))));
		}
		return { index, score: score * candidates[index].recency };
	});

	return scored
		.filter((s) => s.score > 0)
		.sort((a, z) => z.score - a.score)
		.slice(0, Math.max(0, topK))
		.map((s) => candidates[s.index]);
}

/** Keep the top-k but bound each item's length to keep injection compact. */
export function truncateMemories(
	memories: MemoryCandidate[],
	maxItemChars: number,
): MemoryCandidate[] {
	return memories.map((m) => {
		if (m.text.length <= maxItemChars) return m;
		return { ...m, text: `${m.text.slice(0, maxItemChars)}…` };
	});
}
