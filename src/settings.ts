import type { MemoryCompactSettings } from "./types.ts";

/**
 * Parse configuration for the memory-anchored compact.
 * Pure: takes JSON text + a record of env vars, returns merged settings.
 * File discovery / env reading happens in the pi extension adapter.
 */
export function parseMemoryCompactConfig(
	jsonText: string | undefined,
	env: Record<string, string | undefined>,
	partial?: Partial<MemoryCompactSettings>,
): MemoryCompactSettings {
	let fileConfig: Record<string, unknown> = {};
	if (jsonText && jsonText.trim()) {
		try {
			const parsed = JSON.parse(jsonText) as Record<string, unknown>;
			if (parsed && typeof parsed === "object") fileConfig = parsed;
		} catch {
			// Invalid JSON file: ignore, use defaults.
		}
	}
	const fromEnv = (key: string): boolean | number | string | undefined => {
		const value = env[key];
		if (value === undefined || value === "") return undefined;
		if (value === "true") return true;
		if (value === "false") return false;
		const num = Number(value);
		if (!Number.isNaN(num) && value.trim() !== "") return num;
		return value;
	};
	const envValue = (key: string) => fromEnv(`PI_MEMORY_COMPACT_${key}`);

	const merged = {
		enabled: coerce(fileConfig.enabled, envValue("ENABLED"), true),
		headMessages: coerce(fileConfig.headMessages, envValue("HEAD_MESSAGES"), 5),
		memoryItems: coerce(fileConfig.memoryItems, envValue("MEMORY_ITEMS"), 5),
		triggerRatio: coerce(fileConfig.triggerRatio, envValue("TRIGGER_RATIO"), 0.75),
		cwd: coerce(fileConfig.cwd, envValue("CWD"), ""),
		agentDir: coerce(fileConfig.agentDir, envValue("AGENT_DIR"), ""),
		sessionDir: coerce(fileConfig.sessionDir, envValue("SESSION_DIR"), ""),
		sessionFile: coerce(fileConfig.sessionFile, envValue("SESSION_FILE"), undefined),
		useAgentsMd: coerce(fileConfig.useAgentsMd, envValue("USE_AGENTS_MD"), true),
		useSiblingSessions: coerce(fileConfig.useSiblingSessions, envValue("USE_SIBLING_SESSIONS"), true),
		bm25K1: coerce(fileConfig.bm25K1, envValue("BM25_K1"), 1.5),
		bm25B: coerce(fileConfig.bm25B, envValue("BM25_B"), 0.75),
		maxMemoryItemChars: coerce(fileConfig.maxMemoryItemChars, envValue("MAX_MEMORY_ITEM_CHARS"), 1200),
		maxToolResultChars: coerce(fileConfig.maxToolResultChars, envValue("MAX_TOOL_RESULT_CHARS"), 2000),
		...(partial ?? {}),
	} as MemoryCompactSettings;
	// Clamp dangerous values.
	merged.headMessages = Math.max(1, Math.floor(Number(merged.headMessages) || 5));
	merged.memoryItems = Math.max(0, Math.floor(Number(merged.memoryItems) || 0));
	merged.triggerRatio = Math.min(0.98, Math.max(0.2, Number(merged.triggerRatio) || 0.75));
	return merged;
}

function coerce(fileValue: unknown, envValue: unknown, fallback: unknown): unknown {
	if (envValue !== undefined && envValue !== null) return envValue;
	if (fileValue !== undefined && fileValue !== null) return fileValue;
	return fallback;
}
