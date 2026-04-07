# 记忆系统接入使用指南

> 基于 OpenClaw 设计，指导如何在项目中接入 LLM 记忆系统
> 工具库：`mem9`
> 适用于任何 TypeScript 项目

---

## 一、快速接入清单

### 最小可用方案（MVP）

```
1. npm install mem9
2. 选择 Embedding Provider（推荐 OpenAI）
3. 配置 MemorySearch（resolveMemorySearchConfig）
4. 接入自适应压缩（summarizeInStages）
5. 启用质量保障（auditSummaryQuality）
```

### 渐进增强路线

```
Phase 1: 基础记忆（1-2 周）
  ├─ SessionManager 会话管理
  ├─ estimateTokens token 计数
  └─ shouldRunMemoryFlush 内存刷新触发

Phase 2: 语义记忆（2-3 周）
  ├─ createEmbeddingProvider 集成
  ├─ resolveMemorySearchConfig 配置检索
  └─ summarizeInStages 自适应压缩

Phase 3: 智能进化（3-4 周）
  ├─ auditSummaryQuality 压缩质量保障
  ├─ mergeHybridResults 混合检索
  ├─ computeTemporalDecay 时间衰减
  └─ cosineSimilarity 向量相似度

Phase 4: 企业级（4+ 周）
  ├─ 多租户隔离
  ├─ 审计日志（记忆操作追溯）
  ├─ 分布式存储（PostgreSQL + pgvector）
  └─ 监控告警（记忆命中率、延迟、容量）
```

---

## 二、核心接口

所有类型均已定义在 `types.ts` 中，可直接 import：

```typescript
import type {
  // 消息类型
  ConversationMessage,
  BaseMessage,
  ToolResultMessage,
  ContentBlock,

  // 记忆存储
  MemoryEntry,
  MemoryQuery,
  MemorySearchResult,

  // 压缩
  CompactionParams,
  CompactionResult,
  QualityReport,

  // 会话
  Session,

  // Embedding
  EmbeddingProvider,
  EmbeddingProviderOptions,
} from "mem9";
```

### 2.1 记忆存储接口

```typescript
// types.ts 中的定义
interface MemoryEntry {
  content: string;
  metadata?: {
    source?: string;       // conversation | file | tool
    timestamp?: number;
    tags?: string[];
    importance?: number;   // 0-1
  };
  embedding?: number[];    // 可选，未提供则自动生成
}

interface MemoryQuery {
  text: string;
  topK?: number;           // 默认 5
  minSimilarity?: number;  // 默认 0.35
  strategy?: "vector" | "fulltext" | "hybrid";
  timeDecay?: boolean;
  filter?: {
    source?: string;
    tags?: string[];
    since?: number;
  };
}
```

### 2.2 压缩器接口

```typescript
// 使用工具库进行压缩
import {
  summarizeInStages,
  computeAdaptiveChunkRatio,
  pruneHistoryForContextShare,
} from "mem9";

// 你需要提供 summarize 函数（调用你的 LLM）
const summarize = async (messages, options) => {
  return await yourLlm.summarize(messages, options);
};

const summary = await summarizeInStages({
  messages: conversationHistory,
  summarize,
  contextWindow: 200000,
  reserveTokens: 4096,
});
```

### 2.3 会话管理接口

```typescript
import { SessionManager } from "mem9";

const sessions = new SessionManager({
  maxConcurrent: 5000,   // 最大会话数
  idleTtlMs: 86400000,   // 24h 空闲超时
});

// 获取或创建会话
const session = sessions.getOrCreate("user-123");

// 添加消息
sessions.addMessage("user-123", {
  role: "user",
  content: "帮我分析一下这只股票",
});

// 定期清理空闲会话
sessions.evictIdle();
```

---

## 三、接入步骤

### Step 1：安装和基础配置

```typescript
import {
  SessionManager,
  estimateTokens,
  shouldRunMemoryFlush,
  DEFAULT_CONTEXT_TOKENS,
} from "mem9";

const sessions = new SessionManager();
```

### Step 2：添加 Embedding 层

```typescript
import {
  createOpenAIEmbeddingProvider,
  createOllamaEmbeddingProvider,
  createEmbeddingProvider,
  cosineSimilarity,
} from "mem9";

// 方案A：直接使用 OpenAI
const openai = await createOpenAIEmbeddingProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "text-embedding-3-small",
});

// 方案B：使用 Ollama（私有化）
const ollama = await createOllamaEmbeddingProvider({
  baseUrl: "http://localhost:11434",
  model: "nomic-embed-text",
});

// 方案C：自动选择（推荐）
const result = await createEmbeddingProvider({
  provider: "auto",
  model: "",
  apiKey: process.env.OPENAI_API_KEY,
});
const embedder = result.provider;
// result.provider === null → 降级到纯全文搜索模式
```

### Step 3：配置混合检索

