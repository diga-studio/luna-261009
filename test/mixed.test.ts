import { test } from "node:test";
import * as assert from "node:assert/strict";
import { SmsScheduler } from "../src/index";

const START = "2026-01-10T00:00:00Z"; // Saturday, EST (UTC-5) all scenario long
const END = "2026-01-12T00:00:00Z";

function buildScheduler(): SmsScheduler {
  const s = new SmsScheduler(START);
  // C1: retry chain 60s/120s, then a same-template message that must wait
  // 4h after M1's first attempt (dedup), competing for the contact quota.
  s.submit({ contactId: "C1", templateId: "T1", scheduledAt: "2026-01-10T14:00:00Z",
    outcomes: [false, false, true] }); // id 1
  s.submit({ contactId: "C1", templateId: "T1", scheduledAt: "2026-01-10T14:30:00Z",
    outcomes: [true] }); // id 2
  // C2: retry within the day, an exhausted message, and one pushed out of
  // the quiet window (22:30 local) to next morning 08:00 local.
  s.submit({ contactId: "C2", templateId: "T1", scheduledAt: "2026-01-10T23:30:00Z",
    outcomes: [false, true] }); // id 3
  s.submit({ contactId: "C2", templateId: "T2", scheduledAt: "2026-01-11T01:30:00Z",
    outcomes: [false, false, false] }); // id 4
  s.submit({ contactId: "C2", templateId: "T3", scheduledAt: "2026-01-11T03:30:00Z",
    outcomes: [true] }); // id 5
  // C3: five failures at the same instant plus a sixth message 30s later
  // fill the rolling-24h quota; the retries must wait a full 24h.
  s.submit({ contactId: "C3", templateId: "A", scheduledAt: "2026-01-10T14:00:00Z",
    outcomes: [false, true] }); // id 6
  s.submit({ contactId: "C3", templateId: "B", scheduledAt: "2026-01-10T14:00:00Z",
    outcomes: [false, true] }); // id 7
  s.submit({ contactId: "C3", templateId: "C", scheduledAt: "2026-01-10T14:00:00Z",
    outcomes: [false, true] }); // id 8
  s.submit({ contactId: "C3", templateId: "D", scheduledAt: "2026-01-10T14:00:00Z",
    outcomes: [false, true] }); // id 9
  s.submit({ contactId: "C3", templateId: "E", scheduledAt: "2026-01-10T14:00:00Z",
    outcomes: [false, true] }); // id 10
  s.submit({ contactId: "C3", templateId: "F", scheduledAt: "2026-01-10T14:00:30Z",
    outcomes: [true] }); // id 11
  return s;
}

// Expected attempt log, computed independently from the business rules.
const EXPECTED_ATTEMPTS: Array<[number, number, string, boolean]> = [
  // [messageId, attemptNumber, attemptedAt, success]
  [1, 1, "2026-01-10T14:00:00.000Z", false],
  [6, 1, "2026-01-10T14:00:00.000Z", false],
  [7, 1, "2026-01-10T14:00:00.000Z", false],
  [8, 1, "2026-01-10T14:00:00.000Z", false],
  [9, 1, "2026-01-10T14:00:00.000Z", false],
  [10, 1, "2026-01-10T14:00:00.000Z", false],
  // 6th C3 attempt inside the rolling 24h; quota now full.
  [11, 1, "2026-01-10T14:00:30.000Z", true],
  // C1 retries: +60s then +120s from the previous actual attempt.
  [1, 2, "2026-01-10T14:01:00.000Z", false],
  [1, 3, "2026-01-10T14:03:00.000Z", true],
  // Same contact+template dedup: 4h after message 1's first attempt.
  [2, 1, "2026-01-10T18:00:00.000Z", true],
  [3, 1, "2026-01-10T23:30:00.000Z", false],
  [3, 2, "2026-01-10T23:31:00.000Z", true],
  [4, 1, "2026-01-11T01:30:00.000Z", false],
  [4, 2, "2026-01-11T01:31:00.000Z", false],
  [4, 3, "2026-01-11T01:33:00.000Z", false], // exhausted
  // 22:30 local is quiet; pushed to 08:00 local next day (13:00Z).
  [5, 1, "2026-01-11T13:00:00.000Z", true],
  // C3 retries were quota-blocked until the first 5 attempts aged out.
  [6, 2, "2026-01-11T14:00:00.000Z", true],
  [7, 2, "2026-01-11T14:00:00.000Z", true],
  [8, 2, "2026-01-11T14:00:00.000Z", true],
  [9, 2, "2026-01-11T14:00:00.000Z", true],
  [10, 2, "2026-01-11T14:00:00.000Z", true],
];

