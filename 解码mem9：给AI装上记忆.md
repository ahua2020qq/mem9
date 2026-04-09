# 给 AI 装上记忆：mem9 是怎么从 0 到 269 个测试的

## 先说结论

mem9 是一个 TypeScript 写的 LLM 记忆管理工具包，14 个模块，269 个测试，零外部依赖，已通过生产级加固。

它解决一个问题：**AI 助手记不住事。**

你跟 ChatGPT 聊了一下午，关掉窗口，下次打开它全忘了。Agent 跑了一整天，上下文爆了，之前的重要决策全丢了。RAG 检索靠关键词匹配，问法变一下就找不到。

mem9 不是向量数据库，不是另一个 LangChain。它是一组 **拿来就能用的记忆基建模块**，专注做好 LLM 场景下的几件硬事：

- 记住什么（token 估算、自动分块）
- 压缩什么（自适应压缩、质量守卫）
- 找回什么（BM25 全文 + 向量混合搜索）
- 管好什么（会话管理、缓存淘汰）

## 为什么需要它

大模型的上下文窗口在变大，从 4K 到 128K 到 1M。但问题没变：

**窗口再大也会满。**

满了怎么办？传统做法是截断 — 砍掉最早的消息。但你砍掉的可能正好是用户的核心需求、关键决策、重要约束。

mem9 的思路是 **压缩而非截断**：

1. 保留最近 N 轮对话原文
2. 把更早的对话用 LLM 压缩成结构化摘要
3. 摘要必须包含 5 个关键板块（决策、待办、约束、待确认事项、精确标识符）
4. 质量不过关就带上反馈重试（最多 3 次）
5. 最终裁剪到预算内

这不是理论，是跑在生产环境里验证过的方案。

## 14 个模块，各司其职

```
┌─────────────────────────────────────────────────┐
│  会话层                                          │
│  session-manager · context-window-guard          │
│  bootstrap-budget · memory-flush                 │
├─────────────────────────────────────────────────┤
│  压缩层                                          │
│  compaction · quality-safeguard                  │
│  compaction-guardian                             │
├─────────────────────────────────────────────────┤
│  检索层                                          │
│  memory-store · memory-cache · memory-search-    │
│  config · embedding-provider                     │
├─────────────────────────────────────────────────┤
│  基础层                                          │
│  token-estimator · text-chunker · types · errors │
└─────────────────────────────────────────────────┘
```

几个亮点：

**Token 估算 — 中日韩 + 拉丁混合计算**

中文按 1.5 字/token，英文按 4 字/token，混合文本分别统计。不是精确值，但够用。性能：CJK ~980K ops/s，Latin ~450K ops/s。

**BM25 全文搜索 — 不是玩具**

自己实现的 BM25，不是 TF-IDF。有 IDF 逆文档频率、TF 词频归一化、文档长度归一化（k1=1.2, b=0.75）。v1.2 加了 term frequency 预计算，搜索时 O(1) 查表，不再重复 tokenize。查得准，跑得快（~700K ops/s）。

**CJK bigram 分词 — 中文终于能搜了**

原来的 tokenizer 按空格分词，中文整句变成一个 token，搜索形同虚设。v1.2 换成 bigram 滑动窗口：`"人工智能的发展"` → `["人工","工智","智能","能的","的发","发展"]`。搜 "人工"、"智能" 都能命中。日文、韩文同样支持。

**混合检索 — 向量 + 文本双通道**

向量搜索负责语义相似度，BM25 负责关键词匹配，7:3 加权融合。同一个 query 两种路径互补，比单一策略召回率高。

**质量守卫 — 压缩不能丢信息**

压缩后的摘要必须通过质量审计：5 个必选板块是否齐全？标识符（UUID、URL、文件路径）是否保留？最新的用户需求是否体现在摘要中？不过关就带着反馈重新压缩。

## 从 0 到 1 的过程

说实话，这个项目经历了三轮 AI 协作：

**第一轮：DeepSeek 设计架构。** 14 个模块怎么划分、接口怎么定义、层次怎么组织。

**第二轮：GLM4.5 写代码。** 按照架构设计实现了基础功能，能跑但有不少 bug。

**第三轮：Claude 做代码审查和修复。** 逐模块 review，发现了 8 个 bug（CJK token 估算错误、BM25 归一化导致搜索返回空结果、压缩守护逻辑重复、哈希碰撞率过高……），逐个修复，然后补充了超时保护、并发安全、类型安全等生产级加固。

三轮 AI 各有所长，配合起来效果不错。

## 生产级加固

v1.0 能跑了，但离生产还有距离。v1.1 和 v1.2 做了一轮系统性的加固：

**超时保护** — 所有 embedding API 调用都有 30 秒超时（OpenAI/Ollama/Generic 三种 provider 全覆盖）。网络抖动不会让整个 store 卡死。

**写锁细粒度优化** — 原来 embedding 计算和内存写入都在同一个锁里，10 条并发 store 要串行等 2 秒。v1.2 把 embedding 计算提到锁外面，只锁内存写入（微秒级），并发吞吐提升 5-10 倍。

