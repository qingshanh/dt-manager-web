import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../frontend/src/pages/AccountDetail.tsx", import.meta.url), "utf8");

test("account detail page does not fetch phone countries during initial page load", () => {
  assert.doesNotMatch(source, /fetchAccount\(\);\s*fetchPhones\(\);\s*fetchPhoneCountries\(\);/);
  assert.match(source, /const handleImportDirectSession = async \(\) => \{[\s\S]*?await fetchPhoneCountries\(\);/);
  assert.match(source, /const handleRequestNumber = async \(\) => \{\s*const countries = await fetchPhoneCountries\(\);/);
});
