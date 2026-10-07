# sql-index-doctor

离线 SQL 索引诊断库，由托管平台调用。SQL 批次与表结构由调用方传入，不执行查询。

## 使用

```js
const { diagnose } = require("sql-index-doctor");

const report = diagnose(
  "SELECT * FROM t WHERE a = 1 AND (b = 2 OR b > 2) AND c = 3",
  [
    {
      name: "t",
      columns: ["a", "b", "c"],
      indexes: [["a", "b", "c"]],
    },
  ],
);
// report.instances[0].indexes[0].guaranteedPrefix === 2
// report.instances[0].hasFullScanBranch === false
```

## 输入

- `sql`：分号分隔的 SELECT 批次（PostgreSQL 子集）。
- `schemas`：每个基础表的列名清单与 B-tree 索引（有序列清单，仅普通列索引）。

## 输出

对每个基础表读取实例（同表不同实例不合并）报告：

- `indexes[].guaranteedPrefix`：该索引保证可用的最左前缀长度（所有 OR 分支中的最小值）。
- `hasFullScanBranch`：是否存在某个分支对全部索引的可用前缀均为零。

## 支持的 SQL 子集

- 每个查询块单一数据源：基础表、非递归 CTE（仅引用此前定义的 CTE）或 FROM 子查询。
- 投影：直接列、`AS` 重命名、星号。
- 条件：括号、`AND`/`OR`、等值与范围比较、`BETWEEN`、常量列表 `IN`、`IS NULL`、`EXISTS`。
- 未加双引号的名称按小写解析；双引号名称区分大小写；字符串中的关键词不参与结构判断。

## 诊断规则

- CTE / FROM 子查询视为透明视图，各层过滤共同约束最终基础表，外层条件穿过列重命名对应到基础列。
- `EXISTS` 不为父查询提供约束，其内部读取实例独立诊断，内部谓词不泄漏到父查询。
- 索引只使用连续最左前缀：零个或多个等值列之后最多一个范围列；`IN`、`IS NULL` 按等值计；同列等值优先于范围。
- 比较一侧必须是列，另一侧为数字/字符串/布尔字面量或已绑定的外层列；同块内列与列比较不提供约束。

## 开发

```sh
npm install
npm test
```