const EXPECTED_STATUSES: { [id: number]: string } = {
  1: "delivered", 2: "delivered", 3: "delivered", 4: "exhausted",
  5: "delivered", 6: "delivered", 7: "delivered", 8: "delivered",
  9: "delivered", 10: "delivered", 11: "delivered",
};

function assertExpected(s: SmsScheduler): void {
  const attempts = s.getAttempts();
  assert.equal(attempts.length, EXPECTED_ATTEMPTS.length);
  for (let i = 0; i < EXPECTED_ATTEMPTS.length; i++) {
    const [messageId, attemptNumber, attemptedAt, success] = EXPECTED_ATTEMPTS[i];
    assert.equal(attempts[i].messageId, messageId, "attempt " + i + " messageId");
    assert.equal(attempts[i].attemptNumber, attemptNumber, "attempt " + i + " number");
    assert.equal(attempts[i].attemptedAt, attemptedAt, "attempt " + i + " time");
    assert.equal(attempts[i].success, success, "attempt " + i + " success");
  }
  for (const m of s.getMessages()) {
    assert.equal(m.status, EXPECTED_STATUSES[m.messageId],
      "status of message " + m.messageId);
  }
}

test("mixed scenario matches independently computed schedule", () => {
  const s = buildScheduler();
  s.advance(END);
  assertExpected(s);
  assert.equal(s.now(), "2026-01-12T00:00:00.000Z");
});

test("segmented advance yields identical results to a single advance", () => {
  const single = buildScheduler();
  single.advance(END);

  const segmented = buildScheduler();
  const splits = [
    "2026-01-10T14:00:30Z",
    "2026-01-10T18:00:00Z",
    "2026-01-10T23:31:00Z",
    "2026-01-11T01:33:00Z",
    "2026-01-11T13:00:00Z",
    END,
  ];
  for (const t of splits) segmented.advance(t);

  assert.deepEqual(segmented.getAttempts(), single.getAttempts());
  assert.deepEqual(segmented.getMessages(), single.getMessages());

  // Finer segmentation (hour by hour) must also match.
  const hourly = buildScheduler();
  let t = Date.parse(START);
  const end = Date.parse(END);
  while (t < end) {
    t += 60 * 60 * 1000;
    hourly.advance(new Date(t).toISOString());
  }
  assert.deepEqual(hourly.getAttempts(), single.getAttempts());
  assert.deepEqual(hourly.getMessages(), single.getMessages());
});

test("input validation", () => {
  const s = new SmsScheduler(START);
  assert.throws(() => s.submit({
    contactId: "", templateId: "T", scheduledAt: "2026-01-10T14:00:00Z",
    outcomes: [true],
  }));
  assert.throws(() => s.submit({
    contactId: "C", templateId: "T", scheduledAt: "not-a-date",
    outcomes: [true],
  }));
  assert.throws(() => s.submit({
    contactId: "C", templateId: "T", scheduledAt: "2026-01-10T14:00:00Z",
    outcomes: [],
  }));
  assert.throws(() => s.submit({
    contactId: "C", templateId: "T", scheduledAt: "2026-01-10T14:00:00Z",
    outcomes: [true, true, true, true],
  }));
  assert.throws(() => s.advance("2026-01-09T00:00:00Z"));
});
