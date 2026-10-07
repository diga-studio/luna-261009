import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DisciplineHistory, DisciplineState as S } from "../src/index.js";
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const PERIOD_START = 0;
const PERIOD_END = 2_000_000;
const KEY_COUNT = 2_000; // 关键处罚：各自独占一段覆盖，撤销必改查询结果
const KEY_ZONE_END = KEY_COUNT * 100; // [0, 200000) 为关键区
const BACKGROUND_COUNT = 98_000;
const PENALTY_COUNT = KEY_COUNT + BACKGROUND_COUNT; // 100_000
const DIRECTIVE_COUNT = 100_000;
const REVOKE_COUNT = 20_000;
const QUERIES_PER_REVOKE = 5;
function buildDossier(rand) {
    const penalties = [];
    // 关键处罚：key_i 独占覆盖 [i*100, i*100+50)，与相邻关键处罚间留 50 秒空档
    for (let i = 0; i < KEY_COUNT; i++) {
        penalties.push({ id: `key${i}`, start: i * 100, end: i * 100 + 50 });
    }
    // 背景处罚：避开关键区，随机大区间，形成高覆盖
    for (let i = 0; i < BACKGROUND_COUNT; i++) {
        const start = KEY_ZONE_END + Math.floor(rand() * (PERIOD_END - KEY_ZONE_END - 2));
        const len = 1 + Math.floor(rand() * Math.min(500_000, PERIOD_END - start - 1));
        penalties.push({ id: `bg${i}`, start, end: start + len });
    }
    const directives = [];
    let seq = 0;
    // 每个关键处罚覆盖段内放一串依赖链：撤销后多条指令须重新判定
    for (let i = 0; i < KEY_COUNT; i++) {
        const base = i * 100;
        directives.push({ time: base + 10, seq: seq++, target: S.Review }, { time: base + 20, seq: seq++, target: S.Punishment }, { time: base + 30, seq: seq++, target: S.Resolved }, { time: base + 35, seq: seq++, target: S.None }, { time: base + 40, seq: seq++, target: S.Review }, { time: base + 45, seq: seq++, target: S.Punishment });
    }
    // 其余指令随机散布
    const targets = [S.None, S.Review, S.Punishment, S.Resolved];
    while (directives.length < DIRECTIVE_COUNT) {
        directives.push({
            time: PERIOD_START + Math.floor(rand() * (PERIOD_END - PERIOD_START)),
            seq: seq++,
            target: targets[Math.floor(rand() * 4)],
        });
    }
    return { penalties, directives };
}
test("压力：10万处罚 + 10万指令，2万次撤销与10万次查询", { timeout: 120_000 }, () => {
    const rand = mulberry32(991);
    const { penalties, directives } = buildDossier(rand);
    assert.equal(penalties.length, PENALTY_COUNT);
    assert.equal(directives.length, DIRECTIVE_COUNT);
    const h = new DisciplineHistory(PERIOD_START, PERIOD_END);
    h.load({ penalties, directives }); // 装载时间不计入耗时
    // 撤销顺序：先全部关键处罚，再随机背景处罚，共 20000 次不同处罚
    const revokeOrder = [];
    for (let i = 0; i < KEY_COUNT; i++)
        revokeOrder.push(`key${i}`);
    const bgIdx = Array.from({ length: BACKGROUND_COUNT }, (_, i) => i);
    for (let i = bgIdx.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [bgIdx[i], bgIdx[j]] = [bgIdx[j], bgIdx[i]];
    }
    for (let i = 0; i < REVOKE_COUNT - KEY_COUNT; i++)
        revokeOrder.push(`bg${bgIdx[i]}`);
    assert.equal(revokeOrder.length, REVOKE_COUNT);
    const rssBefore = process.memoryUsage().rss;
    const t0 = performance.now();
    let effectiveRevokes = 0;
    for (let r = 0; r < revokeOrder.length; r++) {
        const id = revokeOrder[r];
        // 每次撤销后查询 5 个时点；关键处罚固定查其覆盖段末，确保能观测变化
        const queryTimes = [];
        if (r < KEY_COUNT) {
            queryTimes.push(r * 100 + 49);
        }
        while (queryTimes.length < QUERIES_PER_REVOKE) {
            queryTimes.push(PERIOD_START + Math.floor(rand() * (PERIOD_END - PERIOD_START)));
        }
        const before = queryTimes.map((t) => h.query(t));
        assert.equal(h.revokePenalty(id), true);
        const after = queryTimes.map((t) => h.query(t));
        if (before.some((b, i) => b !== after[i]))
            effectiveRevokes++;
    }
    const elapsedMs = performance.now() - t0;
    const rssAfter = process.memoryUsage().rss;
    const peakMiB = Math.max(rssBefore, rssAfter) / 1048576;
    console.log(`    [stress] ${REVOKE_COUNT} revokes + ${REVOKE_COUNT * QUERIES_PER_REVOKE} queries ` +
        `in ${elapsedMs.toFixed(0)} ms; effective revokes: ${effectiveRevokes}; ` +
        `rss: ${(rssBefore / 1048576).toFixed(0)} -> ${(rssAfter / 1048576).toFixed(0)} MiB`);
    assert.ok(elapsedMs <= 30_000, `took ${elapsedMs.toFixed(0)} ms, limit 30000 ms`);
    assert.ok(peakMiB <= 512, `memory ${peakMiB.toFixed(0)} MiB, limit 512 MiB`);
    assert.ok(effectiveRevokes >= 1000, `expected at least 1000 result-changing revokes, got ${effectiveRevokes}`);
    // 抽查：关键区撤销后，依赖链被重新判定为审查中（处分中指令失去前提）
    for (const i of [0, 1, 500, 1999]) {
        assert.equal(h.query(i * 100 + 45), S.Review, `key${i} region after revoke`);
    }
});