**Embedding 批量分片** — OpenAI 单次请求有 token 上限，一次性发 10000 条会崩。加了自动分片（batch=100），Ollama 也从无限制并发改成最多 5 个并发请求。

**并发安全** — AbortSignal 支持、maxEntries（5 万条上限）自动淘汰、LRU 缓存惰性清理。

**Tree-shaking 友好** — `sideEffects: false`，14 个子模块独立导出，用户只 import 一个函数不会打包整个库。

## 修过的那些 bug

挑几个有意思的说：

**BM25 归一化 bug — 所有搜索返回空**

BM25 原始分数经过 `Math.max(...scores, 1)` 归一化。问题在于 BM25 的 IDF 分数经常 < 1，所以 `maxScore` 永远是 1（那个兜底的 `1`），归一化后的分数全部低于 `minSimilarity(0.35)`，结果就是：**搜索永远返回空**。

改成 `scores.length > 0 ? Math.max(...scores) : 1` 后，一切正常。

**缓存哈希碰撞 — DJB2 不够用**

最初用 DJB2 整数哈希，短文本碰撞率太高。换成 FNV-1a + 长度混合的双哈希方案（两个独立哈希分量），碰撞率大幅下降。

**压缩守护逻辑重复 — 写了两遍**

`compaction-guardian.ts` 和 `compaction.ts` 里有重复的分块+压缩逻辑。重构后 guardian 直接调用 `summarizeInStages()`，自己只负责质量检查和重试循环。代码量减少，职责更清晰。

**sideEffects 配反 — tree-shaking 形同虚设**

`package.json` 里写了 `"sideEffects": ["*.ts"]`，但 npm 包只发布 `dist/`（.js 文件），.ts 文件根本不在包里。bundler 认为所有模块都有副作用，import 一个函数也打包整个库。改成 `false` 后 tree-shaking 正常工作。

**CJK 全文检索失效 — 中文搜不到任何东西**

tokenizer 用 `split(/[^\p{L}\p{N}]+/u)` 按空格分词，中文没有空格，整句变成一个 token。搜索 "人工" 完全无法匹配 "人工智能的发展"。换成 bigram 滑动窗口后问题解决。

## 269 个测试

| 模块 | 测试数 |
|------|--------|
| token-estimator | 12 |
| text-chunker | 9 |
| compaction | 16 |
| quality-safeguard | 14 |
| memory-store | 13 |
| memory-cache | 12 |
| context-window-guard | 22 |
| bootstrap-budget | 19 |
| session-manager | 30 |
| memory-flush | 27 |
| embedding-provider | 22 |
| memory-search-config | 43 |
| e2e 全链路 | 30 |
| **合计** | **269** |

13 个测试文件，覆盖全部 14 个模块。0 个 TypeScript 编译错误。

## 版本迭代

| 版本 | 日期 | 测试数 | 关键改进 |
|------|------|--------|----------|
| v1.0.0 | 2026-04-07 | 106 | 14 模块基础实现，BM25 修复，哈希升级 |
| v1.1.0 | 2026-04-08 | 269 | 生产加固：超时、AbortSignal、写锁、maxEntries、类型安全 |
| v1.2.0 | 2026-04-09 | 269 | 性能优化：BM25 预计算、CJK bigram、写锁细粒度、embedBatch 分片 |

从 v1.0 到 v1.2，三天迭代三轮，每一轮都有实质性的质量提升。

## 快速上手

```bash
npm install mem9
```

```typescript
import { MemoryStore, createOpenAIEmbeddingProvider } from "mem9";

// 创建带向量搜索的内存存储
const provider = await createOpenAIEmbeddingProvider({
  apiKey: process.env.OPENAI_API_KEY,
});

const store = new MemoryStore({ embeddingProvider: provider });

// 存
await store.store({
  content: "用户偏好深色模式，使用中文交流",
  metadata: { source: "conversation", tags: ["preference"] },
});

// 取 — 混合搜索（向量 70% + BM25 30%）
const results = await store.search({
  text: "用户界面偏好设置",
  strategy: "hybrid",
  topK: 5,
});

// 中文搜索同样有效（CJK bigram 分词）
const cnResults = await store.search({
  text: "深色模式",
  strategy: "hybrid",
  topK: 3,
});
```

不需要向量数据库，不需要 Redis，纯内存运行。想要持久化？`SqliteMemoryStore` 开箱即用。

## 和 soul-memory-system 的关系

同一个作者还写了 [soul-memory-system](https://github.com/ahua2020qq/soul-memory-system)（Python），定位互补：

- **mem9**（TypeScript）— 轻量工具库，嵌入 Node.js 项目，工程扎实
- **soul-memory-system**（Python）— 完整记忆系统，FAISS + jieba 中文分词，架构激进

如果你用 Python 做 AI，选 soul；如果你用 TypeScript 做 Agent，选 mem9。

## 最后

这个项目没有什么宏大叙事。就是一个实用的工具包，解决了 LLM 记忆管理的几个具体问题，测试写够了，类型搞对了，文档补齐了，开源出来。

9 = 久。希望你的 AI 也能记住久一点。

**GitHub:** https://github.com/ahua2020qq/mem9
**License:** MIT
