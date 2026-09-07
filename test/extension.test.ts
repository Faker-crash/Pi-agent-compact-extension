import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Ctx = any;

function rawMessage(role: string, text: string) {
	return { role, content: [{ type: "text", text }] };
}

function longConversation(turnCount: number): any[] {
	const out: any[] = [];
	for (let i = 0; i < turnCount; i++) {
		out.push(rawMessage("user", `user turn ${i}: memory compact design question`));
		out.push(rawMessage("assistant", `assistant reply ${i}: analysis and plan`));
	}
	return out;
}

let tmpRoot: string;
let sessionDir: string;
let agentDir: string;

async function makeEnv() {
	tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-mc-"));
	sharedEntries = [];
	sessionDir = path.join(tmpRoot, "sessions", "--proj--");
	agentDir = path.join(tmpRoot, "agent");
	await fsp.mkdir(sessionDir, { recursive: true });
	await fsp.mkdir(agentDir, { recursive: true });
	await fsp.writeFile(path.join(agentDir, "AGENTS.md"), "# 项目规则\n本仓库实现 pi-agent 的记忆压缩机制\n");
	// sibling session with a relevant compaction summary
	await fsp.writeFile(
		path.join(sessionDir, "2026-09-01_old.jsonl"),
		[
			JSON.stringify({ type: "session", id: "old" }),
			JSON.stringify({ type: "message", message: { role: "user", content: "memory compact design" } }),
			JSON.stringify({ type: "compaction", summary: "memory compact 设计：保留开头消息、注入记忆、压缩摘要" }),
		].join("\n"),
	);
}

interface Loaded {
	handlers: Map<string, (event: any, ctx: Ctx) => unknown>;
	command: { description: string; handler: (args: string, ctx: Ctx) => Promise<void> };
	/** Custom entries appended via pi.appendEntry by this extension instance. */
	appended: any[];
}

/** Shared mutable store so a "restarted" instance can see entries of the "previous" one. */
let sharedEntries: any[] = [];

async function loadExtension(opts?: { freshEntries?: boolean }): Promise<Loaded> {
	const mod = await import(`../src/extension.ts?${Date.now()}-${Math.random()}`);
	const handlers = new Map<string, (event: any, ctx: Ctx) => unknown>();
	const appended: any[] = opts?.freshEntries ? [] : sharedEntries;
	let command: any;
	const pi = {
		on(event: string, handler: any) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, options: any) {
			command = { name, ...options };
		},
		appendEntry(customType: string, data: unknown) {
			appended.push({ type: "custom", customType, data, timestamp: Date.now() });
		},
	};
	await mod.default(pi);
	return { handlers, command, appended };
}

function makeCtx(_messages: any[]): Ctx {
	return {
		cwd: tmpRoot,
		ui: { notify() {} },
		model: { contextWindow: 40_000, id: "test-model" },
		modelRegistry: {
			complete: async () => ({
				content: [{ type: "text", text: "## Goal\nkeep the design\n\n## Progress\n### Done\n- [x] 完成 compact 核心逻辑\n\n## Next Steps\n1. 继续实现" }],
			}),
		},
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionDir: () => sessionDir,
			getSessionFile: () => path.join(sessionDir, "2026-09-07_current.jsonl"),
			getSessionName: () => undefined,
			getLeafId: () => "leaf",
			getEntries: () => sharedEntries,
			// Current-session tree memory source: an earlier branch summary on this branch.
			getBranch: () => [
				{ type: "branch_summary", summary: "tree memory compact 分支摘要：本会话早期分支结论" },
			],
		},
		signal: undefined,
	};
}

test("integration: manual /memory-compact rewrites context into head+memory+summary layout", async () => {
	await makeEnv();
	const { handlers, command } = await loadExtension();
	assert.ok(command, "registerCommand called");
	const ctx = makeCtx(longConversation(8)); // 16 messages
	await command.handler("", ctx);

	const result = (await handlers.get("context")!({ messages: longConversation(8) }, ctx)) as { messages: any[] } | undefined;
	assert.ok(result, "context rewrite produced a result");
	const out = result.messages;
	// headMessages default 5 → planHead extends to a turn boundary → 6 messages kept
	const head = out.filter((_m: any, i: number) => i < 6);
	assert.equal(head.length, 6);
	assert.equal(head[0].role, "user");
	// find injected block
	const injected = out.find((m: any) => Array.isArray(m.content) && m.content.some((c: any) => typeof c.text === "string" && c.text.includes("<summary>")));
	assert.ok(injected, "injected summary block present");
	const text = (injected.content as any[]).map((c) => c.text).join("");
	assert.ok(text.includes("<memory>"), "memory section present");
	assert.ok(text.includes("memory compact 设计"), "sibling-session memory was retrieved");
	assert.ok(text.includes("tree memory compact 分支摘要"), "current-session tree memory was retrieved");
	assert.ok(text.includes("## Goal"), "summary content present");
	// original message objects preserved verbatim (not reserialized)
	assert.deepEqual(out[0], rawMessage("user", "user turn 0: memory compact design question"));
});

