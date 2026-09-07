import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, rankMemories, truncateMemories } from "../src/memory.ts";
import type { MemoryCandidate } from "../src/types.ts";

const cand = (text: string, label: string, recency = 1): MemoryCandidate => ({ text, label, recency });

test("tokenize handles CJK bigrams and ascii words", () => {
	const tokens = tokenize("使用Pi实现上下文压缩 compact/compaction 123");
	assert.ok(tokens.includes("使用"));
	assert.ok(tokens.includes("上下"));
	assert.ok(tokens.includes("文压"));
	assert.ok(tokens.includes("compact"));
	assert.ok(tokens.some((t) => t.includes("compaction")));
});

test("rankMemories returns best by content with recency tiebreak", () => {
	const candidates = [
		cand("本项目需要实现一个内存压缩机制，用于处理长会话。", "a"),
		cand("今天天气很好，适合散步。", "b"),
		cand("compact mechanism for long sessions using memory retrieval", "c"),
	];
	const top = rankMemories("内存压缩 长会话 compact memory", candidates, 2);
	assert.equal(top.length, 2);
	assert.equal(top[0].label, "a");
	assert.equal(top[1].label, "c");
});

test("rankMemories empty query falls back to recency order", () => {
	const candidates = [cand("x content", "old", 0.1), cand("y content", "new", 0.9)];
	const top = rankMemories("   ", candidates, 2);
	assert.deepEqual(top.map((m) => m.label), ["new", "old"]);
});

test("rankMemories empty candidate list returns empty", () => {
	assert.equal(rankMemories("query", [], 3).length, 0);
});

test("rankMemories zero-score results are dropped", () => {
	const candidates = [cand("完全无关的内容 abcdefg", "a"), cand("另一段无关内容 hijklmn", "b")];
	const top = rankMemories("量子计算 超导 qubit", candidates, 2);
	assert.ok(top.length <= 1);
});

test("truncateMemories caps each item and keeps count", () => {
	const memories = [cand("a".repeat(2000), "a"), cand("short", "b")];
	const cut = truncateMemories(memories, 100);
	assert.equal(cut.length, 2);
	assert.ok(cut[0].text.endsWith("…"));
	assert.equal(cut[1].text, "short");
});
