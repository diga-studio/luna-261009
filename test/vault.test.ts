import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { ConsentVault } from "../src/index";
import { KeyringFile } from "../src/types";

function makeVaultDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "consent-vault-test-"));
}

function loadKeyring(dir: string): KeyringFile {
  return JSON.parse(fs.readFileSync(path.join(dir, "keys.json"), "utf8")) as KeyringFile;
}

function allPersistedText(dir: string): string {
  const chunks: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        chunks.push(fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(dir);
  return chunks.join("\n");
}

function randomPersonalInfo(): Buffer {
  const id = Math.random().toString(36).slice(2, 10);
  return Buffer.from(`姓名:测试用户${id}|证件号:${Date.now()}${id}|电话:1380000${id}`, "utf8");
}

test("两轮完整轮换，期间穿插保存读取，最终内容逐字节一致且旧密钥被移除", () => {
  const dir = makeVaultDir();
  const vault = new ConsentVault(dir);
  const originals = new Map<string, Buffer>();
  const save = (info: Buffer): string => {
    const id = vault.saveCredential(info);
    originals.set(id, Buffer.from(info));
    return id;
  };

  const initialKeyId = loadKeyring(dir).activeKeyId;

  // 轮换前保存 5 条。
  for (let i = 0; i < 5; i += 1) save(randomPersonalInfo());

  // 第一轮：分批推进，批次之间穿插保存与读取。
  let progress = vault.advanceRotation("rotation-1", 2);
  assert.equal(progress.done, false);
  const rotation1KeyId = loadKeyring(dir).activeKeyId;
  assert.notEqual(rotation1KeyId, initialKeyId);

  // 首次推进成功后保存的凭证必须使用新密钥。
  for (let i = 0; i < 3; i += 1) save(randomPersonalInfo());
  const midFile = JSON.parse(
    fs.readFileSync(
      path.join(dir, "credentials", `${[...originals.keys()].at(-1)}.json`),
      "utf8",
    ),
  );
  assert.equal(midFile.keyId, rotation1KeyId);

  // 部分转换期间读取新旧密钥加密的凭证都必须正确。
  for (const [id, expected] of originals) {
    assert.deepEqual(Buffer.from(vault.readCredential(id)), expected);
  }

  progress = vault.advanceRotation("rotation-1", 2);
  assert.equal(progress.done, false);
  for (let i = 0; i < 2; i += 1) save(randomPersonalInfo());

  progress = vault.advanceRotation("rotation-1", 100);
  assert.equal(progress.done, true);
  assert.equal(progress.remaining, 0);

  // 第一轮完成后密钥环只剩新密钥。
  const afterFirst = loadKeyring(dir);
  assert.equal(afterFirst.keys.length, 1);
  assert.equal(afterFirst.keys[0].keyId, rotation1KeyId);

  // 第二轮：同样穿插保存与读取。
  for (let i = 0; i < 4; i += 1) save(randomPersonalInfo());
  progress = vault.advanceRotation("rotation-2", 3);
  assert.equal(progress.done, false);
  const rotation2KeyId = loadKeyring(dir).activeKeyId;
  assert.notEqual(rotation2KeyId, rotation1KeyId);
  for (let i = 0; i < 2; i += 1) save(randomPersonalInfo());
  while (!progress.done) {
    progress = vault.advanceRotation("rotation-2", 3);
  }

  // 全部凭证与独立保留的原始内容逐字节一致。
  assert.equal(originals.size, 16);
  for (const [id, expected] of originals) {
    assert.deepEqual(Buffer.from(vault.readCredential(id)), expected);
  }

  // 旧密钥不再存在于任何持久化文件中。
  const finalKeyring = loadKeyring(dir);
  assert.equal(finalKeyring.keys.length, 1);
  assert.equal(finalKeyring.keys[0].keyId, rotation2KeyId);
  const persisted = allPersistedText(dir);
  for (const oldKeyId of [initialKeyId, rotation1KeyId]) {
    assert.ok(!persisted.includes(oldKeyId), `old key id ${oldKeyId} must be gone`);
  }
});

test("相同业务编号重复推进继续同一轮；已完成编号重试仍报告完成且密钥不变", () => {
  const dir = makeVaultDir();
  const vault = new ConsentVault(dir);
  const originals = new Map<string, Buffer>();
  for (let i = 0; i < 3; i += 1) {
    const info = randomPersonalInfo();
    originals.set(vault.saveCredential(info), Buffer.from(info));
  }

  // 反复以相同编号推进：每次只处理 1 条，逐步完成同一轮。
  let progress = vault.advanceRotation("rotate-x", 1);
  assert.equal(progress.done, false);
  assert.equal(progress.reencrypted, 1);
  const newKeyId = loadKeyring(dir).activeKeyId;

  progress = vault.advanceRotation("rotate-x", 1);
  assert.equal(progress.done, false);
  assert.equal(loadKeyring(dir).activeKeyId, newKeyId);

  progress = vault.advanceRotation("rotate-x", 10);
  assert.equal(progress.done, true);
  assert.equal(loadKeyring(dir).activeKeyId, newKeyId);

  // 重试已完成的编号：报告完成，不改变当前密钥，也不启动新一轮。
  const retry = vault.advanceRotation("rotate-x", 10);
  assert.equal(retry.done, true);
  assert.equal(retry.reencrypted, 0);
  assert.equal(loadKeyring(dir).activeKeyId, newKeyId);
  assert.equal(loadKeyring(dir).keys.length, 1);

  // 上一轮进行中不得用别的编号开启另一轮。
  const vault2 = new ConsentVault(makeVaultDir());
  vault2.saveCredential(randomPersonalInfo());
  vault2.saveCredential(randomPersonalInfo());
  vault2.advanceRotation("rotate-a", 1);
  assert.throws(() => vault2.advanceRotation("rotate-b", 1), /still in progress/);

  // 全部凭证仍然可读且逐字节一致。
  for (const [id, expected] of originals) {
    assert.deepEqual(Buffer.from(vault.readCredential(id)), expected);
  }
});

test("个人信息不以明文出现在任何持久化文件中", () => {
  const dir = makeVaultDir();
  const vault = new ConsentVault(dir);
  const secret = "敏感信息-身份证号-110101199003077777";
  vault.saveCredential(Buffer.from(secret, "utf8"));
  vault.advanceRotation("rotation-pii", 10);
  const persisted = allPersistedText(dir);
  assert.ok(!persisted.includes(secret));
  assert.ok(!persisted.includes(Buffer.from(secret, "utf8").toString("base64")));
  assert.ok(!persisted.includes(Buffer.from(secret, "utf8").toString("hex")));
});