test("integration: context under threshold and no checkpoint passes through unchanged", async () => {
	await makeEnv();
	const { handlers } = await loadExtension();
	const messages = longConversation(2); // tiny
	const ctx = makeCtx(messages);
	const result = await handlers.get("context")!({ messages }, ctx);
	assert.equal(result, undefined);
});

test("integration: reset clears the checkpoint and restores passthrough", async () => {
	await makeEnv();
	const { handlers, command } = await loadExtension();
	const messages = longConversation(8);
	const ctx = makeCtx(messages);
	await command.handler("", ctx);
	const first = (await handlers.get("context")!({ messages }, ctx)) as { messages?: any[] } | undefined;
	assert.ok(first?.messages);
	await command.handler("reset", ctx);
	const second = await handlers.get("context")!({ messages: longConversation(8) }, ctx);
	assert.equal(second, undefined);
});

test("integration: second manual fold advances foldThrough and keeps only latest tail", async () => {
	await makeEnv();
	const { handlers, command } = await loadExtension();
	const ctx = makeCtx(longConversation(8));
	await command.handler("", ctx);
	await handlers.get("context")!({ messages: longConversation(8) }, ctx);

	// Now the session has grown by another 4 turns (8 messages).
	const grown = [...longConversation(8), ...longConversation(4)];
	const ctx2 = makeCtx(grown);
	await command.handler("", ctx2);
	const result = (await handlers.get("context")!({ messages: grown }, ctx2)) as { messages: any[] } | undefined;
	assert.ok(result, "incremental fold produced a result");
	// head still 6 messages
	assert.equal(result.messages[0].role, "user");
	const headCount = result.messages.filter((_m: any, i: number) => i < 6).length;
	assert.equal(headCount, 6);
	const injected = result.messages.find((m: any) =>
		Array.isArray(m.content) && m.content.some((c: any) => typeof c.text === "string" && c.text.includes("<summary>")),
	);
	assert.ok(injected, "summary injected after incremental fold");
});

test("integration: prefix change (branch switch) invalidates checkpoint and passes through", async () => {
	await makeEnv();
	const { handlers, command } = await loadExtension();
	const ctx = makeCtx(longConversation(8));
	await command.handler("", ctx);
	await handlers.get("context")!({ messages: longConversation(8) }, ctx);

	// Different prefix => fingerprint mismatch => checkpoint dropped => passthrough.
	const branch = [
		rawMessage("user", "completely different session prefix"),
		rawMessage("assistant", "other work"),
		...longConversation(7),
	];
	const ctx2 = makeCtx(branch);
	const result = await handlers.get("context")!({ messages: branch }, ctx2);
	assert.equal(result, undefined);
});

test("integration: checkpoint persists via appendEntry and restores on session_start", async () => {
	await makeEnv();
	const ext = await loadExtension();
	const ctx = makeCtx(longConversation(8));
	await ext.command.handler("", ctx);
	const first = (await ext.handlers.get("context")!({ messages: longConversation(8) }, ctx)) as { messages: any[] } | undefined;
	assert.ok(first?.messages, "fold produced a compacted view");
	const persisted = sharedEntries.filter((e) => e?.customType === "pi-memory-compact.checkpoint");
	assert.equal(persisted.length, 1, "checkpoint written as a custom entry");
	assert.equal(persisted[0].data.summary.includes("## Goal"), true);

	// Simulate a fresh extension instance (new process/restart): restore from session entries.
	const restarted = await loadExtension({ freshEntries: true });
	sharedEntries = ext.appended; // "session file" carries the entries written before
	await restarted.handlers.get("session_start")!({}, makeCtx(longConversation(8)));

	// Now a context request should reuse the restored checkpoint (injected summary) without a manual arm.
	const reused = (await restarted.handlers.get("context")!({ messages: longConversation(8) }, makeCtx(longConversation(8)))) as { messages: any[] } | undefined;
	assert.ok(reused?.messages, "restored checkpoint applied on next request");
	const injected = reused.messages.find((m: any) =>
		Array.isArray(m.content) && m.content.some((c: any) => typeof c.text === "string" && c.text.includes("<summary>")),
	);
	assert.ok(injected, "summary injected from restored checkpoint");
});

