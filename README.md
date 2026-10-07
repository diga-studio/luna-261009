# learning-path-settlement

学习路径达标结算库（TypeScript + SQLite）。由上层应用调用，管理**一条**学习路径：
发布修订、接收测验成绩、读取学习者当前进度与历史徽章。数据持久化到本地 SQLite 文件。

- 运行时零依赖：只使用 Node.js 内置模块（`node:sqlite`，需 Node >= 22.5，建议 >= 24）。
- 学习者集合、身份与测验评分由上层提供，本库不实现账号或出题功能。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

## API

```ts
import { LearningPathService } from "learning-path-settlement";

const svc = new LearningPathService("path/to/data.db");

svc.setLearners(["w1", "w2"]);                 // 登记学习者（增量；提交成绩也会自动登记）

svc.publishRevision({                          // 发布修订，立即成为当前修订
  modules: [{ moduleId: "m1", contentVersion: "v1" }],  // 1~30 个不重复模块
  passPercent: 70,                             // 1~100 的整数，适用于全部模块
});                                            // => { revisionId: 1 }，发布时所有学习者按新标准重新结算

svc.submitAttempt({                            // 接收测验成绩（允许乱序、重复）
  attemptId: "global-unique",                  // 全局唯一答题编号，重复提交只计一次
  learnerId: "w1",
  moduleId: "m1",
  contentVersion: "v1",
  correct: 7,
  total: 10,
});                                            // => { accepted: true | false }

svc.getProgress("w1");                         // 相对当前修订的进度（精确比例判定，不四舍五入）
svc.getBadges("w1");                           // 历史徽章（含已下线修订，永久保留）
svc.close();
```

## 语义要点

- 模块达标：同一模块身份 + 同一内容版本下，任意一次成绩满足 `correct * 100 >= passPercent * total`
  （整数精确比较，不使用四舍五入后的展示分数）；失败重考不会覆盖已有的更好成绩。
- 当前进度只考察当前修订的模块；成绩须同时匹配模块身份与内容版本才可复用。
  模块移除后重新加入（同身份同版本）时，历史成绩再次生效。
- 当前修订全部模块达标即自动授予该修订徽章，每个修订最多授予一次；历史徽章永久保留，
  但不代表当前修订已完成。晚到成绩只参与接收时当前修订的结算，不补发已下线修订的徽章。
- 所有写操作在单个 SQLite 事务中完成：方法返回时，受影响的当前进度与徽章已一起生效。
  同步 API + 单连接，并发调用在事件循环中串行执行，每次查询都对应一个完整生效的状态。

## 目录结构

- `src/types.ts` — 公开类型定义
- `src/db.ts` — SQLite 连接与表结构
- `src/service.ts` — 结算核心逻辑
- `test/settlement.test.ts` — 业务规则测试
- `test/concurrency.test.ts` — 并发一致性与独立重放对账
- `test/perf.test.ts` — 性能验收（300 次查询 p95 <= 100ms，发布 <= 2s）
