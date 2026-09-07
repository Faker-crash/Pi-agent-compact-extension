import { test } from "node:test";
import assert from "node:assert/strict";
import { buildView, injectedBlock } from "../src/compact.ts";
import type { Checkpoint } from "../src/compact.ts";
import type { MemoryCandidate, PlainMessage } from "../src/types.ts";
import { formatMemories, formatSummary, MEMORY_OPEN, SUMMARY_OPEN } from "../src/layout.ts";
import { serializeMessages, isTurnStartRole } from "../src/serialize.ts";
import { parseSessionCandidates, parseContextFileCandidates, recencyFromAgeDays } from "../src/sources.ts";
import { parseMemoryCompactConfig } from "../src/settings.ts";
import { buildSummarizationPromptText } from "../src/prompts.ts";

const m = (role: PlainMessage["role"], text = "x"): PlainMessage => ({
	role,
	text,
	isToolResult: role === "toolResult",
	isTurnStart: isTurnStartRole(role),
});

test("buildView slices head and tail around the checkpoint", () => {
	const messages = [m("user", "u1"), m("assistant", "a1"), m("user", "u2"), m("assistant", "a2"), m("user", "u3")];
	const cp: Checkpoint = {
		headEnd: 2,
		headFingerprint: "fp",
		foldThrough: 3,
		memories: [],
		summary: "S",
		tokensBefore: 100,
	};
	const view = buildView(messages, cp);
	assert.equal(view.head.length, 2);
	assert.equal(view.head[1].text, "a1");
	assert.equal(view.summary, "S");
	assert.deepEqual(view.tail.map((x) => x.text), ["a2", "u3"]);
});

test("injectedBlock contains memory and summary sections", () => {
	const memories: MemoryCandidate[] = [{ text: "mem1", label: "l1", recency: 1 }];
	const block = injectedBlock(memories, "sum1");
	assert.ok(block.includes(MEMORY_OPEN));
	assert.ok(block.includes(SUMMARY_OPEN));
	assert.ok(block.includes("sum1"));
	assert.ok(block.includes("mem1"));
});

test("formatMemories renders numbered list with labels", () => {
	const memories: MemoryCandidate[] = [
		{ text: "a", label: "x", recency: 1 },
		{ text: "b", label: "y", recency: 1 },
	];
	const out = formatMemories(memories);
	assert.ok(out.includes("[1] (x) a"));
	assert.ok(out.includes("[2] (y) b"));
});

test("formatSummary wraps the summary text", () => {
	const out = formatSummary("goal");
	assert.ok(out.includes("<summary>"));
	assert.ok(out.includes("goal"));
});

test("serializeMessages renders roles with labels", () => {
	const out = serializeMessages([m("user", "hi"), m("assistant", "hello"), m("toolResult", "out")]);
	assert.ok(out.includes("[User]: hi"));
	assert.ok(out.includes("[Assistant]: hello"));
	assert.ok(out.includes("[Tool result]: out"));
});

test("isTurnStartRole covers user-like roles only", () => {
	assert.equal(isTurnStartRole("user"), true);
	assert.equal(isTurnStartRole("toolResult"), false);
	assert.equal(isTurnStartRole("assistant"), false);
	assert.equal(isTurnStartRole("bashExecution"), true);
	assert.equal(isTurnStartRole("custom"), true);
	assert.equal(isTurnStartRole("compactionSummary"), true);
});

test("parseSessionCandidates extracts compaction/branch summaries and first user", () => {
	const content = [
		JSON.stringify({ type: "session", id: "s1" }),
		JSON.stringify({ type: "message", message: { role: "user", content: "首条用户问题" } }),
		JSON.stringify({ type: "compaction", summary: "compaction summary text" }),
		JSON.stringify({ type: "message", message: { role: "user", content: "second user" } }),
		JSON.stringify({ type: "branch_summary", summary: "branch summary text" }),
	].join("\n");
	const c = parseSessionCandidates(content, { label: "s", recency: 0.5 });
	assert.ok(c.some((x) => x.text === "compaction summary text" && x.label.includes("compaction")));
	assert.ok(c.some((x) => x.text === "branch summary text" && x.label.includes("branch")));
	assert.ok(c.some((x) => x.text.includes("首条用户问题") && x.label.includes("first user")));
});

test("parseContextFileCandidates returns a doc candidate bounded by maxChars", () => {
	const c = parseContextFileCandidates("a".repeat(5000), { label: "AGENTS.md", recency: 1, maxChars: 100 });
	assert.equal(c.length, 1);
	assert.equal(c[0].text.length, 100);
});

test("recencyFromAgeDays decays towards zero", () => {
	assert.ok(recencyFromAgeDays(0) > recencyFromAgeDays(14));
	assert.ok(recencyFromAgeDays(30) < 0.5);
});

