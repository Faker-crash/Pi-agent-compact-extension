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
}

async function loadExtension(): Promise<Loaded> {
	const mod = await import(`../src/extension.ts?${Date.now()}-${Math.random()}`);
	const handlers = new Map<string, (event: any, ctx: Ctx) => unknown>();
	let command: any;
	const pi = {
		on(event: string, handler: any) {
			handlers.set(event, handler);
		},
		registerCommand(name: string, options: any) {
			command = { name, ...options };
		},
	};
	await mod.default(pi);
	return { handlers, command };
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
