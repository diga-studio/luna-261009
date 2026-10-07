# learning-path-settlement

学习路径达标结算库（TypeScript + SQLite）。由上层系统调用，负责单条学习路径的
修订发布、测验成绩接收、学习者当前进度查询与历史徽章查询，数据持久化到本地
SQLite 文件。学习者集合、身份与测验评分均由上层提供并视为可信；本库不实现
账号或出题功能。

## 环境要求

- Node.js ≥ 22.5（使用内置 `node:sqlite`，无任何原生/外部依赖）
- `npm install && npm test` 即可构建并运行全部测试

## 使用

```ts
import { LearningPath } from "learning-path-settlement";

const lp = new LearningPath("./pathway.db");

// 发布修订（1–30 个不重复模块 + 1–100 的整数通过百分比），立即成为当前修订
const { revisionId } = lp.publishRevision(
  [
    { moduleId: "safety", contentVersion: "v3" },
    { moduleId: "welding", contentVersion: "v1" },
  ],
  70,
);

// 接收测验成绩（允许乱序、重复提交；同一 attemptId 只计入一次）
lp.submitScore({
  learnerId: "worker-1",
  attemptId: "attempt-abc",
  moduleId: "safety",
  contentVersion: "v3",
  correct: 8,
  total: 10,
});

// 当前进度：只考察当前修订的模块，按精确比例 correct*100 >= total*passPercent 判定
const progress = lp.getProgress("worker-1");
// { revisionId, passPercent, modules: [{moduleId, contentVersion, passed}], allPassed, currentBadgeEarned }

// 历史徽章：永久保留，不代表当前修订已完成
const badges = lp.getBadges("worker-1");

lp.close();
```

## 核心规则

- 每次发布产生不可修改的新修订并立即成为当前修订；发布成功返回时，所有学习者
  （包括未提交新成绩的人）已按新标准重新结算完毕。
- 成绩必须同时匹配模块身份与内容版本才能复用；模块移除后不参与达标，原身份
  原版本重新加入时历史成绩再次生效；晚到的旧内容成绩保留但不贡献当前进度。
- 同一模块身份 + 内容版本下任意一次成绩达标即视为达标，失败重考不会覆盖；
  重复提交（同一 `attemptId`）只计入一次。
- 当前修订全部模块达标即自动授予该修订徽章，每个学习者每个修订最多一次；
  晚到成绩不补发已下线修订的徽章。
- 发布、接收、查询均可并发调用；每次查询读取的是一个完整生效的一致快照。

## 项目结构

- `src/types.ts` — 公开类型定义
- `src/db.ts` — SQLite 打开与表结构
- `src/learning-path.ts` — 结算核心（发布 / 接收 / 查询）
- `test/settlement.test.ts` — 业务规则测试
- `test/concurrency.test.ts` — 并发一致性测试（对照独立参考模型重放校验）
- `test/performance.test.ts` — 性能测试（300 次查询 p95、单次发布耗时）

## 常用命令

```sh
npm install   # 安装开发依赖（typescript、@types/node）
npm run build # 编译到 dist/
npm test      # 编译并运行全部测试
```