test("parseMemoryCompactConfig merges file + env over defaults", () => {
	const cfg = parseMemoryCompactConfig(
		JSON.stringify({ headMessages: 7, useAgentsMd: false }),
		{ PI_MEMORY_COMPACT_MEMORY_ITEMS: "3" },
	);
	assert.equal(cfg.headMessages, 7);
	assert.equal(cfg.memoryItems, 3);
	assert.equal(cfg.useAgentsMd, false);
	assert.equal(cfg.enabled, true);
});

test("buildSummarizationPromptText embeds conversation and previous summary", () => {
	const body = [m("user", "do X"), m("assistant", "done")];
	const prompt = buildSummarizationPromptText(body, { previousSummary: "old", memories: [{ text: "m1", label: "l", recency: 1 }] });
	assert.ok(prompt.includes("<conversation>"));
	assert.ok(prompt.includes("[User]: do X"));
	assert.ok(prompt.includes("old"));
	assert.ok(prompt.includes("m1"));
});

test("fingerprintMessages is stable for identical prefixes and differs otherwise", async () => {
	const { fingerprintMessages } = await import("../src/compact.ts");
	const a = [m("user", "same"), m("assistant", "same")];
	const b = [m("user", "same"), m("assistant", "different")];
	assert.equal(fingerprintMessages(a), fingerprintMessages([m("user", "same"), m("assistant", "same")]));
	assert.notEqual(fingerprintMessages(a), fingerprintMessages(b));
	assert.ok(fingerprintMessages([]).length > 0);
});

test("parseSessionTreeCandidates extracts current-session compaction and branch summaries", async () => {
	const { parseSessionTreeCandidates } = await import("../src/sources.ts");
	const entries = [
		{ type: "message", summary: undefined },
		{ type: "compaction", summary: "当前会话早期压缩摘要 content" },
		{ type: "branch_summary", summary: "某个分支的摘要 content" },
		{ type: "compaction", summary: "   " },
	];
	const c = parseSessionTreeCandidates(entries);
	assert.equal(c.length, 2);
	assert.ok(c.some((x) => x.text === "当前会话早期压缩摘要 content" && x.label.includes("(compaction)")));
	assert.ok(c.some((x) => x.text === "某个分支的摘要 content" && x.label.includes("(branch)")));
	assert.ok(c.every((x) => x.recency === 1));
});

test("computeContextRoots stops at home and includes agentDir exactly once", async () => {
	const { computeContextRoots } = await import("../src/sources.ts");
	const roots = computeContextRoots("/Users/u/proj/sub", "/Users/u/.pi/agent", "/Users/u");
	// cwd -> /Users/u/proj -> /Users/u/proj? no: parent chain is /Users/u/proj -> /Users/u (home, stop)
	assert.deepEqual(roots, ["/Users/u/proj/sub", "/Users/u/proj", "/Users/u", "/Users/u/.pi/agent"]);
});

test("computeContextRoots does not dedupe incorrectly when agentDir is inside home chain", async () => {
	const { computeContextRoots } = await import("../src/sources.ts");
	// agentDir inside an already visited dir is appended once; path may differ lexically
	const roots = computeContextRoots("/Users/u/a", "/Users/u/.pi/agent", "/Users/u");
	assert.ok(roots.includes("/Users/u/.pi/agent"));
	assert.equal(roots.filter((r) => r === "/Users/u/.pi/agent").length, 1);
});

test("computeContextRoots stops at home instead of walking to filesystem root", async () => {
	const { computeContextRoots } = await import("../src/sources.ts");
	const roots = computeContextRoots("/Users/u/proj", "/Users/u/.pi/agent", "/Users/u");
	assert.ok(!roots.includes("/"), "home boundary stops the ancestor walk before /");
	assert.deepEqual(roots, ["/Users/u/proj", "/Users/u", "/Users/u/.pi/agent"]);
});

test("serializeMessages truncates oversized tool results with a marker", async () => {
	const { serializeMessages, truncateMessageText } = await import("../src/serialize.ts");
	const t = truncateMessageText("a".repeat(10_000), 2000);
	assert.ok(t.length < 2600, `truncated text bounded: ${t.length}`);
	assert.ok(t.includes("truncated"));
	// long tool result capped, short ones untouched
	const big = m("toolResult", "x".repeat(5000));
	const small = m("user", "hi");
	const out = serializeMessages([big, small], { truncateToolResults: 2000 });
	assert.ok(out.includes("[Tool result]: "));
	assert.ok(out.length < 2600, `serialized length bounded: ${out.length}`);
});

test("buildSummarizationPromptText truncates tool results when asked", async () => {
	const { buildSummarizationPromptText } = await import("../src/prompts.ts");
	const body = [m("toolResult", "z".repeat(8000))];
	const prompt = buildSummarizationPromptText(body, { truncateToolResults: 2000 });
	assert.ok(prompt.length < 8000, `prompt bounded: ${prompt.length}`);
});
