import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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

test("routing policy renders during the post-login bootstrap", async () => {
  const script = await readFile(new URL("app.js", webRoot), "utf8");
  const helperStart = script.indexOf("function setText(");
  const policyStart = script.indexOf("const routingModeCopy");
  const policyEnd = script.indexOf("async function persistRoutingPolicy");

  assert.notEqual(helperStart, -1, "the shared text helper must be declared");
  assert.notEqual(policyStart, -1);
  assert.notEqual(policyEnd, -1);

  const nodes = new Map();
  const context = {
    controlPlane: { routingPolicy: { mode: "smart", rules: [] } },
    document: {
      querySelectorAll() {
        return [];
      },
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, { innerHTML: "", textContent: "" });
        return nodes.get(selector);
      }
    },
    escapeHtml: String
  };

  vm.runInNewContext(
    `${script.slice(helperStart, policyStart)}\n${script.slice(policyStart, policyEnd)}\nrenderRoutingPolicy();`,
    context
  );

  assert.equal(nodes.get("#routing-mode-title").textContent, "智能分流");
  assert.equal(nodes.get("#routing-rule-count").textContent, "0");
});
