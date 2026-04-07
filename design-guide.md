# 记忆系统设计参考指南

> 基于 OpenClaw 项目提炼的可复用设计模式
> 已在 `mem9` 中实现
> 适用于任何需要 LLM 记忆管理的项目

---

## 一、设计原则

### 1.1 分层记忆原则

借鉴人脑记忆模型，将 AI 记忆分为四层，每层有不同的容量、速度和持久性：

```
┌────────────────────────────────────┐
│  工作记忆 (Working Memory)          │  ← 最快，最小，易丢失
│  容量：上下文窗口 (200K tokens)      │
│  生命周期：单次对话                  │
│  实现：LLM prompt 中的消息历史       │
│  工具库：session-manager.ts         │
├────────────────────────────────────┤
│  情节记忆 (Episodic Memory)         │
│  容量：中等                         │
│  生命周期：按时间衰减               │
│  实现：对话历史持久化 + 时间戳       │
│  工具库：memory-search-config.ts    │
├────────────────────────────────────┤
│  语义记忆 (Semantic Memory)         │
│  容量：大                           │
│  生命周期：长期                     │
│  实现：向量数据库 + embedding       │
│  工具库：embedding-provider.ts      │
├────────────────────────────────────┤
│  程序记忆 (Procedural Memory)       │  ← 最慢，最大，最持久
│  容量：无限                         │
│  生命周期：永久                     │
│  实现：工具定义 + 系统提示 + 配置   │
│  工具库：bootstrap-budget.ts        │
└────────────────────────────────────┘
```

### 1.2 压缩优于截断原则

```
❌ 错误做法：对话太长 → 直接截断旧消息
   → 丢失关键决策和上下文
   → 用户重复提问同样问题

✅ 正确做法：对话太长 → LLM 智能总结旧消息
   → 保留关键决策、约束、待办
   → 用户感觉 AI 记得之前说过的话
```

工具库实现：`compaction.ts` → `summarizeInStages()`

### 1.3 质量保障原则

压缩不是无脑压缩，必须有质量检查：
- 摘要必须包含结构化字段（决策/TODO/约束/标识符）
- 质量不通过自动重试（最多 3 次）
- 保留最近 N 轮原样对话作为"安全缓冲区"

工具库实现：`quality-safeguard.ts` → `auditSummaryQuality()`

### 1.4 渐进式原则

```
记忆管理应该是渐进式的，不是一刀切：

窗口 0-30%  → 不做任何处理
窗口 30-70% → 温和压缩（保留 40%）
窗口 70-90% → 自适应压缩（根据消息大小调整）
窗口 > 90%  → 激进压缩（最低保留 15%）
```

工具库实现：`compaction.ts` → `computeAdaptiveChunkRatio()`

---

## 二、核心组件设计

### 2.1 自适应压缩器

工具库模块：`compaction.ts`

```typescript
import {
  computeAdaptiveChunkRatio,
  summarizeInStages,
  pruneHistoryForContextShare,
  BASE_CHUNK_RATIO,       // 0.4
  MIN_CHUNK_RATIO,        // 0.15
  SAFETY_MARGIN,          // 1.2
  SUMMARIZATION_OVERHEAD_TOKENS, // 4096
} from "mem9";
```

**压缩算法**（已实现）：

```
computeAdaptiveChunkRatio(messages, contextWindow):
  avgTokens = estimateTokens(messages) / messages.length
  avgRatio = (avgTokens × SAFETY_MARGIN) / contextWindow

  if avgRatio > 0.1:
      reduction = min(avgRatio * 2, 25%)
      return max(15%, 40% - reduction)
  else:
      return 40%

summarizeInStages(messages, summarize, ...):
  1. 计算自适应压缩比
  2. 按 token 均分消息为 N 个分块
  3. 对每个分块调用 summarize()
  4. 合并所有部分摘要为一个完整摘要
  5. 支持渐进降级：大消息跳过，全部失败则返回提示
```

### 2.2 质量保障器

工具库模块：`quality-safeguard.ts`

```typescript
import {
  auditSummaryQuality,
  extractOpaqueIdentifiers,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  REQUIRED_SUMMARY_SECTIONS,
  MAX_EXTRACTED_IDENTIFIERS, // 12
} from "mem9";
```

**质量检查项**（已实现）：

```typescript
const result = auditSummaryQuality({
  summary,
  identifiers: extractOpaqueIdentifiers(originalText),
  latestAsk: extractLatestUserAsk(messages),
  identifierPolicy: "strict",  // | "off" | "custom"
});
// result.ok === true/false
// result.reasons: ["missing_section:## Decisions", "missing_identifiers:abc123"]
```

**必须包含的5个段落**：

```typescript
REQUIRED_SUMMARY_SECTIONS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
]
```

### 2.3 混合检索器

工具库模块：`memory-search-config.ts`

```typescript
import {
  resolveMemorySearchConfig,
  mergeHybridResults,
  computeMmrScore,
  computeTemporalDecay,
} from "mem9";
```

**混合检索流程**（已实现）：

```typescript
// 1. 解析配置（带生产验证的默认值）
const config = resolveMemorySearchConfig(userConfig, "./memory.sqlite");

// 2. 合并向量搜索和全文搜索结果
const results = mergeHybridResults({
  vectorResults,         // 语义相似度结果
  textResults,           // 关键词匹配结果
  vectorWeight: 0.7,     // 向量权重 70%
  textWeight: 0.3,       // 全文权重 30%
  maxResults: 6,         // 最终返回 6 条
  mmrEnabled: false,     // MMR 去重（可选）
  mmrLambda: 0.7,        // 多样性参数
  temporalDecayEnabled: false,  // 时间衰减（可选）
  temporalDecayHalfLifeDays: 30, // 半衰期 30 天
});
```

