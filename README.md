# step-index

STEP (ISO-10303-21) 结构索引库：调用方逐段喂入 UTF-8 字节，
解析后的实体与引用关系持久化在 SQLite，供上层 CAD 程序查询。

## 用法

```ts
import { StepIndex } from "step-index";

const idx = StepIndex.open("model.db");      // SQLite 文件
const imp = idx.beginImport();               // 整次导入是一个事务
imp.write(chunk);                            // Uint8Array，可切在任意字节处
imp.write(more);
imp.finish();                                // 校验未定义引用并提交；失败则回滚，旧索引不变

const e = idx.getEntity(8);                  // string | number | bigint
// e = { id, complex, components: [{ name, params: [...] }],
//       forwardRefs: [...], backwardRefs: [...] }   （编号均为十进制字符串）
```

- 支持普通实体 `#8=PART(...)` 与复杂实体 `#9=(A(1)B((#8,$)))`。
- 参数：嵌套列表、带类型值、实体引用、字符串、枚举、数字、`$`、`*`。
- 数字保留原文（如 `-.5`、`1.`、`1.E-3`）；字符串返回解码后的内容
  （`''`、`\\`、`\X2\…\X0\`、`\X4\…\X0\`，校验代理对与非法码点）。
- 实体编号 1..2^63-1，允许前导零、前向引用与环。
- 重复编号、未定义引用、残缺记录、结尾之后有多余内容 → 导入失败并回滚。
- 单条记录 ≤ 64 KiB，参数嵌套 ≤ 64 层。

## 构建与测试

```sh
npm install
npm test        # tsc 编译 + node --test
```

要求 Node.js ≥ 22.5（使用内置 `node:sqlite`），无原生依赖。

## 设计要点

- `src/lexer.ts`：流式词法器。`TextDecoder` 增量解码 UTF-8；
  记号不完整时返回“需要更多数据”，由上层回滚位置后重试；
  已消费输入定期压缩（经 `Buffer` 拷贝摊平，避免 V8 切片字符串钉住整段原文）。
- `src/parser.ts`：分段结构（HEADER 记录只校验语法、不入库）与参数递归下降解析，
  嵌套深度与记录长度受限。
- `src/importer.ts`：把字节流驱动成逐条实体记录写入 Store；任一失败回滚。
- `src/store.ts`：SQLite（`node:sqlite`）。`entities(id, body JSON)`、
  `refs(src, dst)` 双向可查；导入在单事务内完成，结束时校验悬空引用。
- 内存：输入按块流过 lexer→parser→SQLite，驻留窗口与记录大小同阶。
  测试以 `--max-semi-space-size=8` 约束 V8 年轻代（高分配吞吐下 V8
  默认会预留数百 MiB），100 MiB / 100 万实体导入峰值 RSS ≈ 123 MiB。
