# journey-funnel

离线旅程漏斗分析库（TypeScript）。由上层分析工具直接调用：准备数据一次，
保存到本地文件，之后任意新进程可重新打开并执行毫秒级时间窗查询。

## 功能

- 固定 4 阶段漏斗：`impression → click → click → conversion`。
- 输入事件：`{ customer, journey, action, time, seq }`（UTC 毫秒 + 同毫秒排序序号），
  允许乱序输入；旅程内按 `(time, seq)` 确定先后。
- 查询：左闭右开时间窗 `[startMs, endMs)`，端点为任意毫秒，
  返回 4 个阶段各自完成的客户数（按客户去重）。
- 完成第 k 阶段：同一旅程内存在依次匹配前 k 个动作的不同事件，
  且全部位于窗口内（允许夹杂其他动作；两个 click 不复用同一事件；
  同毫秒不同序号的事件可依次完成阶段）。
- 准备结果保存到本地文件后，新进程重新打开得到完全相同的查询结果。

## 使用

```ts
import { prepare, save, open } from "journey-funnel";

// 准备（一次性，不计入查询耗时）
const prepared = prepare(events); // events: Iterable<FunnelEvent>
save(prepared, "funnel.jf");

// 之后（可以是另一个进程）
const analyzer = open("funnel.jf");
const [impressions, clicks1, clicks2, conversions] =
  analyzer.query(startMs, endMs);
```

## 设计

对每个客户、每个阶段，把该客户所有旅程中可能完成的链
（首事件时间 `start`，末事件时间 `end`）做帕累托前沿化简：
前沿按 `start` 升序时 `end` 也升序，因此窗口 `[s,e)` 完成该阶段
⟺ 前沿上第一个 `start >= s` 的点满足 `end < e`。
每个前沿点生成矩形 `(prevStart, start] × (end, +∞)`，
同一客户的矩形在 s 轴上互不重叠，所以命中矩形数就是去重客户数。
矩形刺探再分解为两组点的二维支配计数之差
（`xl < s ≤ xr` 且 `y < e`），用小波矩阵（wavelet matrix）
在 O(log σ) 内回答，单次查询只做 8 次支配计数。

## 测试与基准

```sh
npm install
npm test        # 正确性测试：与独立逐旅程暴力计算对照
npm run bench   # 全量基准：1000 万事件 / 50 万客户 / 200 万旅程 / 365 天
```

基准流程：准备数据并保存 → 新进程 A 重开，100 次预热后串行 10000 次查询
（80% 覆盖 50%~90% 事件的宽窗口 + 20% 任意毫秒边界的密集滑动窗口）
→ 新进程 B 重开执行相同查询，逐条比对一致 → 抽样与全量暴力计算比对。

本机（Apple Silicon）实测结果：

| 指标 | 目标 | 实测 |
| --- | --- | --- |
| 10000 次查询总耗时 | ≤ 8 s | ≈ 0.12 s |
| 单次 p95 | ≤ 2 ms | ≈ 0.02 ms |
| 查询进程峰值 RSS | ≤ 768 MiB | ≈ 276 MiB |
| 重开一致性 | 全部一致 | 10000/10000 一致 |
| 抽样比对暴力计算 | 一致 | 30/30 一致 |

## 目录

- `src/types.ts` — 事件与结果类型
- `src/prepare.ts` — 数据准备（链提取、帕累托前沿、支配点集）
- `src/wavelet.ts` — 小波矩阵（二维支配计数）
- `src/analyzer.ts` — 查询分析器
- `src/serialize.ts` — 二进制文件保存 / 重开
- `test/` — 自动化测试（含独立暴力参考实现）
- `bench/` — 全量基准（生成、查询子进程、校验）
