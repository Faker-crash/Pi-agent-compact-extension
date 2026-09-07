# pi-agent 记忆锚定 Compact 机制 — 设计方案

> 目标运行时：本机已安装的 `@earendil-works/pi-coding-agent` v0.85.1（`pi` CLI）。
> 交付策略：先出方案，确认后再实现。

---

## 1. 背景与目标

### 1.1 要实现的 compact 算法（需求原文拆解）

1. **保留前 N 条消息**：对话开头的 N 条消息（通常是任务描述、用户约束、最初的计划）逐字保留；
2. **检索与前 N 条消息相关的记忆，保留 N 条**：以开头 N 条消息为查询，从记忆源检索相关记忆并注入；
3. **固定 system prompt 部分**：system prompt 原样保留，不参与压缩、不被改写；
4. **剩下的全部压缩成摘要**：开头 N 条之后的所有会话内容被压缩为一份结构化摘要。

目标布局（紧凑后模型看到的上下文）：

```
system prompt（固定）
──────────────────────────────
[开头 N 条消息  逐字原样]        ← 步骤 1
[检索到的 N 条记忆]             ← 步骤 2
[其余全部内容的摘要]            ← 步骤 4
──────────────────────────────
（之后的对话在摘要后继续追加）
```

### 1.2 记忆源约定（已与用户确认）

记忆 = **pi 自身的会话历史/树**，具体指：
- 当前会话所在项目目录 `~/.pi/agent/sessions/--<cwd 编码>--/*.jsonl` 中的历史会话；
- 当前会话树中的 `compaction` 条目摘要、`branch_summary` 分支摘要；
- 项目上下文文件 `AGENTS.md` / `CLAUDE.md` / `AGENTS.override.md`；
- （可选）`~/.pi/agent/sessions/` 下其他项目目录的会话文件（跨项目记忆，默认关闭）。

> 注：本方案不引入外部记忆后端 / 向量库 / embedding，仅用纯文本检索（轻量词法打分），
> 因为 pi 自身无向量存储，且该 compact 机制应能在无网络依赖的纯本地场景工作。

---

## 2. pi 现状盘点（关键约束）

### 2.1 pi 的原生 compact 是“保尾压头”，与目标算法互为镜像

pi 原生压缩（`dist/core/compaction/compaction.js`）：

1. `findCutPoint()`：从**最新**消息倒序累计 token，直到达到 `keepRecentTokens`（默认 20000）；
2. 切断点之前（较旧的部分）→ `messagesToSummarize`；
3. 调用 LLM 生成结构化摘要，追加一条 `CompactionEntry{ summary, firstKeptEntryId, tokensBefore, details:{readFiles,modifiedFiles} }`；
4. 上下文重建 `buildContextEntries()`（`session-manager.js`）：模型看到
   `system + 摘要消息 + firstKeptEntryId 起的消息 + 压缩条目之后的新消息`。

即 pi 原生 = **保留“最近尾部”逐字，压缩“较旧头部”**。
而目标算法 = **保留“开头头部”逐字（且压缩的是它之后的内容）** —— 方向相反。

### 2.2 pi 的扩展面

| 机制 | 位置 | 能力 |
| --- | --- | --- |
| `session_before_compact` | 扩展事件 | 可 `cancel` 或返回自定义 `{summary, firstKeptEntryId, ...}`；但**边界选取由核心 `prepareCompaction` 决定**（保尾压头） |
| `context` 事件 | `extensions/runner.js: emitContext()` | 每次请求前拿到组装好的 `AgentMessage[]`，可整体替换发往模型的消息列表（system prompt 在其外部，天然固定） |
| 扩展命令 ctx | `ExtensionCommandContext` | `sessionManager` 只读（`ReadonlySessionManager`），可读 `getEntries()/getTree()/getSessionFile()`；可注册 `/命令` |
| settings | `~/.pi/agent/settings.json` / `.pi/settings.json` | `compaction.{enabled,reserveTokens,keepRecentTokens}`、`extensions[]` |

### 2.3 核心结论

- “保头压尾”无法用单条 `CompactionEntry` 的 `firstKeptEntryId` 语义表达（它只能表达“从某处保留到叶子”）。
- 实现目标布局有两条可行路线，见第 4 节。两者都无需改动 system prompt 组装（system prompt 不来自会话条目，天然固定，满足步骤 3）。

---

## 3. 算法详细定义

### 3.1 输入

- `entries`：当前会话从根到叶子路径上的条目（header 之外的 `SessionEntry[]`），
  由 `ctx.sessionManager.getEntries()` / 直接解析 JSONL 获得；
- `settings`（新增配置，见 §5）；
- `model`：当前会话模型（摘要生成用，与 pi 原生一致走 `ctx.modelRegistry.complete`）；
- `signal`：中止信号（尊重用户取消 / 溢出恢复）。

