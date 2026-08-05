import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const webRoot = new URL("../web/", import.meta.url);

test("strategy workspace exposes simple modes, custom rules and explainable diagnostics", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("index.html", webRoot), "utf8"),
    readFile(new URL("app.js", webRoot), "utf8")
  ]);

  assert.match(html, /id="routing-mode-form"/);
  assert.match(html, /value="smart"/);
  assert.match(html, /value="global-proxy"/);
  assert.match(html, /value="direct"/);
  assert.match(html, /id="routing-rule-form"/);
  assert.match(html, /id="routing-diagnose-form"/);
  assert.match(script, /\/api\/settings\/routing/);
  assert.match(script, /\/api\/routing\/diagnose/);
});
