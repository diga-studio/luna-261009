import { test } from "node:test";
import * as assert from "node:assert/strict";
import { SmsScheduler } from "../src/index";

// 2026-03-07T13:00:00Z is 08:00 EST (window opens). US DST springs forward
// on 2026-03-08, so 24h later is 08:00 EDT -- still inside the window.
test("7 messages across DST switch: 6 immediate, 7th exactly 24h later", () => {
  const scheduler = new SmsScheduler("2026-03-07T00:00:00Z");
  for (let i = 1; i <= 7; i++) {
    scheduler.submit({
      contactId: "contact-dst",
      templateId: "tpl-" + i,
      scheduledAt: "2026-03-07T13:00:00Z",
      outcomes: [true],
    });
  }

  scheduler.advance("2026-03-10T00:00:00Z");

  const attempts = scheduler.getAttempts();
  assert.equal(attempts.length, 7);
  for (let i = 0; i < 6; i++) {
    assert.equal(attempts[i].attemptedAt, "2026-03-07T13:00:00.000Z");
    assert.equal(attempts[i].messageId, i + 1);
    assert.equal(attempts[i].success, true);
  }
  // The 7th attempt must wait the full 24h of actual elapsed UTC time;
  // the DST switch must not let it fire earlier.
  assert.equal(attempts[6].attemptedAt, "2026-03-08T13:00:00.000Z");
  assert.equal(attempts[6].messageId, 7);

  const messages = scheduler.getMessages();
  for (const m of messages) {
    assert.equal(m.status, "delivered");
  }
});