### 3.2 步骤 1：选取并保留“开头 N 条消息”

- 把条目流式映射为“上下文消息”（user / assistant / tool 成对消息等），跳过不参与上下文的条目（`thinking_level_change`、`model_change`、`custom`、`label`、`session_info`）。
- 从头开始收集，直到累计 **N_head 条消息**。
- **完整性规则**（与 pi 原生 cut-point 精神一致）：
  - 若第 N_head 条处于某个 user turn 的中间（含 tool 调用/结果的半截），则扩展边界到该 turn 的完整结束，保证：
    - 不把 assistant 的 `toolCall` 与后续 `toolResult` 拆开；
    - 头部的最后一条尽量是完整 assistant 响应或下一个 user 消息开始前。
  - 头部至少包含 1 条完整 user 消息；若任务描述本身超长（> 预算），N_head 取能完整放下的最大整数并给出告警提示。
- 这些消息**逐字保留**，只作为“哪些内容被保留”的边界标记；实现上不复制文本，而是记录其条目 id 区间（`headEntryIds` / 起始锚点 id），见 §4。

### 3.3 步骤 2：记忆检索与注入

**候选记忆源**（按优先级，可配置）：

1. 当前会话树中所有历史 `compaction.summary` 与 `branch_summary.summary`（压缩历史即记忆）；
2. 同项目目录下其它会话文件 `~/.pi/agent/sessions/--<cwd>--/*.jsonl` 中的：
   - `compaction.summary` / `branch_summary.summary`（优先）
   - user 首条消息（任务句）
3. `AGENTS.md` / `CLAUDE.md`（按加载顺序拼接，作为上下文记忆候选）；
4. （可选）跨项目会话。

**查询**：开头 N 条消息中 user 文本（去掉 system/工具噪音）拼接为查询文本 `q`。

**打分（轻量词法 BM25 变体）**：对每条候选记忆 `d`：

- 分词：中英文混合 → 中文按 2-gram 切分，英文/标识符按 token 切分；
- 相似度 = 命中项加权的 BM25(无嵌入)；再做**时间衰减**（越新的会话权重越高，衰减系数可配）；
- 取 Top-N（`N_mem`，默认 5），若候选不足则有多少取多少；为 0 时省略记忆段。

**注入形式**：记忆以一条（或 N 条）`user` 角色封装的消息放入布局的记忆区，外包 `<memory>` 标签，避免被当作新的用户指令执行：

```
<memory>
[1] (来源: 2026-xx-xx 会话/AGENTS.md) 记忆内容……
[2] ...
</memory>
```

### 3.4 步骤 3：system prompt 固定

- 不做任何处理即为“固定”：pi 的 system prompt 由系统提示组装器生成，不来自会话条目；本机制不调用任何覆盖 `_systemPromptOverride` 的接口。

### 3.5 步骤 4：其余内容摘要

- 被摘要范围 = 头部之后、直到“当前叶子”的全部条目消息（不含已省略的元数据条目）。
- 摘要 prompt 目标格式（对齐 pi 原生结构化摘要，便于跨压缩迭代）：
  - 明确告知模型：**开头 N 条消息与记忆已保留，不得重复概括它们**；只概括其后内容；
  - 结构化 section：`## Goal（若头部缺失时的兜底）` / `## Constraints & Preferences（同兜底）` / `## Progress (Done/In Progress/Blocked)` / `## Key Decisions` / `## Next Steps` / `## Critical Context`；
  - 保留精确文件路径、函数名、错误消息；复用 pi 的文件操作提取逻辑把 `readFiles/modifiedFiles` 作为硬数据附加（`<read-files>` / `<modified-files>`），不依赖 LLM 记忆。
- 复用 pi 序列化工具 `serializeConversation(convertToLlm(...))` 生成摘要输入（防模型“继续对话”）。

### 3.6 输出（布局组装）

```
[0] system prompt（外部固定）
[1..N_head]  开头消息（逐字，来自会话条目）
[N_head+1]   <memory>…Top-N_mem 记忆…</memory>      （如无记忆则省略）
[N_head+2]   摘要消息（<summary>…结构化摘要…</summary>）
之后:        新追加的 user/assistant/tool 消息（继续正常追加）
```

---

## 4. 实现路线（两条，推荐 A）

### 路线 A：纯扩展 + `context` 事件重写（不改 pi 核心，推荐）

思路：**关闭 pi 原生自动压缩（`compaction.enabled=false`）**，由扩展全权接管“上下文管理”，
把目标布局作为每次请求前对消息列表的确定性重写；检查点在会话中落一条
`CustomEntry{ customType:"pi-compact-v2" }` 记录锚点（头部 id 区间、记忆候选、摘要文本、时间戳），
后续重写基于该检查点增量执行，不重复摘要。

