import { test } from "node:test";
import assert from "node:assert/strict";
import { settle } from "../src/index.js";

test("skeleton loads", () => {
  assert.equal(typeof settle, "function");
});
