import { promises as fsp } from "node:fs";
import * as path from "node:path";
import {
	buildView,
	CHECKPOINT_ENTRY_TYPE,
	fingerprintMessages,
	injectedBlock,
	RESET_ENTRY_TYPE,
	restoreCheckpoint,
	serializeCheckpoint,
	type Checkpoint,
	type CustomEntryLike,
} from "./compact.ts";
import { estimateContextTokens, estimateTokens, planFold, planHead, type FoldPolicy } from "./plan.ts";
import { rankMemories, truncateMemories } from "./memory.ts";
import { buildSummarizationPromptText, SUMMARIZATION_SYSTEM_PROMPT } from "./prompts.ts";
import {
	computeContextRoots,
	parseContextFileCandidates,
	parseSessionCandidates,
	parseSessionTreeCandidates,
	recencyFromAgeDays,
	type TreeEntryLike,
} from "./sources.ts";
import { parseMemoryCompactConfig } from "./settings.ts";
import type { MemoryCandidate, MemoryCompactSettings, PlainMessage, PlainRole } from "./types.ts";

// ============================================================================
// Message adapter: pi AgentMessage (loose structural view) -> PlainMessage
// ============================================================================

/** Minimal shape of the pi agent messages we consume. */
interface RawMessageLike {
	role: string;
	content?: unknown;
	summary?: string;
	command?: string;
	output?: string;
	toolCallId?: string;
	toolName?: string;
	timestamp?: number | string;
	usage?: {
		totalTokens?: number;
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	} | null;
}

const TURN_START: ReadonlySet<string> = new Set([
	"user",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
]);

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string; name?: string; args?: unknown; thinking?: string };
		switch (b.type) {
			case "text":
				if (typeof b.text === "string") parts.push(b.text);
				break;
			case "thinking":
				if (typeof b.thinking === "string") parts.push(`[thinking] ${b.thinking}`);
				break;
			case "toolCall":
				parts.push(`[toolCall ${b.name ?? ""} ${b.args === undefined ? "" : JSON.stringify(b.args)}]`);
				break;
			case "image":
				parts.push("[image]");
				break;
			default:
				if (typeof b.text === "string") parts.push(b.text);
		}
	}
	return parts.join("\n");
}