test("integration: reset writes a marker so restore ignores stale checkpoints", async () => {
	await makeEnv();
	const ext = await loadExtension();
	const ctx = makeCtx(longConversation(8));
	await ext.command.handler("", ctx);
	await ext.handlers.get("context")!({ messages: longConversation(8) }, ctx);
	await ext.command.handler("reset", ctx);

	// A fresh instance restoring the same session entries must find no checkpoint.
	const restarted = await loadExtension({ freshEntries: true });
	sharedEntries = ext.appended;
	await restarted.handlers.get("session_start")!({}, makeCtx(longConversation(8)));
	const after = await restarted.handlers.get("context")!({ messages: longConversation(8) }, makeCtx(longConversation(8)));
	assert.equal(after, undefined, "reset marker invalidates the persisted checkpoint");
});

test("integration: folding is locked per session, not globally", async () => {
	await makeEnv();
	const ext = await loadExtension();

	// Session A's summarizer blocks until released.
	let releaseA: () => void = () => {};
	const gateA = new Promise<void>((res) => (releaseA = res));
	let aCalled = 0;
	const ctxA = makeCtx(longConversation(8));
	ctxA.sessionManager.getSessionId = () => "sess-A";
	ctxA.modelRegistry.complete = async () => {
		aCalled++;
		await gateA;
		return { content: [{ type: "text", text: "## Goal\nsummary A" }] };
	};

	// Session B is independent and should fold while A is still in flight.
	let bCalled = 0;
	const ctxB = makeCtx(longConversation(8));
	ctxB.sessionManager.getSessionId = () => "sess-B";
	ctxB.modelRegistry.complete = async () => {
		bCalled++;
		return { content: [{ type: "text", text: "## Goal\nsummary B" }] };
	};

	await ext.command.handler("", ctxA);
	const pA = ext.handlers.get("context")!({ messages: longConversation(8) }, ctxA);

	await ext.command.handler("", ctxB);
	const rB = (await ext.handlers.get("context")!({ messages: longConversation(8) }, ctxB)) as { messages: any[] } | undefined;

	assert.equal(bCalled, 1, "session B folded while session A was still summarizing");
	assert.ok(rB?.messages.some((m: any) => JSON.stringify(m.content ?? "").includes("<summary>")));

	releaseA();
	await pA;
	assert.equal(aCalled, 1, "session A folded once");
});

test("integration: manual fold failure keeps the request armed and retries on the next request", async () => {
	await makeEnv();
	const ext = await loadExtension();
	const ctx = makeCtx(longConversation(8));
	let calls = 0;
	ctx.modelRegistry.complete = async () => {
		calls++;
		if (calls === 1) throw new Error("simulated provider failure");
		return { content: [{ type: "text", text: "## Goal\nretry summary" }] };
	};

	await ext.command.handler("", ctx);
	const failed = await ext.handlers.get("context")!({ messages: longConversation(8) }, ctx);
	assert.equal(failed, undefined, "failed fold leaves no compacted view");

	// Armed flag must still be set: the next request retries without a new /memory-compact.
	const retried = (await ext.handlers.get("context")!({ messages: longConversation(8) }, ctx)) as { messages: any[] } | undefined;
	assert.ok(retried?.messages, "retried fold succeeded without re-arming");
	const injected = retried.messages.find((m: any) =>
		Array.isArray(m.content) && m.content.some((c: any) => typeof c.text === "string" && c.text.includes("retry summary")),
	);
	assert.ok(injected, "summary from the retried fold is injected");
	assert.equal(calls, 2);
});

test("integration: manual fold failures cap after three attempts", async () => {
	await makeEnv();
	const ext = await loadExtension();
	const ctx = makeCtx(longConversation(8));
	ctx.modelRegistry.complete = async () => {
		throw new Error("always failing");
	};
	await ext.command.handler("", ctx);
	for (let i = 0; i < 4; i++) {
		await ext.handlers.get("context")!({ messages: longConversation(8) }, ctx);
	}
	// After 3 failures the flag is dropped; a 5th request must not attempt another fold.
	let calls = 0;
	const original = ctx.modelRegistry.complete;
	ctx.modelRegistry.complete = async () => {
		calls++;
		return { content: [{ type: "text", text: "## Goal\nx" }] };
	};
	await ext.handlers.get("context")!({ messages: longConversation(8) }, ctx);
	assert.equal(calls, 0, "armed flag cleared after repeated failures");
	ctx.modelRegistry.complete = original;
});
