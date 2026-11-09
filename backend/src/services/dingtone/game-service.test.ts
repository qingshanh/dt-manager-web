import assert from "node:assert/strict";
import test from "node:test";
import { checkMathEquality } from "./game-service.js";

test("checkMathEquality evaluates arithmetic equality correctly", () => {
  assert.equal(checkMathEquality("2+3=5"), 1);
  assert.equal(checkMathEquality("10-4=7"), 0);
  assert.equal(checkMathEquality("3*4=12"), 1);
  assert.equal(checkMathEquality("8/2=4"), 1);
  assert.equal(checkMathEquality("5>3"), 1);
  assert.equal(checkMathEquality("2>9"), 0);
  assert.equal(checkMathEquality("invalid"), 0);
});