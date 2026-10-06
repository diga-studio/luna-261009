# task26100918 — LocalPulse 门店一致性报告组件

TypeScript 实现的进程内门店资料一致性报告组件。

## 运行

```sh
npm install
npm test        # 编译 src + test 并用 Node 内置测试运行器执行
npm run build   # 仅编译 src 到 dist/
```

只依赖 Node.js（>=18）与 devDependency `typescript`，无其他服务或运行时依赖。

## 结构

- `src/types.ts` — Profile、报告、评分函数等公开类型。
- `src/scorer.ts` — 默认评分：businessName/address/phone/hours 各 25 分，完全相等得分；hours 按整个数组比较。
- `src/localPulse.ts` — 组件本体：修订号管理、全局并发上限 4 的 FIFO 评分调度、修订级快照与一次性发布。
- `test/` — 确定性交错测试（手动控制的评分函数，不依赖随机延时）。

## 关键设计

- 每次写入递增门店修订号，旧报告立即失效；评分基于写入时的深拷贝快照。
- 同一修订的全部目录评分完成后才一次性发布 ready 报告；过期修订的结果直接丢弃。
- 全局最多 4 个并发评分；已启动的评分即使过期也占名额直到 Promise 结束。
- 写入时把被取代修订的未启动任务从队列移除，连续覆盖不会堆积历史任务，恢复后只补算最新修订。
- 写入/读取为同步方法，不等待评分；`whenIdle()` 等待所有已启动评分结束且各门店最新修订就绪。
