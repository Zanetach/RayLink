import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseRoutingDomain } from "../server/routing/diagnostics.js";

test("routing diagnostics resolves an unknown domain and explains a China IP decision", async () => {
  const result = await diagnoseRoutingDomain({
    domain: "service.example",
    policy: { mode: "smart", rules: [] },
    lookup: async () => [{ address: "192.0.2.20", family: 4 }],
    matchRuleSet: async (filename, value) => (
      filename === "geoip-cn.srs" && value === "192.0.2.20"
    )
  });

  assert.deepEqual(result.addresses, [{ address: "192.0.2.20", family: 4 }]);
  assert.equal(result.action, "direct");
  assert.equal(result.outbound, "direct");
  assert.equal(result.source, "geoip-cn");
  assert.match(result.explanation, /IP/);
});

test("routing diagnostics keeps mixed or non-China answers on the proxy", async () => {
  const result = await diagnoseRoutingDomain({
    domain: "mixed.example",
    policy: { mode: "smart", rules: [] },
    lookup: async () => [
      { address: "192.0.2.20", family: 4 },
      { address: "203.0.113.30", family: 4 }
    ],
    matchRuleSet: async (filename, value) => (
      filename === "geoip-cn.srs" && value === "192.0.2.20"
    )
  });

  assert.equal(result.action, "proxy");
  assert.equal(result.outbound, "raylink-auto");
  assert.equal(result.source, "geoip-mixed");
});

test("routing diagnostics honors an explicit rule without DNS lookup", async () => {
  let lookups = 0;
  const result = await diagnoseRoutingDomain({
    domain: "app.work.example",
    policy: {
      mode: "smart",
      rules: [{
        match: "domain_suffix",
        value: "work.example",
        action: "direct"
      }]
    },
    lookup: async () => {
      lookups += 1;
      return [];
    }
  });

  assert.equal(result.source, "custom");
  assert.equal(result.action, "direct");
  assert.equal(lookups, 0);
});

test("routing diagnostics reports a conservative fallback when rule-set matching is unavailable", async () => {
  const result = await diagnoseRoutingDomain({
    domain: "unknown.example",
    policy: { mode: "smart", rules: [] },
    lookup: async () => [{ address: "192.0.2.20", family: 4 }],
    matchRuleSet: async () => null
  });

  assert.equal(result.action, "proxy");
  assert.equal(result.source, "fallback");
});
