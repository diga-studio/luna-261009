import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { ConsentVault } from "../src/index";
import type { KeyringFile, RotationStateFile } from "../src/types";

function makeVaultDir(): string {
  return mkdtempSync(join(tmpdir(), "consent-vault-test-"));
}

function loadKeyring(dir: string): KeyringFile {
  return JSON.parse(readFileSync(join(dir, "keyring.json"), "utf8"));
}

function loadRotation(dir: string): RotationStateFile {
  return JSON.parse(readFileSync(join(dir, "rotation.json"), "utf8"));
}

function* walkFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) {
      yield* walkFiles(file);
    } else {
      yield file;
    }
  }
}

test("两轮轮换：穿插保存读取，最终内容逐字节一致且旧密钥被移除", () => {
  const dir = makeVaultDir();
  try {
    const vault = new ConsentVault(dir);
    const originals = new Map<string, Buffer>();
    const save = (id: string) => {
      const pii = randomBytes(64 + Math.floor(Math.random() * 64));
      vault.saveCredential(id, pii);
      originals.set(id, pii);
    };

    for (let i = 0; i < 5; i += 1) save(`before-r1-${i}`);
    const initialKeyId = loadKeyring(dir).currentKeyId;

    // 第一轮：小步推进，推进间隙穿插保存与读取。
    let convertedTotal = 0;
    let rounds = 0;
    for (;;) {
      const progress = vault.advanceRotation("rotation-1", 2);
      convertedTotal += progress.converted;
      rounds += 1;
      if (progress.done) break;
      assert.ok(rounds < 100, "rotation should terminate");
      save(`during-r1-${rounds}`);
      const probe = originals.get("before-r1-0")!;
      assert.deepEqual(vault.readCredential("before-r1-0"), probe);
    }
    const afterR1 = loadKeyring(dir);
    assert.notEqual(afterR1.currentKeyId, initialKeyId);
    assert.ok(!(initialKeyId in afterR1.keys), "old key must be removed");
    assert.deepEqual(loadRotation(dir).completed, ["rotation-1"]);
    assert.ok(convertedTotal >= 5, "pre-existing credentials were converted");

    // 第二轮：同样穿插保存与读取。
    for (let i = 0; i < 4; i += 1) save(`before-r2-${i}`);
    const r1KeyId = afterR1.currentKeyId;
    rounds = 0;
    for (;;) {
      const progress = vault.advanceRotation("rotation-2", 3);
      rounds += 1;
      if (progress.done) break;
      assert.ok(rounds < 100, "rotation should terminate");
      save(`during-r2-${rounds}`);
      const probeId = `during-r1-1`;
      if (originals.has(probeId)) {
        assert.deepEqual(vault.readCredential(probeId), originals.get(probeId)!);
      }
    }
    const afterR2 = loadKeyring(dir);
    assert.notEqual(afterR2.currentKeyId, r1KeyId);
    assert.ok(!(r1KeyId in afterR2.keys), "round-1 key must be removed");
    assert.deepEqual(loadRotation(dir).completed, ["rotation-1", "rotation-2"]);

    // 只剩当前一把密钥。
    assert.deepEqual(Object.keys(afterR2.keys), [afterR2.currentKeyId]);

    // 所有凭证与独立保留的原始内容逐字节一致。
    for (const [id, pii] of originals) {
      assert.deepEqual(vault.readCredential(id), pii, `credential ${id}`);
    }

    // 任何持久化文件中都找不到明文。
    for (const file of walkFiles(dir)) {
      const content = readFileSync(file);
      for (const pii of originals.values()) {
        assert.equal(
          content.includes(pii),
          false,
          `plaintext leaked into ${file}`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("相同业务编号继续同一轮；重试已完成轮换不改变当前密钥", () => {
  const dir = makeVaultDir();
  try {
    const vault = new ConsentVault(dir);
    for (let i = 0; i < 6; i += 1) {
      vault.saveCredential(`cred-${i}`, randomBytes(32));
    }

    const first = vault.advanceRotation("rot-x", 2);
    assert.equal(first.done, false);
    const keyAfterFirst = loadKeyring(dir).currentKeyId;

    // 相同编号反复调用：继续同一轮，新密钥保持不变。
    const second = vault.advanceRotation("rot-x", 2);
    assert.equal(second.done, false);
    assert.equal(loadKeyring(dir).currentKeyId, keyAfterFirst);

    // 进行中的轮换不允许用别的编号推进。
    assert.throws(() => vault.advanceRotation("rot-other", 2));

    const third = vault.advanceRotation("rot-x", 2);
    assert.equal(third.done, true);
    assert.equal(third.remaining, 0);
    const keyAfterDone = loadKeyring(dir).currentKeyId;
    assert.equal(keyAfterDone, keyAfterFirst);
    assert.equal(Object.keys(loadKeyring(dir).keys).length, 1);

    // 重试已完成编号：仍报告完成，且当前密钥不变。
    const retry = vault.advanceRotation("rot-x", 2);
    assert.deepEqual(retry, { done: true, converted: 0, remaining: 0 });
    assert.equal(loadKeyring(dir).currentKeyId, keyAfterDone);
    assert.equal(Object.keys(loadKeyring(dir).keys).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("读取不存在的凭证返回 null；重复保存抛错；密文被篡改时解密失败", () => {
  const dir = makeVaultDir();
  try {
    const vault = new ConsentVault(dir);
    assert.equal(vault.readCredential("missing"), null);

    vault.saveCredential("c1", Buffer.from("hello"));
    assert.throws(() => vault.saveCredential("c1", Buffer.from("other")));
    assert.deepEqual(vault.readCredential("c1"), Buffer.from("hello"));

    const file = join(dir, "credentials", "c1.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    const data = Buffer.from(record.data, "base64");
    data[0] ^= 0xff;
    record.data = data.toString("base64");
    const { writeFileSync } = require("node:fs");
    writeFileSync(file, JSON.stringify(record));
    assert.throws(() => vault.readCredential("c1"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
