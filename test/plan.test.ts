import { test } from "node:test";
import assert from "node:assert/strict";
import { foldBoundary, planFold, planHead, prepareFold, estimateTokens, shouldCompactNow } from "../src/plan.ts";
import { defaultSettings } from "../src/types.ts";
import type { PlainMessage } from "../src/types.ts";

function msg(role: PlainMessage["role"], text = "x"): PlainMessage {
	return {
		role,
		text,
		isToolResult: role === "toolResult",
		isTurnStart: role !== "assistant" && role !== "toolResult",
	};
}

function mk(roles: string[], texts?: string[]): PlainMessage[] {
	return roles.map((r, i) => msg(r as PlainMessage["role"], texts?.[i] ?? `m${i}`));
}

const settings = defaultSettings({ headMessages: 2 });

test("planHead keeps at least N messages and extends to a turn boundary", () => {
	// user, assistant, toolResult, user, assistant
	const messages = mk(["user", "assistant", "toolResult", "user", "assistant"]);
	const plan = planHead(messages, settings);
	// N=2 → start index 2, but message[2] is toolResult → extend to index 3 (user) → head = [0,1,2]
	assert.equal(plan.headEnd, 3);
	assert.equal(plan.hasUserContent, true);
});

test("planHead does not split tool result pairs when head lands mid round", () => {
	// one big turn: user, assistant(toolCall), toolResult, assistant(toolCall), toolResult, user...
	const messages = mk(["user", "assistant", "toolResult", "assistant", "toolResult", "user"]);
	// N=2 → index 2 toolResult → extend to index 5? next after head is messages[5]=user. head=0..5
	const plan = planHead(messages, settings);
	assert.equal(plan.headEnd, 5);
});

test("planHead handles empty and degenerate sessions", () => {
	assert.equal(planHead([], settings).headEnd, 0);
	// no user at all: assistant only
	const messages = mk(["assistant", "assistant"]);
	const plan = planHead(messages, settings);
	assert.equal(plan.headEnd, 2);
	assert.equal(plan.hasUserContent, false);
});

test("planFold keep-latest-turn: folds only completed turns before newest turn start", () => {
	const messages = mk(["user", "assistant", "user", "assistant", "user", "assistant"]);
	const plan = planFold(messages, 2, "keep-latest-turn");
	// newest turn start at index 4 → body [2..4) = [user,assistant]; tail from 4
	assert.equal(plan.foldEnd, 4);
	assert.equal(plan.body.length, 2);
	assert.equal(plan.tail.length, 2);
	assert.deepEqual(plan.body.map((m) => m.role), ["user", "assistant"]);
	assert.deepEqual(plan.tail.map((m) => m.role), ["user", "assistant"]);
});

test("planFold keep-latest-turn: in-flight tool round stays in the tail", () => {
	const messages = mk(["user", "assistant", "user", "assistant", "toolResult", "assistant"]);
	const plan = planFold(messages, 2, "keep-latest-turn");
	// newest user-like at index 2; body empty ([2..2)) since current turn is still open
	assert.equal(plan.foldEnd, 2);
	assert.equal(plan.body.length, 0);
	assert.equal(plan.tail.length, 4);
});

test("planFold fold-all: folds everything except a trailing unanswered user prompt", () => {
	const messages = mk(["user", "assistant", "user", "assistant", "user"]);
	const plan = planFold(messages, 2, "fold-all");
	assert.equal(plan.foldEnd, 4);
	assert.equal(plan.body.length, 2);
	assert.deepEqual(plan.tail.map((m) => m.role), ["user"]);
});

test("planFold fold-all: folds to end when no trailing prompt (manual compact)", () => {
	const messages = mk(["user", "assistant", "user", "assistant"]);
	const plan = planFold(messages, 2, "fold-all");
	assert.equal(plan.foldEnd, 4);
	assert.equal(plan.tail.length, 0);
});

test("foldBoundary policy helpers stay in range", () => {
	assert.equal(foldBoundary(mk(["user", "assistant", "user"]), 1, "keep-latest-turn"), 2);
	assert.equal(foldBoundary(mk(["user", "assistant", "user"]), 5, "keep-latest-turn"), 3);
});

test("prepareFold folds under pressure with enough new content", () => {
	const long = (n: number) =>
		Array.from({ length: n }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", "y".repeat(2000)));
	const messages = long(30);
	const result = prepareFold({
		messages,
		headCount: 2,
		contextWindow: 10_000,
		settings: defaultSettings({ headMessages: 2, triggerRatio: 0.75 }),
		minNewTokens: 1000,
	});
	assert.equal(result.fold, true);
	assert.ok(result.plan.body.length > 0);
});

test("prepareFold does not fold when context is small", () => {
	const messages = mk(["user", "assistant", "user", "assistant"]);
	const result = prepareFold({
		messages,
		headCount: 2,
		contextWindow: 1_000_000,
		settings: defaultSettings({ headMessages: 2 }),
		minNewTokens: 10,
	});
	assert.equal(result.fold, false);
});

test("prepareFold force with fold-all folds even without pressure", () => {
	const messages = mk(["user", "assistant", "user", "assistant"]);
	const result = prepareFold({
		messages,
		headCount: 1,
		contextWindow: 1_000_000,
		settings: defaultSettings({ headMessages: 1 }),
		force: true,
		policy: "fold-all",
		minNewTokens: 0,
	});
	assert.equal(result.fold, true);
	assert.ok(result.plan.body.length > 0);
});

test("estimateTokens & shouldCompactNow agree on thresholds", () => {
	const messages = mk(["user", "assistant"], ["a".repeat(2000), "b".repeat(2000)]);
	assert.equal(estimateTokens(messages), Math.ceil(4000 / 4));
	const s = shouldCompactNow(messages, 1000, defaultSettings({ triggerRatio: 0.5 }));
	assert.equal(s.shouldFold, true);
});