function toPlain(msg: RawMessageLike): PlainMessage {
	const role = msg.role as PlainRole;
	let text = "";
	let usageTokens: number | undefined;
	if (role === "assistant" && msg.usage) {
		const u = msg.usage;
		usageTokens =
			u.totalTokens && u.totalTokens > 0
				? u.totalTokens
				: (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
		if (!usageTokens || usageTokens <= 0) usageTokens = undefined;
	}
	switch (role) {
		case "toolResult":
			text = contentToText(msg.content);
			break;
		case "bashExecution":
			text = `Ran \`${msg.command ?? ""}\`\n${typeof msg.output === "string" ? msg.output : ""}`;
			break;
		case "branchSummary":
		case "compactionSummary":
			text = msg.summary ?? contentToText(msg.content);
			break;
		default:
			text = contentToText(msg.content);
	}
	const plain: PlainMessage = {
		role,
		text,
		isToolResult: role === "toolResult",
		isTurnStart: TURN_START.has(role),
	};
	if (usageTokens !== undefined) plain.usageTokens = usageTokens;
	return plain;
}

function toPlainList(messages: RawMessageLike[]): PlainMessage[] {
	return messages.map(toPlain);
}

// ============================================================================
// Memory source adapter (pi-side file I/O)
// ============================================================================

interface FileCacheEntry {
	mtimeMs: number;
	size: number;
	content?: string;
}

/** mtime+size keyed cache: unchanged files are not re-read between folds. */
const fileContentCache = new Map<string, FileCacheEntry>();

async function readFirstBytes(filePath: string, maxBytes = 1024 * 1024): Promise<string | undefined> {
	try {
		const stat = await fsp.stat(filePath);
		if (!stat.isFile()) return undefined;
		const cached = fileContentCache.get(filePath);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.content !== undefined) {
			return cached.content;
		}
		const handle = await fsp.open(filePath, "r");
		try {
			const buffer = Buffer.alloc(Math.min(maxBytes, stat.size));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const content = buffer.subarray(0, bytesRead).toString("utf8");
			fileContentCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
			return content;
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

const mtimeAgeCache = new Map<string, number>();

async function mtimeAgeDays(filePath: string): Promise<number> {
	const cached = mtimeAgeCache.get(filePath);
	if (cached !== undefined) return cached;
	let age = Number.POSITIVE_INFINITY;
	try {
		const stat = await fsp.stat(filePath);
		age = (Date.now() - stat.mtimeMs) / 86_400_000;
	} catch {
		// keep infinity
	}
	mtimeAgeCache.set(filePath, age);
	return age;
}

const AGENTS_NAMES = ["AGENTS.md", "CLAUDE.md", "AGENTS.override.md"];

/** Walk from cwd up to home (inclusive) plus agentDir looking for AGENTS.md family files. */
async function collectAgentsMd(settings: MemoryCompactSettings): Promise<MemoryCandidate[]> {
	if (!settings.useAgentsMd) return [];
	const candidates: MemoryCandidate[] = [];
	const home = process.env.HOME ?? process.env.USERPROFILE ?? path.dirname(settings.cwd);
	const roots = computeContextRoots(settings.cwd, settings.agentDir, home);
	const seen = new Set<string>();
	for (const root of roots) {
		for (const name of AGENTS_NAMES) {
			const file = path.join(root, name);
			if (seen.has(file)) continue;
			seen.add(file);
			const content = await readFirstBytes(file);
			if (!content) continue;
			const age = await mtimeAgeDays(file);
			candidates.push(
				...parseContextFileCandidates(content, { label: `${name}@${root}`, recency: recencyFromAgeDays(age) }),
			);
		}
	}
	return candidates;
}

/** Read sibling session files in the session dir (project history). */
async function collectSiblingSessions(settings: MemoryCompactSettings): Promise<MemoryCandidate[]> {
	if (!settings.useSiblingSessions || !settings.sessionDir) return [];
	const candidates: MemoryCandidate[] = [];
	let names: string[];
	try {
		names = await fsp.readdir(settings.sessionDir);
	} catch {
		return candidates;
	}
	for (const name of names) {
		if (!name.endsWith(".jsonl")) continue;
		const file = path.join(settings.sessionDir, name);
		if (settings.sessionFile && path.resolve(file) === path.resolve(settings.sessionFile)) continue;
		const age = await mtimeAgeDays(file);
		const content = await readFirstBytes(file);
		if (!content) continue;
		candidates.push(
			...parseSessionCandidates(content, { label: `session ${name}`, recency: recencyFromAgeDays(age) }),
		);
	}
	return candidates;
}

async function collectMemoryCandidates(
	settings: MemoryCompactSettings,
	treeEntries?: TreeEntryLike[],
): Promise<MemoryCandidate[]> {
	const candidates: MemoryCandidate[] = [];
	// DESIGN.md §3.3 source #1: this session's own earlier compaction / branch summaries.
	if (treeEntries && treeEntries.length > 0) {
		candidates.push(...parseSessionTreeCandidates(treeEntries));
	}
	candidates.push(...(await collectAgentsMd(settings)));
	candidates.push(...(await collectSiblingSessions(settings)));
	return candidates;
}

// ============================================================================
// Extension runtime
// ============================================================================

interface SessionState {
	checkpoint?: Checkpoint;
	/** Set by the manual command: perform a full fold at the next request. */
	pendingManual?: boolean;
	/** Number of consecutive failed manual fold attempts (fail-safe retry). */
	manualFailures?: number;
}

const stateBySession = new Map<string, SessionState>();
const configByCwd = new Map<string, MemoryCompactSettings>();
const summarizeInFlight = new Set<string>();

/** Read optional JSON config from <cwd>/.pi/memory-compact.json then ~/.pi/agent/memory-compact.json. */
async function loadConfigJson(cwd: string, agentDir: string): Promise<string | undefined> {
	const candidates = [
		path.join(cwd, ".pi", "memory-compact.json"),
		path.join(agentDir, "memory-compact.json"),
	];
	for (const file of candidates) {
		try {
			const text = await fsp.readFile(file, "utf8");
			if (text.trim()) return text;
		} catch {
			// keep scanning
		}
	}
	return undefined;
}

async function resolveSettings(cwd: string, agentDir: string, sessionDir: string, sessionFile: string | undefined) {
	const cached = configByCwd.get(cwd);
	if (cached) return { ...cached, sessionFile };
	const jsonText = await loadConfigJson(cwd, agentDir);
	const cfg: MemoryCompactSettings = parseMemoryCompactConfig(jsonText, process.env, {
		cwd,
		agentDir,
		sessionDir,
		sessionFile,
	});
	configByCwd.set(cwd, cfg);
	return cfg;
}

function selectMemories(head: PlainMessage[], candidates: MemoryCandidate[], cfg: MemoryCompactSettings): MemoryCandidate[] {
	if (candidates.length === 0) return [];
	const query = head
		.filter((m) => m.role === "user")
		.map((m) => m.text)
		.join("\n")
		.slice(0, 8000);
	if (!query.trim()) {
		return truncateMemories(
			[...candidates].sort((a, b) => b.recency - a.recency).slice(0, cfg.memoryItems),
			cfg.maxMemoryItemChars,
		);
	}
	return truncateMemories(
		rankMemories(query, candidates, cfg.memoryItems, { k1: cfg.bm25K1, b: cfg.bm25B }),
		cfg.maxMemoryItemChars,
	);
}

function foldBoundaryFor(
	messages: PlainMessage[],
	headEnd: number,
	lastFoldThrough: number | undefined,
	policy: FoldPolicy,
): number {
	const bodyStart = lastFoldThrough !== undefined && lastFoldThrough >= headEnd ? lastFoldThrough : headEnd;
	return planFold(messages, bodyStart, policy).foldEnd;
}

/** Best-effort agent dir resolution (~/.pi/agent). */
async function agentDirOf(ctx: any): Promise<string> {
	const sessionDir: string | undefined = ctx.sessionManager?.getSessionDir?.();
	if (sessionDir) {
		const parent = path.dirname(sessionDir);
		if (path.basename(parent) === "sessions") return path.dirname(parent);
	}
	return path.join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".pi", "agent");
}

export default function memoryCompactExtension(pi: {
	on(event: string, handler: (event: any, ctx: any) => unknown): void;
	registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> }): void;
	appendEntry(customType: string, data?: unknown): void;
}) {
	let notify = (_msg: string, _level: "info" | "warning" | "error") => {};

	pi.registerCommand("memory-compact", {
		description:
			"Memory-anchored compact: keep the opening N messages verbatim, inject memories related to them, and fold everything else into one structured summary. Usage: /memory-compact [N] | /memory-compact reset",
		handler: async (args, ctx) => {
			notify = (msg, level) => ctx.ui?.notify?.(msg, level) ?? undefined;
			const sessionKey = ctx.sessionManager?.getSessionId?.() ?? ctx.cwd;
			const trimmed = args.trim();
			if (trimmed === "reset") {
				stateBySession.delete(sessionKey);
				try {
					pi.appendEntry(RESET_ENTRY_TYPE, { resetAt: Date.now() });
				} catch {
					// In-memory clear still applies; persistence is best-effort.
				}
				notify("Memory-compact state cleared.", "info");
				return;
			}
			const st = stateBySession.get(sessionKey) ?? { checkpoint: undefined };
			st.pendingManual = true;
			stateBySession.set(sessionKey, st);
			const n = parseInt(trimmed, 10);
			if (Number.isInteger(n) && n > 0) {
				const cfg = await resolveSettings(ctx.cwd, await agentDirOf(ctx), ctx.sessionManager?.getSessionDir?.() ?? "", ctx.sessionManager?.getSessionFile?.());
				cfg.headMessages = n;
				configByCwd.set(ctx.cwd, cfg);
			}
			notify("Memory-compact armed: the next model request will keep the opening messages, inject related memories, and fold the rest into a summary.", "info");
		},
	});

	pi.on("context", async (event: { messages?: RawMessageLike[] }, ctx: any) => {
		if (!ctx.sessionManager) return undefined;
		const cwd = ctx.cwd;
		const sessionDir = ctx.sessionManager.getSessionDir?.() ?? "";
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		const cfg = await resolveSettings(cwd, await agentDirOf(ctx), sessionDir, sessionFile);
		notify = (msg, level) => ctx.ui?.notify?.(msg, level) ?? undefined;
		if (!cfg.enabled) return undefined;
		const raw = event.messages ?? [];
		if (raw.length === 0) return undefined;

		const sessionKey = ctx.sessionManager.getSessionId?.() ?? cwd;
		const st = stateBySession.get(sessionKey) ?? { checkpoint: undefined };
		const messages = toPlainList(raw);
		const contextWindow = ctx.model?.contextWindow ?? 200_000;

		// ---- re-anchor head; drop stale checkpoint when the session moved ----
		const { headEnd } = planHead(messages, cfg);
		let checkpoint: Checkpoint | undefined = st.checkpoint;
		if (checkpoint) {
			const fp = fingerprintMessages(messages.slice(0, headEnd));
			if (
				headEnd !== checkpoint.headEnd ||
				fp !== checkpoint.headFingerprint ||
				messages.length < checkpoint.foldThrough
			) {
				checkpoint = undefined;
				st.checkpoint = undefined;
			}
		}

		// ---- decide whether to fold now ----
		let foldBody: PlainMessage[] | undefined;
		let foldPolicy: FoldPolicy = "keep-latest-turn";
		const manual = Boolean(st.pendingManual);

		const bodyStart = checkpoint ? checkpoint.foldThrough : headEnd;
		if (bodyStart < messages.length) {
			const policy: FoldPolicy = manual ? "fold-all" : "keep-latest-turn";
			const plan = planFold(messages, bodyStart, policy);
			if (plan.body.length > 0) {
				const tokens = estimateContextTokens(messages).tokens;
				const pressureHigh = contextWindow > 0 && tokens > contextWindow * cfg.triggerRatio;
				const enoughNew = estimateTokens(plan.body) >= 2048;
				if (manual || (pressureHigh && enoughNew)) {
					foldBody = plan.body;
					foldPolicy = policy;
				}
			}
		}

		// ---- perform fold (summary via the same session model) ----
		let foldSucceeded = false;
		if (foldBody && foldBody.length > 0 && !summarizeInFlight.has(sessionKey)) {
			const model = ctx.model;
			if (model && ctx.modelRegistry) {
				summarizeInFlight.add(sessionKey);
				try {
					const head = messages.slice(0, headEnd);
					const candidates = await collectMemoryCandidates(cfg, ctx.sessionManager?.getBranch?.() ?? []);
					const memories = selectMemories(head, candidates, cfg);
					const previousSummary = checkpoint?.summary;
					const promptText = buildSummarizationPromptText(foldBody, {
						previousSummary,
						headText: head.map((m) => m.text).join("\n").slice(0, 2000),
						memories,
						truncateToolResults: cfg.maxToolResultChars,
					});
					const response = await ctx.modelRegistry.complete(
						model,
						{
							systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: promptText }],
									timestamp: Date.now(),
								},
							],
						},
						{ maxTokens: 8192, signal: ctx.signal },
					);
					const summary = (response.content ?? [])
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n")
						.trim();
					if (summary) {
						const newFoldThrough = foldBoundaryFor(messages, headEnd, checkpoint?.foldThrough, foldPolicy);
						checkpoint = {
							headEnd,
							headFingerprint: fingerprintMessages(messages.slice(0, headEnd)),
							foldThrough: newFoldThrough,
							memories,
							summary,
							tokensBefore: estimateContextTokens(messages).tokens,
						};
						st.checkpoint = checkpoint;
						foldSucceeded = true;
						try {
							pi.appendEntry(CHECKPOINT_ENTRY_TYPE, serializeCheckpoint(checkpoint));
						} catch {
							// Persistence is best-effort; the in-memory checkpoint still applies.
						}
					} else {
						notify("Memory-compact summary was empty; nothing was folded.", "warning");
					}
				} catch (error) {
					notify(`Memory-compact failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				} finally {
					summarizeInFlight.delete(sessionKey);
				}
			} else {
				notify("Memory-compact could not fold: no model is available in this context.", "warning");
			}
		}

		// Manual compact: clear the armed flag only on success; keep it on failure so
		// the next request retries (bounded to avoid spamming a broken setup). When
		// there is simply nothing foldable yet (e.g. a single in-flight turn), keep it
		// armed without counting a failure.
		if (foldSucceeded) {
			st.manualFailures = 0;
			st.pendingManual = false;
			notify(
				`Memory-compact: kept ${headEnd} opening messages, injected ${checkpoint?.memories.length ?? 0} memories, folded the rest into a summary.`,
				"info",
			);
		} else if (manual && foldBody && foldBody.length > 0) {
			st.manualFailures = (st.manualFailures ?? 0) + 1;
			if (st.manualFailures >= 3) {
				st.pendingManual = false;
				st.manualFailures = 0;
				notify("Memory-compact kept failing; use /memory-compact again once the issue is fixed.", "error");
			} else {
				st.pendingManual = true;
				notify("Memory-compact will retry on the next request (it could not fold just now).", "warning");
			}
		} else if (manual) {
			st.pendingManual = true;
		} else {
			st.pendingManual = false;
		}
		st.checkpoint = checkpoint;
		stateBySession.set(sessionKey, st);
		if (checkpoint) {
			const view = buildView(messages, checkpoint);
			if (view.head.length === 0) return undefined;
			const out: RawMessageLike[] = [];
			out.push(...raw.slice(0, checkpoint.headEnd));
			const injected = injectedBlock(checkpoint.memories, checkpoint.summary);
			if (injected.trim()) {
				out.push({
					role: "user",
					content: [{ type: "text", text: injected }],
					timestamp: Date.now(),
				});
			}
			out.push(...raw.slice(checkpoint.foldThrough));
			return { messages: out };
		}

		st.checkpoint = undefined;
		stateBySession.set(sessionKey, st);
		return undefined;
	});

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		const key = ctx.sessionManager?.getSessionId?.() ?? ctx.cwd;
		stateBySession.delete(key);
		// Restore a persisted checkpoint written as a custom entry in a previous run.
		// The context handler re-validates head/fold indices and drops stale state.
		try {
			const entries = (ctx.sessionManager?.getEntries?.() ?? []) as CustomEntryLike[];
			const checkpoint = restoreCheckpoint(entries);
			if (checkpoint) {
				stateBySession.set(key, { checkpoint });
			}
		} catch {
			// Restore is best-effort; a fresh fold will be created on demand.
		}
	});
}
