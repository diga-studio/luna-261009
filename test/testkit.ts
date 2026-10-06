// node:test 的最小类型垫片：本机 @types/node 版本较旧不含 node:test 类型，
// 通过 createRequire 加载，避免与新版 @types/node 自带的模块声明冲突。
import { createRequire } from "node:module";

const req = createRequire(__filename);

type TestBody = () => void | Promise<void>;
interface TestKit {
  test(name: string, body: TestBody): void;
}

const kit = req("node:test") as TestKit;

export const test = kit.test;
