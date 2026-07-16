import assert from "node:assert/strict";
import test from "node:test";
import { BoundedBuffer } from "./bounded-buffer.js";

test("bounded buffer keeps only the newest values and counts evictions", () => {
  const buffer = new BoundedBuffer<number>(3);

  buffer.push(1);
  buffer.push(2);
  buffer.push(3);
  buffer.push(4);

  assert.deepEqual(buffer.values(), [2, 3, 4]);
  assert.equal(buffer.totalAdded, 4);
  assert.equal(buffer.dropped, 1);
});

test("bounded buffer accepts batches without exceeding its capacity", () => {
  const buffer = new BoundedBuffer<number>(2);

  buffer.pushMany([1, 2, 3, 4]);

  assert.deepEqual(buffer.values(), [3, 4]);
  assert.equal(buffer.totalAdded, 4);
  assert.equal(buffer.dropped, 2);
});
