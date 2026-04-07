# 记忆大小控制机制详解

> 来源：OpenClaw 项目源码分析，2026-04
> 已在 `mem9` 中实现
> 本文档描述工具库中的控制机制

---

## 一、控制框架总览

```
                    记忆大小控制层次（4 层）

  ┌──────────────────────────────────────────┐
  │  第1层：上下文窗口硬限制                    │
  │  maxTokens = 200,000                      │
  │  硬底线 = 16,000                          │
  │  实现：context-window-guard.ts             │
  │  ↓ 超过阈值触发压缩                        │
  ├──────────────────────────────────────────┤
  │  第2层：自适应压缩（Compaction）            │
  │  动态压缩比：15% ~ 40%                     │
  │  分阶段总结旧对话 → 摘要替换原文            │
  │  实现：compaction.ts                       │
  │  ↓ 保证摘要质量                            │
  ├──────────────────────────────────────────┤
  │  第3层：质量保障（Safeguard）               │
  │  必须保留：决策/TODO/约束/标识符            │
  │  最大重试 3 次保证摘要质量                  │
  │  实现：quality-safeguard.ts                │
  │  ↓ 丢弃冗余，保留精华                      │
  ├──────────────────────────────────────────┤
  │  第4层：会话驱逐（Eviction）                │
  │  空闲 TTL = 24小时                         │
  │  最大会话数 = 5,000                        │
  │  LRU 策略淘汰                              │
  │  实现：session-manager.ts                  │
  └──────────────────────────────────────────┘
```

---

## 二、关键阈值一览

所有阈值均为工具库中的导出常量：

```typescript
import {
  // 上下文窗口
  DEFAULT_CONTEXT_TOKENS,           // 200,000
  CONTEXT_WINDOW_HARD_MIN_TOKENS,   // 16,000
  CONTEXT_WINDOW_WARN_BELOW_TOKENS, // 32,000

  // 压缩
  BASE_CHUNK_RATIO,                 // 0.4  (40%)
  MIN_CHUNK_RATIO,                  // 0.15 (15%)
  SAFETY_MARGIN,                    // 1.2  (20%)
  SUMMARIZATION_OVERHEAD_TOKENS,    // 4,096

  // 质量保障
  MAX_EXTRACTED_IDENTIFIERS,        // 12
  REQUIRED_SUMMARY_SECTIONS,        // 5 个必须段落

  // 启动文件
  DEFAULT_BOOTSTRAP_MAX_FILE_CHARS, // 20,000
  DEFAULT_BOOTSTRAP_MAX_TOTAL_CHARS,// 150,000
  DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO,// 0.85
} from "mem9";
```

### 阈值对照表

| 控制项 | 阈值 | 工具库常量 | 说明 |
|--------|------|-----------|------|
| 默认上下文窗口 | 200,000 tokens | `DEFAULT_CONTEXT_TOKENS` | 单次对话最大 token 预算 |
| 硬底线 | 16,000 tokens | `CONTEXT_WINDOW_HARD_MIN_TOKENS` | 低于此值拒绝压缩 |
| 警告阈值 | 32,000 tokens | `CONTEXT_WINDOW_WARN_BELOW_TOKENS` | 发出告警 |
| 基础压缩比 | 40% | `BASE_CHUNK_RATIO` | 对话历史压缩到窗口的 40% |
| 最小压缩比 | 15% | `MIN_CHUNK_RATIO` | 极端情况最低压缩到 15% |
| 安全边距 | 1.2x (20%) | `SAFETY_MARGIN` | 补偿 token 估算误差 |
| 摘要预留 | 4,096 tokens | `SUMMARIZATION_OVERHEAD_TOKENS` | 为摘要生成预留 |
| 标识符上限 | 12 个 | `MAX_EXTRACTED_IDENTIFIERS` | 提取的标识符最大数量 |
| 会话空闲 TTL | 24 小时 | `SessionManager` 默认 | 空闲会话过期时间 |
| 最大会话数 | 5,000 | `SessionManager` 默认 | 并发会话上限 |
| Bootstrap 单文件 | 20,000 chars | `DEFAULT_BOOTSTRAP_MAX_FILE_CHARS` | 单个启动文件字符上限 |
| Bootstrap 总量 | 150,000 chars | `DEFAULT_BOOTSTRAP_MAX_TOTAL_CHARS` | 所有启动文件总字符上限 |
| Bootstrap 接近限制 | 85% | `DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO` | 触发告警的阈值 |

---

## 三、核心算法详解

### 3.1 自适应压缩 — 对话越长压缩越狠

工具库实现：`compaction.ts` → `computeAdaptiveChunkRatio()`

```
输入：当前对话消息 + 上下文窗口大小
  │
  ▼
计算自适应压缩比：
  avgRatio = (消息平均 token 数 × SAFETY_MARGIN) / 上下文窗口
  │
  ├─ avgRatio > 10% → 消息太大，压缩比降低（压缩更狠）
  │   reduction = min(avgRatio × 2, 25%)
  │   最终比例 = max(15%, 40% - reduction)
  │
  └─ avgRatio ≤ 10% → 消息正常，保持基础压缩比 40%
  │
  ▼
计算每个分块的 token 预算：
  chunkBudget = contextWindow × adaptiveRatio - 4096（摘要预留）
  │
  ▼
summarizeInStages() — 分阶段压缩：
  ├─ 将对话历史按 token 均分为 N 个分块
  ├─ 每个分块独立摘要
  ├─ 合并所有部分摘要
  └─ 支持 summarizeWithFallback() 渐进降级
```

