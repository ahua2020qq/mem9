# 记忆系统架构分析

> 来源：OpenClaw 项目源码分析，2026-04
> 提炼为自包含工具库：`mem9`
> 本文档描述工具库中已实现的架构

---

## 一、记忆分层架构

```
用户交互（对话/工具调用/多模态输入）
       │
       ▼
 ┌─────────────────────────────────────┐
 │           记忆分层系统               │
 │                                     │
 │  ① 工作记忆 (Working Memory)        │
 │     └─ 当前对话上下文，上下文窗口    │
 │     └─ 实现：session-manager.ts     │
 │                                     │
 │  ② 情节记忆 (Episodic Memory)       │
 │     └─ 具体事件/经验，按时间组织     │
 │     └─ 时间衰减权重                 │
 │     └─ 实现：memory-search-config.ts │
 │                                     │
 │  ③ 语义记忆 (Semantic Memory)       │
 │     └─ 事实/知识，向量检索           │
 │     └─ embedding + 相似度匹配       │
 │     └─ 实现：embedding-provider.ts  │
 │                                     │
 │  ④ 程序记忆 (Procedural Memory)     │
 │     └─ 技能/操作流程，工具使用记录   │
 │     └─ 实现：bootstrap-budget.ts    │
 └─────────────────────────────────────┘
       │
       ▼
 ┌─────────────────────────────────────┐
 │         检索引擎                     │
 │  ├─ 向量搜索（语义相似度）           │
 │  ├─ 全文搜索（关键词精确匹配）       │
 │  ├─ 混合检索（两者融合 + MMR去重）   │
 │  └─ 时间感知（越新权重越高）         │
 │                                     │
 │  实现：memory-search-config.ts       │
 │  ├─ mergeHybridResults()            │
 │  ├─ computeMmrScore()               │
 │  └─ computeTemporalDecay()          │
 └─────────────────────────────────────┘
```

---

## 二、存储架构

### 多层存储

| 层级 | 技术 | 用途 | 工具库模块 |
|------|------|------|-----------|
| 内存缓存 | Map/LRU | 热点数据快速访问 | session-manager.ts |
| SQLite 持久化 | chunks/files/embedding_cache/fts 表 | 持久存储 + 向量索引 | memory-search-config.ts |
| 文件系统 | bootstrap/system-prompt 文件 | 长期配置和启动文件 | bootstrap-budget.ts |

### SQLite 表结构

```sql
-- 记忆分块表
chunks (id, content, embedding, metadata, created_at)

-- 文件元数据表
files (id, path, hash, last_modified, chunk_count)

-- 向量缓存表
embedding_cache (id, content_hash, embedding, model, created_at)

-- 全文搜索索引
fts (rowid, content)
```

---

## 三、向量化系统（Embedding）

### 支持的 Embedding 提供者

| 提供者 | 模型 | 适用场景 | 工具库函数 |
|--------|------|---------|-----------|
| OpenAI | text-embedding-3-small/large | 通用，质量高 | `createOpenAIEmbeddingProvider()` |
| Gemini | gemini-embedding-001/2-preview | Google 生态 | `createGenericEmbeddingProvider()` |
| Voyage | voyage-4-large | 高精度需求 | `createGenericEmbeddingProvider()` |
| Mistral | mistral-embed | Mistral 生态 | `createGenericEmbeddingProvider()` |
| Ollama | 本地模型 | 私有化部署 | `createOllamaEmbeddingProvider()` |
| 本地 | node-llama-cpp | 离线/低延迟 | 需自行集成 |

### 分块策略

```
原始文档/对话
  │
  ▼
智能分块（memory-search-config.ts 中的配置）
  ├─ 基于 token 数量切割（默认 400 tokens/块）
  ├─ 语义边界优先（不在句子中间断）
  ├─ 重叠策略保持上下文连贯（默认 80 tokens）
  └─ 多模态分类（文本/图像/音频分别处理）
  │
  ▼
Embedding 向量化（embedding-provider.ts）
  ├─ createEmbeddingProvider() — 自动选择 + 降级
  ├─ cosineSimilarity() — 向量相似度计算
  └─ normalizeVector() — 向量归一化
  │
  ▼
存入 SQLite + 全文索引
```

