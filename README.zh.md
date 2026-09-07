# pi-agent 记忆锚定 Compact（memory-anchored compact）

[English](README.md) | [简体中文](README.zh.md)

为已安装的 **pi CLI**（`@earendil-works/pi-coding-agent` ≥ 0.85）实现的自定义上下文压缩机制，
严格按以下算法：

1. **保留前 N 条消息** — 对话开头（任务/约束）逐字原样保留；
2. **检索与前 N 条消息相关的记忆，保留 N 条** — 从 pi 自身会话历史/树（AGENTS.md、
   历史会话、既有 compaction/branch 摘要）检索相关记忆注入；
3. **固定 system prompt 部分** — 不触碰 system prompt；
4. **剩下的全部压缩成摘要** — 头部之后的完整回合折叠为一份结构化摘要。

与 pi 原生压缩（保尾压头，`keepRecentTokens`）相反，本机制**保头压尾**，并在头部与摘要之间
注入“与开头任务相关的记忆”，保证长会话中任务定义与关键约束永不丢失。

设计文档见 [`DESIGN.md`](./DESIGN.md)。

## 实现方式：路线 A（纯扩展，不改 pi 核心）

- 注册 `/memory-compact [N]` 与 `/memory-compact reset` 命令，以及自动触发；
- 通过扩展 `context` 事件在每次模型请求前把消息列表**重写**为
  `system + 开头 N 条（逐字） + 记忆块 + 摘要块 + 最新回合`；
- 会话 JSONL 与 pi 原生机制零改动，升级 pi 后仍可用；`/tree` 历史完整保留。

纯逻辑在 `src/plan.ts` / `src/compact.ts` / `src/memory.ts` / `src/sources.ts` 等，
**不依赖 pi 运行时**，可用 `node --test` 直接单测；`src/extension.ts` 是薄薄的 pi 适配层。

## 安装 / 启用

### 1. 禁用 pi 原生自动压缩（避免两套压缩打架）

在 `~/.pi/agent/settings.json` 或项目 `.pi/settings.json` 中加入：

```json
{
  "compaction": { "enabled": false },
  "extensions": ["/Users/raphaelwu/AI/pi-agent-compact/src/extension.ts"]
}
```

> 扩展加载后：手动执行 `/memory-compact`，或让自动触发在上下文压力过高时执行。
> pi 原生 `/compact` 仍可用，但会走官方“保尾”语义；本机制建议只用 `/memory-compact`。

### 2. 可选配置

项目级：`.pi/memory-compact.json`；全局：`~/.pi/agent/memory-compact.json`。
也可用环境变量 `PI_MEMORY_COMPACT_*` 覆盖。

```json
{
  "enabled": true,
  "headMessages": 5,
  "memoryItems": 5,
  "triggerRatio": 0.75,
  "useAgentsMd": true,
  "useSiblingSessions": true,
  "bm25K1": 1.5,
  "bm25B": 0.75,
  "maxMemoryItemChars": 1200,
  "maxToolResultChars": 2000
}
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `headMessages` | `5` | 开头逐字保留的消息数 N（会自动补齐到完整回合，绝不切断工具成对消息） |
| `memoryItems` | `5` | 注入记忆条数 N |
| `triggerRatio` | `0.75` | 上下文占用达窗口比例时自动折叠一次（并需新增内容 ≥ 2048 tokens 才重复折叠） |
| `useAgentsMd` | `true` | 记忆源：AGENTS.md / CLAUDE.md / AGENTS.override.md（cwd 向上 + agentDir） |
| `useSiblingSessions` | `true` | 记忆源：同项目历史会话 JSONL（compaction/branch 摘要 + 首条用户消息） |
| `bm25K1` / `bm25B` | `1.5` / `0.75` | BM25 参数 |
| `maxMemoryItemChars` | `1200` | 单条注入记忆上限 |
| `maxToolResultChars` | `2000` | 序列化摘要输入时把工具结果截断到该字符数 |

### 3. 使用

```
/memory-compact          # 手动触发（下次请求时执行），按当前配置
/memory-compact 10       # 手动触发，本次 N=10
/memory-compact reset    # 清除当前会话压缩检查点
```

自动触发：当估算上下文 > `triggerRatio × contextWindow` 且头部之后有足够的新完整回合时，
在 `context` 事件中自动折叠一次；同一轮内不会重复折叠。

## 记忆源（步骤 2 的实现）

查询 = 开头 N 条消息里的用户文本。候选记忆来自：

- `AGENTS.md` / `CLAUDE.md` / `AGENTS.override.md`：从 cwd 向上至 agentDir，以及 agentDir 本身；
- 同项目会话目录 `~/.pi/agent/sessions/--<cwd>--/*.jsonl` 中其它会话的
  `compaction` 摘要、`branch_summary` 摘要、首个用户消息（排除当前会话文件）；
- 打分：无嵌入的轻量 **BM25**（中文按 2-gram + 拉丁词），叠加**时间衰减**
  （约 14 天半衰期），Top-N 注入，超长条目截断。

## 安全边界

- 折叠只发生在**完整回合边界**，永不切断 assistant `toolCall` 与其 `toolResult`；
- 未结束的“当前回合”始终逐字保留（避免打断工具循环）；手动 `/memory-compact` 采用
  `fold-all`：除“尚未被回答的用户提问”外全部折叠；
- system prompt 完全不动；
- 会话文件只读、零删除（重写只发生在发给模型的请求视图上）；
- 摘要为空 / 模型调用失败时放弃本次折叠，绝不影响用户请求。

## 测试

```sh
node --test "test/*.test.ts"
```

覆盖：头部边界选择（含工具成对、退化会话）、折叠边界（两种策略）、触发阈值、
BM25 中英混排打分、会话 JSONL 记忆抽取、摘要 prompt 构造、布局切片与注入格式。

## 文件

```
src/types.ts        纯类型与默认配置
src/serialize.ts    消息序列化 / turn-start 判定
src/plan.ts         head 边界 + 折叠边界 + 触发决策（纯函数）
src/memory.ts       分词 + BM25 排序 + 截断（纯函数）
src/sources.ts      会话 JSONL / AGENTS.md 记忆抽取（纯函数）
src/compact.ts      检查点 → 视图切片 / 注入块组装（纯函数）
src/prompts.ts      结构化摘要 prompt（与 pi 原生格式一致）
src/settings.ts     配置解析（纯函数）
src/retrieve-query.ts 记忆查询文本（纯函数）
src/extension.ts    pi 扩展适配层（事件、命令、文件 I/O、模型调用）
test/*.test.ts      单元测试
DESIGN.md           设计方案
```
