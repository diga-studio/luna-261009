# ConsentVault 同意凭证密钥轮换模块

TypeScript 库，由上层应用调用。负责同意凭证的保存、读取与加密密钥轮换；
凭证与密钥全部持久化在本地文件目录中，不依赖任何外部服务。

## 构建与测试

```sh
npm install
npm test
```

## 使用

```ts
import { ConsentVault } from "consent-vault";

const vault = new ConsentVault("/path/to/data-dir");

// 保存凭证：返回唯一编号；内容保存后不可修改
const id = vault.saveCredential(Buffer.from("个人信息字节串", "utf8"));

// 读取凭证：返回与保存时逐字节一致的内容
const info: Uint8Array = vault.readCredential(id);

// 分次推进密钥轮换（上层按安全政策定期触发，例如每 90 天）
let progress = vault.advanceRotation("rotation-2026-q4", 100);
while (!progress.done) {
  // 未完成期间可正常 saveCredential / readCredential
  progress = vault.advanceRotation("rotation-2026-q4", 100);
}
```

## 行为约定

- 个人信息使用 256 位密钥做 AES-256-GCM 认证加密，明文不出现在任何持久化文件中。
- `advanceRotation(rotationId, batchSize?)` 每次调用最多重加密 `batchSize` 条凭证，
  返回 `{ done, reencrypted, remaining }`。
- 首次推进成功返回后，新保存的凭证立即使用该轮的新密钥。
- 相同 `rotationId` 重复调用继续同一轮；已完成的编号再次调用直接报告完成，
  不改变当前密钥；上一轮未完成时用新编号调用会抛错。
- 只有全部凭证都不再依赖旧密钥、且旧密钥已从持久化文件中移除，才报告完成。

## 持久化布局（数据目录内）

- `keys.json`：密钥环（当前密钥 + 轮换期间的旧密钥）
- `rotation.json`：轮换状态（进行中的轮换与已完成编号）
- `credentials/<id>.json`：每条凭证一个文件，只含密文、随机数、认证标签与密钥编号