```typescript
import {
  resolveMemorySearchConfig,
  mergeHybridResults,
} from "mem9";

const searchConfig = resolveMemorySearchConfig(
  {
    enabled: true,
    chunking: { tokens: 400, overlap: 80 },
    query: {
      maxResults: 6,
      minScore: 0.35,
      hybrid: {
        enabled: true,
        vectorWeight: 0.7,
        textWeight: 0.3,
        mmr: { enabled: true, lambda: 0.7 },
        temporalDecay: { enabled: true, halfLifeDays: 30 },
      },
    },
  },
  "./data/memory.sqlite",
);
```

### Step 4：接入自适应压缩

```typescript
import {
  summarizeInStages,
  auditSummaryQuality,
  buildCompactionStructureInstructions,
  extractOpaqueIdentifiers,
  extractLatestUserAsk,
  buildStructuredFallbackSummary,
  capCompactionSummary,
} from "mem9";

// 你的 LLM 调用函数
const summarize = async (messages, options) => {
  const instructions = buildCompactionStructureInstructions(
    "你是一个金融 AI 助手的记忆压缩器"
  );
  return await yourLlm.chat({
    system: instructions,
    messages,
    maxTokens: options.reserveTokens,
  });
};

// 在对话轮次中检查是否需要压缩
async function maybeCompact(sessionKey: string) {
  const session = sessions.get(sessionKey);
  if (!session) return;

  const usedTokens = session.tokenCount;
  const shouldFlush = shouldRunMemoryFlush({
    usedTokens,
    contextWindowTokens: 200000,
    softThresholdTokens: 140000,
    hardThresholdTokens: 180000,
    reserveTokensFloor: 50000,
  });

  if (!shouldFlush.shouldFlush) return;

  const summary = await summarizeInStages({
    messages: session.messages,
    summarize,
    contextWindow: 200000,
    reserveTokens: 4096,
  });

  // 质量检查
  const quality = auditSummaryQuality({
    summary,
    identifiers: extractOpaqueIdentifiers(
      session.messages.map((m) => typeof m.content === "string" ? m.content : "").join("\n")
    ),
    latestAsk: extractLatestUserAsk(session.messages),
  });

  if (quality.ok) {
    // 截断到 16000 字符安全限制
    const finalSummary = capCompactionSummary(summary);
    sessions.replaceMessages(sessionKey, [
      { role: "system", content: finalSummary, timestamp: Date.now() },
    ]);
  }
}
```

### Step 5：注入 LLM Prompt

```typescript
import {
  cosineSimilarity,
  computeTemporalDecay,
} from "mem9";

export async function buildPrompt(context: {
  userMessage: string;
  sessionKey: string;
  embedder: EmbeddingProvider;
}) {
  const session = sessions.get(context.sessionKey);
  if (!session) {
    return { system: "你是金融 AI 助手。", user: context.userMessage };
  }

  // 检索相关记忆（伪代码，需自己实现存储层）
  const queryEmbedding = await context.embedder.embedQuery(context.userMessage);
  // ... 向量搜索 + 全文搜索 → vectorResults, textResults

  // 注入系统提示
  const systemPrompt = `你是金融 AI 助手。

## 相关历史记忆
${memories.map((m) => `- ${m.content}`).join("\n")}

## 当前对话上下文
${session.messages.slice(-12).map((m) =>
  typeof m.content === "string" ? m.content : "[非文本内容]"
).join("\n")}
`;

  return { system: systemPrompt, user: context.userMessage };
}
```

---

## 四、性能优化建议

### 4.1 Embedding 批量处理

```typescript
// 使用 embedBatch 而不是逐条 embed
const texts = entries.map((e) => e.content);
const embeddings = await embedder.embedBatch(texts);
```

### 4.2 缓存策略

```typescript
import { computeContextHash } from "mem9";

// 用上下文指纹做缓存失效
const hash = computeContextHash(session.messages);
if (hash !== lastHash) {
  // 刷新搜索缓存
  lastHash = hash;
}
```

### 4.3 会话管理优化

```typescript
// 定期清理（如每 5 分钟）
setInterval(() => {
  const evicted = sessions.evictIdle();
  if (evicted > 0) console.log(`Evicted ${evicted} idle sessions`);
}, 5 * 60 * 1000);
```

---

## 五、监控指标

接入后应监控以下指标：

| 指标 | 含义 | 告警阈值 | 相关工具库函数 |
|------|------|---------|---------------|
| 记忆命中率 | 检索结果被 LLM 引用的比例 | < 30% | `mergeHybridResults` |
| 检索延迟 P95 | 搜索请求耗时 | > 500ms | `resolveMemorySearchConfig` |
| 压缩触发率 | 压缩被触发的对话比例 | > 80% | `shouldRunMemoryFlush` |
| 压缩质量分 | 摘要质量评分 | < 0.7 | `auditSummaryQuality` |
| 存储容量 | 总 embedding 数量/大小 | > 80% 配额 | — |
| 会话驱逐率 | 会话被驱逐的比例 | > 50% | `SessionManager.evictIdle` |
| Embedding 缓存命中 | 缓存命中率 | < 60% | `cosineSimilarity` |
| 上下文窗口利用率 | 已用 / 总窗口 | > 90% | `estimateTokens` |