### 2.4 会话管理器

工具库模块：`session-manager.ts`

```typescript
import { SessionManager } from "mem9";

const sessions = new SessionManager({
  maxConcurrent: 5000,   // 最大并发会话
  idleTtlMs: 86400000,   // 24 小时空闲超时
});

// 使用
const session = sessions.getOrCreate("user-123");
sessions.addMessage("user-123", { role: "user", content: "你好" });
sessions.evictIdle(); // 清理过期会话
```

---

## 三、Embedding 选择指南

工具库模块：`embedding-provider.ts`

```typescript
import {
  createOpenAIEmbeddingProvider,
  createOllamaEmbeddingProvider,
  createGenericEmbeddingProvider,
  createEmbeddingProvider,  // 自动选择
  cosineSimilarity,
  normalizeVector,
} from "mem9";
```

| 场景 | 推荐方案 | 工具库函数 |
|------|---------|-----------|
| 云端通用 | OpenAI text-embedding-3-small | `createOpenAIEmbeddingProvider()` |
| 高精度需求 | OpenAI text-embedding-3-large | `createOpenAIEmbeddingProvider({ model: "text-embedding-3-large" })` |
| 私有化部署 | Ollama + nomic-embed-text | `createOllamaEmbeddingProvider()` |
| 兼容 API | 任何 OpenAI 兼容接口 | `createGenericEmbeddingProvider()` |
| 自动选择 | 按优先级尝试 | `createEmbeddingProvider({ provider: "auto" })` |

### 分块建议

```
memory-search-config.ts 中的默认值：

  tokens: 400           // 每块 400 tokens
  overlap: 80           // 块间重叠 80 tokens
  （可在 resolveMemorySearchConfig() 中自定义）
```

---

## 四、存储选型指南

| 方案 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| SQLite + 向量扩展 | 单机/轻量 | 零部署，嵌入式 | 不支持分布式 |
| PostgreSQL + pgvector | 企业级 | 成熟生态，ACID | 需要运维 |
| Redis + RedisSearch | 高并发 | 超低延迟 | 内存成本高 |
| Milvus / Qdrant | 大规模 | 专业向量搜索 | 部署复杂 |
| ChromaDB | 快速原型 | 开箱即用 | 生产可靠性待验证 |

**OpenClaw 的选择**：SQLite（嵌入式），适合单机部署和开发者友好。

---

## 五、关键阈值参考值

所有阈值均已在工具库中定义为导出常量：

```typescript
// 从工具库导入实际常量
import {
  // 上下文窗口 — context-window-guard.ts
  DEFAULT_CONTEXT_TOKENS,           // 200000
  CONTEXT_WINDOW_HARD_MIN_TOKENS,   // 16000
  CONTEXT_WINDOW_WARN_BELOW_TOKENS, // 32000

  // 压缩策略 — compaction.ts
  BASE_CHUNK_RATIO,                 // 0.4  (40%)
  MIN_CHUNK_RATIO,                  // 0.15 (15%)
  SAFETY_MARGIN,                    // 1.2  (20%)
  SUMMARIZATION_OVERHEAD_TOKENS,    // 4096

  // 质量保障 — quality-safeguard.ts
  MAX_EXTRACTED_IDENTIFIERS,        // 12
  REQUIRED_SUMMARY_SECTIONS,        // 5 个必须段落

  // 启动文件 — bootstrap-budget.ts
  DEFAULT_BOOTSTRAP_MAX_FILE_CHARS, // 20000
  DEFAULT_BOOTSTRAP_MAX_TOTAL_CHARS,// 150000
  DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO,// 0.85
} from "mem9";
```

### YAML 格式参考

```yaml
# 上下文窗口
context_window:
  default: 200000      # DEFAULT_CONTEXT_TOKENS
  hard_min: 16000      # CONTEXT_WINDOW_HARD_MIN_TOKENS
  warn_below: 32000    # CONTEXT_WINDOW_WARN_BELOW_TOKENS

# 压缩策略
compaction:
  base_ratio: 0.40     # BASE_CHUNK_RATIO
  min_ratio: 0.15      # MIN_CHUNK_RATIO
  safety_margin: 1.2   # SAFETY_MARGIN
  summary_reserve: 4096 # SUMMARIZATION_OVERHEAD_TOKENS
  summary_max_chars: 16000
  preserve_recent_turns: 12
  max_chars_per_turn: 600

# 质量保障
safeguard:
  max_identifiers: 12  # MAX_EXTRACTED_IDENTIFIERS
  required_fields:      # REQUIRED_SUMMARY_SECTIONS
    - "## Decisions"
    - "## Open TODOs"
    - "## Constraints/Rules"
    - "## Pending user asks"
    - "## Exact identifiers"

# 会话管理
session:
  idle_ttl: 86400000   # 24h (SessionManager 默认)
  max_concurrent: 5000
  eviction_strategy: LRU

# 启动文件
bootstrap:
  max_file_chars: 20000   # DEFAULT_BOOTSTRAP_MAX_FILE_CHARS
  max_total_chars: 150000 # DEFAULT_BOOTSTRAP_MAX_TOTAL_CHARS
  warn_ratio: 0.85        # DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO

# Token 估算
estimation:
  chars_per_token: 4    # token-estimator.ts
  image_char_estimate: 8000
```
