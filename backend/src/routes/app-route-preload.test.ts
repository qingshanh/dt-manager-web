import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../frontend/src/App.tsx", import.meta.url), "utf8");

test("authenticated app preloads the dashboard and account list route chunks", () => {
  assert.match(source, /function preloadPrimaryPages\(\)/);
  assert.match(source, /import\(["']\.\/pages\/Dashboard["']\)/);
  assert.match(source, /import\(["']\.\/pages\/AccountList["']\)/);
  assert.match(source, /if \(ready && token\)/);
  assert.match(source, /requestIdleCallback/);
});
test("cached authenticated sessions render before auth revalidation finishes", () => {
  assert.match(source, /const user = useAuthStore\(\(s\) => s\.user\)/);
  assert.match(source, /const \[ready, setReady\] = useState\(\(\) => Boolean\(useAuthStore\.getState\(\)\.token && useAuthStore\.getState\(\)\.user\)\)/);
  assert.match(source, /if \(token && user\) \{\s*setReady\(true\);\s*\}/);
  assert.match(source, /void checkAuth\(\)\.finally/);
});