流程：

1. 注册扩展命令 `/memory-compact [N]`（可选参数覆盖 N_head）；
2. 自动触发：在 `turn_end` 检查 `ctx.getContextUsage()`，当 `tokens > contextWindow - reserveTokens`
   时自动执行一次“检查点生成 + 上下文重写”（类似 trigger-compact 示例的节流：单次压力只生成一次检查点）；
3. 检查点生成（仅在需要时调用一次 LLM）：
   - 用 `sessionManager` 只读接口取条目；
   - §3.2 选头部（记 `headStartId`/`headEndId`）、§3.3 检索记忆（纯本地）、§3.5 生成摘要；
   - 把 `{headStartId, headEndId, memories[], summary, tokensBefore, timestamp}` 存入一条 `CustomEntry`
     （扩展可通过自定义命令上下文追加；不可行时退化为进程内单例，随 session_start 重建）；
4. 每次请求前 `context` 事件重写：
   - 计算目标消息序列 = 头部消息（按锚点从消息列表头截取，需把 entry 边界映射到消息下标）+
     memory 块 + 摘要消息 + 检查点之后的全部新消息；
   - 返回该序列作为 `emitContext` 结果；
5. 好处：
   - 不改任何 `node_modules`，pi 升级后仍可用；
   - 会话文件零删除（pi 哲学：完整历史保留，`/tree` 可回溯）；
   - 布局顺序完全可控（系统提示外部固定、头部在前、摘要在后）。
6. 代价：
   - 每请求多一步纯本地重写（廉价，无 LLM 调用）；
   - 需精细维护“锚点 → 消息下标”的映射，处理好历史中已存在的 pi 原生 compaction 条目（兼容读）；
   - 原生自动压缩被禁用后，溢出恢复（overflow retry）路径需要本扩展在 `session_compact_failed`
     等事件上做兜底处理。

### 路线 B：补丁 pi 核心（保头语义进入 `buildContextEntries`）

- 修改 `dist/core/session-manager.js` 的 `buildContextEntries()`：支持“**保留前缀 + 中段摘要 + 尾部继续**”的
  新压缩条目语义（例如 `CompactionEntry` 增加 `keepHeadFromId` / `headCount` 字段），并让
  `compaction.js` 的 `prepareCompaction()` 支持从头部取边界、从尾部找被摘要区间的逆序模式；
- 代价：直接改全局安装包内的编译产物，pi 升级/重装即失效，需要 patch 脚本维护；与官方行为分叉。

> **结论：推荐路线 A**。它把“compact 机制”实现为一个自包含的 pi 扩展（TypeScript），
> 与 pi 的扩展哲学一致（“用扩展接管压缩”是官方文档明示的用法：`session_before_compact` /
> `context` 事件），可测试、可维护、可随版本升级。

---

## 5. 配置与参数（默认值）

在 `~/.pi/agent/settings.json` 或 `.pi/settings.json` 中注册扩展并配置：

```json
{
  "extensions": ["/Users/raphaelwu/AI/pi-agent-compact/dist/extension.js"],
  "compaction": { "enabled": false },
  "memoryCompact": {
    "enabled": true,
    "headMessages": 5,
    "memoryItems": 5,
    "triggerRatio": 0.75,
    "memoriesFrom": ["session-tree", "project-sessions", "agents-md"],
    "crossProject": false,
    "timeDecay": 0.9,
    "summaryMaxTokens": 8192
  }
}
```

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | true | 是否接管压缩（关闭原生自动压缩） |
| `headMessages` | 5 | 开头逐字保留的消息数 N（≥1，自动扩到完整 turn） |
| `memoryItems` | 5 | 注入记忆条数 N_mem |
| `triggerRatio` | 0.75 | 上下文占用达窗口 75% 触发一次检查点 |
| `memoriesFrom` | 见上 | 记忆源组合 |
| `crossProject` | false | 是否检索其它项目会话 |
| `timeDecay` | 0.9 | 词法得分的时间衰减系数 |
| `summaryMaxTokens` | 8192 | 摘要生成输出上限 |

触发入口：`/memory-compact`（手动）+ 自动阈值（turn_end 检查，节流：单次压力一轮只压缩一次）。

---

## 6. 边界情况

| 场景 | 处理 |
| --- | --- |
| tool call/result 配对 | 头部边界不切断配对；被摘要区的 tool 消息整体成对进入序列化 |
| 头部本身就是巨长 turn | N_head 取可完整容纳的最大值并提示 |
| 无相关记忆 | 省略 memory 段，不注入空块 |
| 摘要为空 / LLM 出错 | 保留上一检查点摘要或回退到仅截断头部之后的消息，绝不中断用户请求 |
| 多次压缩迭代 | 下一轮从上一检查点之后继续增量摘要（头部锚点不变，避免“头越压越长”） |
| 溢出恢复重试 | 检查点成功生成后重试原请求；中止信号期间不重试（与 pi 原生语义一致） |
| 历史已有 pi 原生 compaction 条目 | 作为记忆候选读取；重写时跳过其原文（不重复注入旧摘要消息） |
| 会话恢复/重载 | 从 `CustomEntry`/进程内单例恢复锚点状态 |

