# consent-vault

同意凭证密钥轮换库（TypeScript）。凭证与密钥持久化在本地文件系统中，
个人信息使用 AES-256-GCM（256 位密钥）认证加密，明文只存在于内存。

## 安装与测试

```sh
npm install
npm test
```

## 使用

```ts
import { ConsentVault } from "consent-vault";

const vault = new ConsentVault("/path/to/vault-dir");

// 保存 / 读取凭证（保存后不可修改，读回与保存时逐字节一致）
vault.saveCredential("cred-001", Buffer.from("..."));
const pii = vault.readCredential("cred-001"); // 不存在时返回 null

// 分次推进密钥轮换：由调用方提供唯一业务编号
for (;;) {
  const { done, converted, remaining } = vault.advanceRotation("2026-Q4-rotation", 500);
  if (done) break;
  // 未完成期间可正常保存、读取凭证，稍后再继续推进
}
```

- 首次推进某编号即生成全新密钥并立即用于此后保存的凭证；
- 相同编号重复调用继续同一轮；已完成编号再次调用直接报告完成，不改变任何状态；
- 仅当所有凭证不再依赖旧密钥、且旧密钥已从 `keyring.json` 移除时才报告完成；
- 调用方需在上一轮完成后再发起下一轮，否则抛错。

## 持久化布局

```
<dir>/keyring.json        密钥表与当前密钥编号
<dir>/rotation.json       进行中的轮换与已完成业务编号
<dir>/credentials/*.json  逐条凭证的密文、nonce、认证标签与所用密钥编号
```

所有写入均为原子写（临时文件 + rename）。