### 3.2 质量保障 — 压缩不能丢关键信息

工具库实现：`quality-safeguard.ts` → `auditSummaryQuality()`

```
LLM 生成摘要后，质量检查：
  │
  ├─ 结构检查（REQUIRED_SUMMARY_SECTIONS）：
  │   ├─ ## Decisions（已做的决策）
  │   ├─ ## Open TODOs（待办事项）
  │   ├─ ## Constraints/Rules（约束规则）
  │   ├─ ## Pending user asks（用户未完成的请求）
  │   └─ ## Exact identifiers（精确标识符，最多 12 个）
  │
  ├─ 标识符保留检查（identifierPolicy === "strict"）：
  │   └─ extractOpaqueIdentifiers() 提取原文标识符
  │   └─ 验证每个标识符是否出现在摘要中
  │
  ├─ 用户意图反射检查（hasAskOverlap）：
  │   └─ extractLatestUserAsk() 获取最后用户消息
  │   └─ 检查摘要是否包含相关关键词
  │
  └─ 返回 QualityAuditResult: { ok, reasons[] }
```

### 3.3 会话驱逐 — LRU + 空闲检测

工具库实现：`session-manager.ts` → `evictIdle()`

```
evictIdle() — 可在任何时机调用
  │
  ├─ 遍历所有活跃会话
  │   └─ 空闲时间 > TTL (默认 24h) → 删除
  │
  └─ 自动在 getOrCreate() 中触发：
      └─ 超过 maxConcurrent (默认 5000) → 驱逐最久未用的
```

### 3.4 内存刷新触发

工具库实现：`memory-flush.ts` → `shouldRunMemoryFlush()`

```
每次对话轮次中检查：
  │
  ├─ usedTokens < reserveTokensFloor → 正常，不动作
  ├─ usedTokens ≥ softThresholdTokens → 触发记忆搜索缓存刷新
  └─ usedTokens ≥ hardThresholdTokens → 触发强制压缩

辅助函数：
  ├─ shouldRunPreflightCompaction() — 预压缩检查（默认 70% 阈值）
  └─ computeContextHash() — 上下文指纹（用于缓存失效）
```

---

## 四、对话阶段与控制策略对应表

| 阶段 | 记忆状态 | 窗口占用 | 控制策略 | 触发的工具库函数 |
|------|---------|---------|---------|----------------|
| 新会话 | 几乎为空 | < 5% | 20 万 token 全量可用 | — |
| 短对话 | 少量历史 | 5-30% | 不压缩，原样保留所有内容 | — |
| 中等对话 | 有历史积累 | 30-70% | 触发首次压缩，旧消息总结为摘要 | `summarizeInStages()` |
| 长对话 | 大量历史 | 70-90% | 自适应提高压缩比，分阶段总结 | `computeAdaptiveChunkRatio()` |
| 超长对话 | 接近极限 | > 90% | 激进压缩（15%），只保留摘要 + 最近 12 轮 | `pruneHistoryForContextShare()` |
| 跨天对话 | 空闲超时 | N/A | 会话驱逐，释放内存 | `sessionManager.evictIdle()` |

---

## 五、核心哲学

> 不是简单截断，而是**渐进式智能压缩**——像人脑一样：
> - 近期记忆清晰（原样保留最近轮次）
> - 远期记忆只保留关键决策和约束（LLM 总结摘要）
> - 过时信息自动淘汰（时间衰减 + 空闲驱逐）
> - 压缩质量有保障（结构化验证 + 标识符保留）

---

## 六、工具库文件索引

| 功能 | 工具库模块 | 核心导出 |
|------|-----------|---------|
| 自适应压缩 | `compaction.ts` | `computeAdaptiveChunkRatio`, `summarizeInStages`, `pruneHistoryForContextShare` |
| 质量保障 | `quality-safeguard.ts` | `auditSummaryQuality`, `extractOpaqueIdentifiers`, `buildStructuredFallbackSummary` |
| 上下文守卫 | `context-window-guard.ts` | `resolveContextWindowInfo`, `evaluateContextWindowGuard` |
| 启动预算 | `bootstrap-budget.ts` | `analyzeBootstrapBudget`, `buildBootstrapWarning` |
| 混合检索 | `memory-search-config.ts` | `resolveMemorySearchConfig`, `mergeHybridResults`, `computeMmrScore` |
| Embedding | `embedding-provider.ts` | `createEmbeddingProvider`, `cosineSimilarity`, `normalizeVector` |
| 内存刷新 | `memory-flush.ts` | `shouldRunMemoryFlush`, `shouldRunPreflightCompaction` |
| 会话管理 | `session-manager.ts` | `SessionManager` class |
| Token 估算 | `token-estimator.ts` | `estimateTokens`, `estimateMessagesTokens` |
