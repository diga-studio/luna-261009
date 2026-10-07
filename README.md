# local-knowledge-store

本地知识检索库，供上层 agent 直接调用。原文、文档版本与检索数据全部存入 SQLite，
检索结果完全由当前绑定范围内的有效内容（各文档当前版本）决定。

## 环境要求

- Node.js ≥ 22.5（使用内置 `node:sqlite`，无原生扩展、无运行时依赖）
- `npm install && npm test` 即可构建并运行全部测试

## API

```ts
import { KnowledgeStore } from "local-knowledge-store";

const store = new KnowledgeStore("knowledge.db"); // SQLite 文件路径，":memory:" 亦可

// 提交文档完整新版本（每块提供原文与已归一化词项序列，保留重复），返回版本 ID
const v1 = store.submitVersion("kb1", "doc1", [
  { text: "hello world", terms: ["hello", "world"] },
]);

// 回滚到指定历史版本（仅切换当前版本，不改写历史，之后仍可提交新版本）
store.rollback("kb1", "doc1", v1);

// 按知识库集合检索（≤10 个），返回得分最高的 5 块
const hits = store.search(["kb1", "kb2"], ["hello", "hello", "world"]);
// hits: [{ kbId, docId, versionId, seq, text, score }, ...]

store.close();
```

## 语义

- 每个文档属于一个知识库，只有一个当前版本；旧版本保留但不参与检索。
- 检索范围仅含本次指定的知识库内各文档的当前版本；未绑定知识库与历史版本
  既不出现在结果中，也不影响 N / df / avgL 等评分统计。
- 重复查询词只计算一次；词项仅按完全相等匹配。
- 评分采用固定 BM25 口径（k1=1.2，b=0.75，IDF 为 `ln(1 + (N-df+0.5)/(df+0.5))`），
  返回前 5 块；同分依次按知识库标识、文档标识字典序、块序号升序。
- 关闭重开后，历史版本与当前版本选择保持不变。

## 存储设计

- `documents`：文档当前版本指针与活跃块统计（N、总词项数按知识库聚合查询）。
- `versions` / `chunks`：全部历史版本与块原文。
- `chunk_terms`：`WITHOUT ROWID` 聚簇表，主键 `(version_id, term, seq)`，
  检索按 `(版本集合, 查询词)` 定点扫描，无需回表；历史版本数据不被触碰。

## 测试

```bash
npm test          # 正确性测试 + 规模用例（约 1 分钟）
```

规模用例（可用环境变量缩小：`SCALE_KBS` / `SCALE_DOCS` / `SCALE_CHUNKS` /
`SCALE_HISTORY` / `SCALE_QUERIES`）：100 知识库、200000 活跃块、600000 历史块、
每块 40 词、Zipf 词表（高频词覆盖 >50% 块）、100 条不同查询。

本机实测（Node 24，macOS）：

- 查询 p50 ≈ 3.6ms，p95 ≈ 30ms，max ≈ 66ms（要求 p95 ≤ 200ms）
- 进程峰值内存 ≈ 158 MiB（要求 ≤ 256 MiB）
- 数据加载（8000 个版本，耗时不计入查询指标）≈ 40s