---

## 7. 测试计划

1. **纯函数单测**（不依赖 pi 运行时 / LLM）：
   - 头部选取：turn 完整性、tool 配对、N 不足、超长头部；
   - 记忆检索：中文 2-gram 打分、Top-N、时间衰减、空结果；
   - 布局组装：消息序列顺序、标签包裹、system prompt 不参与；
   - 序列化：`serializeConversation` 输入构造、文件列表硬数据提取。
2. **集成测试（可选，需 API key）**：在真实 pi 会话里执行 `/memory-compact`，
   断言模型请求前的 context 事件消息序列 = system + 头部 + memory + summary。
3. **回归**：确认不触发原生压缩、会话文件无删除、`/tree` 历史完整。

---

## 8. 已确认的决策与实现状态

| 问题 | 决策 | 状态 |
| --- | --- | --- |
| 实现路线 | **路线 A：纯扩展**（`context` 事件逐请求重写 + 会话只读、零改动） | ✅ 已实现 |
| 默认参数 | headMessages=5 / memoryItems=5 / triggerRatio=0.75 | ✅ 可配置 |
| 交付形态 | 本地扩展 + 纯函数单测 + README 接入说明 | ✅ 已交付 |
| 记忆源 | 会话树/同项目历史会话 + AGENTS.md（`useSiblingSessions`/`useAgentsMd` 可关） | ✅ 已实现 |

### 实际机制（与本文第 4 节路线 A 对齐）

- 扩展注册 `/memory-compact [N]` / `/memory-compact reset`；`context` 事件在每次模型请求前
  把消息列表重写为 `头部（逐字） + 记忆块 + 摘要块 + 自上次折叠点之后的最新消息`；
- 首次折叠：头部之后**完整回合**→ 摘要（自动触发需压力 `> triggerRatio×contextWindow`
  且新增 ≥2048 tokens；手动命令忽略压力，按 `fold-all` 折叠全部，仅保留尚未回答的用户提问）；
- 增量折叠：后续新回合在尾部逐字累积，跨过阈值后合并进既有摘要（previousSummary 增量更新）；
- 折叠边界永不切断 assistant toolCall 与 toolResult 的配对；未结束回合整体保留在尾部；
- system prompt 不在消息列表内，天然固定；
- 会话 JSONL 零写入、零删除；记忆候选 = AGENTS.md 族 + 同项目会话文件的
  compaction/branch_summary/首条用户消息，BM25（CJK 2-gram + 拉丁词）+ 时间衰减打分。

### 优化迭代（A→B 逐模块，每模块全测后提交）

| 项 | 改动 | 状态 |
| --- | --- | --- |
| A1 | 记忆源补齐「当前会话树」compaction/branch 摘要（`parseSessionTreeCandidates` + `getBranch` 接入） | ✅ |
| A2 | checkpoint 持久化：custom session entry 存/取，reset 写失效标记，`session_start` 恢复 | ✅ |
| A3 | 摘要折叠锁由全局布尔改为 per-session `Set` | ✅ |
| A4 | `/memory-compact` 失败保留 armed 标志并限次重试；修复状态写回丢失 pendingManual | ✅ |
| B5 | AGENTS.md 祖先遍历在 home 截止（`computeContextRoots` 纯函数） | ✅ |
| B6 | 记忆源文件读取按 mtime+size 缓存；mtime 年龄缓存 | ✅ |
| B7 | 摘要输入工具结果截断（`maxToolResultChars`，默认 2000，对齐 pi） | ✅ |
| B8 | usage-aware 上下文估算（`estimateContextTokens`：最近 assistant usage + 尾部估算） | ✅ |
| B9 | settings/agentDir 按会话缓存，`/memory-compact N` 覆盖不再跨会话泄漏 | ✅ |

### 实现文件状态

- `src/plan.ts` `src/compact.ts` `src/memory.ts` `src/sources.ts` `src/serialize.ts`
  `src/prompts.ts` `src/settings.ts` `src/retrieve-query.ts` `src/types.ts`：纯函数，无 pi 依赖 ✅
- `src/extension.ts`：pi 扩展适配层（事件/命令/文件 I/O/模型调用）✅
- `test/*.test.ts`：32 个用例，`node --test "test/*.test.ts"` 全绿 ✅
- `tsconfig.json` + `typescript`：`tsc -p tsconfig.json --noUnusedLocals --noUnusedParameters` 通过 ✅