---

## 四、检索引擎

### 混合检索流程

```
用户提问
  │
  ├──→ 向量搜索（语义相关）→ 结果 A
  ├──→ 全文搜索（关键词匹配）→ 结果 B
  │
  ▼
mergeHybridResults() — 融合去重（memory-search-config.ts）
  ├─ cosineSimilarity 计算相似度
  ├─ MMR（最大边际相关性）保证多样性
  │   └─ computeMmrScore(lambda=0.7)
  └─ 时间衰减因子：新记忆权重更高
      └─ computeTemporalDecay(halfLifeDays=30)
  │
  ▼
返回最相关的记忆片段 → 注入 LLM prompt
```

### 检索策略

| 策略 | 原理 | 适用场景 | 配置参数 |
|------|------|---------|---------|
| 纯向量搜索 | 语义相似度 (cosine) | 概念性问题 | hybrid.enabled=false |
| 纯全文搜索 | 关键词精确匹配 | 专有名词、标识符 | hybrid.enabled=false |
| 混合检索 | 向量 + 全文 + MMR 去重 | 通用场景（推荐） | hybrid.enabled=true |
| 时间感知检索 | 时间衰减权重 | 需要最新信息的场景 | temporalDecay.enabled=true |

### 混合检索默认权重

```typescript
// memory-search-config.ts 中的默认值
vectorWeight: 0.7       // 向量搜索权重 70%
textWeight: 0.3         // 全文搜索权重 30%
candidateMultiplier: 4   // 候选集扩展倍数
mmr.lambda: 0.7         // MMR 多样性参数
temporalDecay.halfLifeDays: 30  // 半衰期 30 天
```

---

## 五、自主进化机制

### 进化路径

```
第 1 次对话
  → 工作记忆：记住当前上下文
  → 情节记忆：记录交互过程

第 N 次对话
  → 语义检索：召回相关历史经验
  → 自适应压缩：精炼旧记忆，腾出空间
  → 增量学习：新知识融入已有知识库

第 100+ 次对话
  → 知识网络形成：语义关联越织越密
  → 检索精度提升：向量空间越来越准确
  → 压缩效率提升：LLM 更擅长提取精华
```

### 核心进化机制

| 机制 | 工具库模块 | 进化意义 |
|------|-----------|---------|
| 自适应压缩 | compaction.ts → `summarizeInStages()` | 越对话越知道留什么 |
| 增量同步 | memory-search-config.ts → sync 配置 | 学习成本随时间递减 |
| 混合检索 + MMR | memory-search-config.ts → `mergeHybridResults()` | 检索越用越精准 |
| 时间衰减 | memory-search-config.ts → `computeTemporalDecay()` | 自动淘汰过时信息 |
| 质量保障 | quality-safeguard.ts → `auditSummaryQuality()` | 压缩不丢关键信息 |
| 会话驱逐 | session-manager.ts → `evictIdle()` | 释放不活跃资源 |
| 缓存优化 | memory-flush.ts → `shouldRunMemoryFlush()` | 智能刷新时机 |

---

## 六、工具库文件索引

| 功能 | 工具库模块 | OpenClaw 原始文件 |
|------|-----------|------------------|
| 核心类型定义 | `types.ts` | 多个文件提炼 |
| Token 估算 | `token-estimator.ts` | `src/agents/compaction.ts` |
| 自适应压缩 | `compaction.ts` | `src/agents/compaction.ts` |
| 质量保障 | `quality-safeguard.ts` | `pi-extensions/compaction-safeguard-quality.ts` |
| 上下文窗口守卫 | `context-window-guard.ts` | `src/agents/context-window-guard.ts` |
| 启动预算管理 | `bootstrap-budget.ts` | `src/agents/bootstrap-budget.ts` |
| 混合检索配置 | `memory-search-config.ts` | `src/agents/memory-search.ts` |
| Embedding 提供者 | `embedding-provider.ts` | `packages/memory-host-sdk/host/embeddings.ts` |
| 内存刷新触发 | `memory-flush.ts` | `src/auto-reply/reply/memory-flush.ts` |
| 会话管理器 | `session-manager.ts` | `src/acp/control-plane/manager.core.ts` |
