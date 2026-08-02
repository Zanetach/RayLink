import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [adminSource, portalMarkup, portalSource] = await Promise.all([
  readFile(new URL("../web/app.js", import.meta.url), "utf8"),
  readFile(new URL("../web/portal.html", import.meta.url), "utf8"),
  readFile(new URL("../web/portal.js", import.meta.url), "utf8")
]);

test("admin and user subscription views expose the same four client choices", () => {
  for (const source of [adminSource, portalMarkup]) {
    assert.match(source, /Clash \/ Mihomo/);
    assert.match(source, /Egern 完整配置/);
    assert.match(source, /Egern 节点/);
    assert.match(source, /sing-box JSON/);
    assert.match(source, /subscription-client-action recommended/);
  }
});

test("user portal keeps full-profile and node-only Egern imports distinct", () => {
  assert.match(portalMarkup, /id="portal-import-egern"/);
  assert.match(portalMarkup, /id="portal-import-egern-nodes"/);
  assert.match(portalSource, /egern:\/profiles\/new/);
  assert.match(portalSource, /egern:\/subscriptions\/new/);
  assert.match(portalSource, /formatUrl\("egern-profile"\)/);
  assert.match(portalSource, /formatUrl\("egern"\)/);
});
