# sql-index-diagnoser

离线 SQL 索引诊断库，供托管平台静态分析调用：调用方传入 SQL 批次与表结构，
库不执行任何查询，只对每个基础表读取实例报告索引可用性。

## 使用

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

```js
const { diagnose } = require('sql-index-diagnoser');

const reports = diagnose(
  'SELECT * FROM t WHERE a = 1 AND (b = 2 OR b > 2) AND c = 3',
  [
    {
      name: 't',
      columns: ['a', 'b', 'c'],
      indexes: [{ name: 'idx_abc', columns: ['a', 'b', 'c'] }],
    },
  ],
);
// reports[0].indexes[0].guaranteedPrefix === 2
// reports[0].hasFullScanBranch === false
```

## API

`diagnose(sql: string, tables: TableDef[]): ReadInstanceReport[]`

- `TableDef`：表名、列名清单、B-tree 普通列索引（`columns` 按索引键顺序）。
- 每个 `ReadInstanceReport` 对应一次基础表读取实例（同表不同实例不合并，
  同一 CTE 的不同引用分别诊断）：
  - `indexes[].guaranteedPrefix`：该索引在所有 OR 分支中保证可用的最左前缀长度（取各分支最小值）。
  - `hasFullScanBranch`：存在某个分支对全部索引的可用前缀均为零时为 `true`。

## 支持的 SQL 子集（PostgreSQL 风格 SELECT）

- 每个查询块单一数据源：基础表、非递归 CTE 或 FROM 子查询；CTE 只能引用此前定义的 CTE。
- 投影：直接列、`AS` 重命名、`*`。
- 条件：括号、`AND`/`OR`、等值与范围比较、`BETWEEN`、常量列表 `IN`、`IS NULL`、相关 `EXISTS`。
- 未加双引号的名称按小写解析；双引号名称区分大小写；字符串内容不参与结构判断。
- CTE / FROM 子查询视为透明视图：各层过滤共同约束最终基础表，外层条件穿过列重命名映射到基础列。
- `EXISTS` 不为父查询提供索引约束；其内部读取实例独立诊断，内部谓词不外泄。

## 前缀判定规则

- 一个索引只使用连续最左前缀：零个或多个等值列之后最多再使用一个范围列，不能跳过未约束列。
- `IN`、`IS NULL` 按等值处理；同列同时有等值和范围约束时按等值计。
- 比较必须直接作用于列；另一侧可以是数字、字符串、布尔字面量或已绑定的外层列，两侧可交换。
- 同查询块内的列与列比较不提供索引约束。
- `AND` 联合列约束，`OR` 按分支分别判断；不做条件矛盾或常量真假推断。
