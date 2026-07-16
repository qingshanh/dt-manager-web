import assert from "node:assert/strict";
import test from "node:test";
import { buildSameVariantDuplicateAccountWhere } from "./account-duplicate-scope.js";

test("duplicate account queries are scoped to the same administrator and app variant", () => {
  const where = buildSameVariantDuplicateAccountWhere({
    id: 17,
    adminId: 3,
    appVariant: "dingtone",
    dtUserId: "shared-user",
  });

  assert.deepEqual(where, {
    adminId: 3,
    appVariant: "dingtone",
    dtUserId: "shared-user",
    NOT: { id: 17 },
  });
  assert.notEqual(where.appVariant, "dingdong");
});
