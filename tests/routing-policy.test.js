import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ROUTING_POLICY,
  normalizeRoutingPolicy,
  routingDecisionForDomain
} from "../server/routing/policy.js";

test("routing policy normalizes and orders supported custom rules", () => {
  const policy = normalizeRoutingPolicy({
    mode: "smart",
    rules: [
      {
        id: "proxy-docs",
        match: "domain_suffix",
        value: "*.Docs.Example.",
        action: "proxy",
        dns: "auto",
        priority: 20,
        enabled: true,
        note: "documentation"
      },
      {
        id: "direct-api",
        match: "domain",
        value: "API.Example",
        action: "direct",
        dns: "domestic",
        priority: 10,
        enabled: true
      },
      {
        id: "disabled",
        match: "ip_cidr",
        value: "192.0.2.0/24",
        action: "block",
        priority: 1,
        enabled: false
      }
    ]
  });

  assert.equal(policy.mode, "smart");
  assert.deepEqual(policy.rules.map((rule) => rule.id), [
    "disabled",
    "direct-api",
    "proxy-docs"
  ]);
  assert.equal(policy.rules[1].value, "api.example");
  assert.equal(policy.rules[2].value, "docs.example");
  assert.equal(policy.rules[2].dns, "remote");
});

test("routing policy rejects unsafe or invalid rule values", () => {
  assert.throws(
    () => normalizeRoutingPolicy({
      rules: [{ match: "domain_suffix", value: "https://example.com/path", action: "direct" }]
    }),
    (error) => error.code === "INVALID_ROUTING_RULE"
  );
  assert.throws(
    () => normalizeRoutingPolicy({
      rules: [{ match: "ip_cidr", value: "192.0.2.1/99", action: "proxy" }]
    }),
    (error) => error.code === "INVALID_ROUTING_RULE"
  );
  assert.throws(
    () => normalizeRoutingPolicy({ mode: "javascript:alert(1)" }),
    (error) => error.code === "INVALID_ROUTING_MODE"
  );
});

test("smart routing explains explicit, AI, China fallback and unknown decisions", () => {
  const policy = normalizeRoutingPolicy({
    rules: [
      {
        match: "domain_suffix",
        value: "corp.example",
        action: "direct",
        priority: 10
      }
    ]
  });

  assert.deepEqual(
    routingDecisionForDomain(policy, "app.corp.example"),
    {
      action: "direct",
      source: "custom",
      ruleId: "rule-1",
      dns: "domestic"
    }
  );
  assert.equal(routingDecisionForDomain(policy, "chatgpt.com").action, "ai");
  assert.equal(routingDecisionForDomain(policy, "service.cn").action, "direct");
  assert.deepEqual(
    routingDecisionForDomain(policy, "unknown.example"),
    {
      action: "resolve",
      source: "geoip",
      ruleId: null,
      dns: "domestic"
    }
  );
});

test("default policy is immutable smart routing with no custom rules", () => {
  assert.equal(DEFAULT_ROUTING_POLICY.mode, "smart");
  assert.equal(DEFAULT_ROUTING_POLICY.unknownDomain, "resolve-geoip");
  assert.deepEqual(DEFAULT_ROUTING_POLICY.rules, []);
  assert.ok(Object.isFrozen(DEFAULT_ROUTING_POLICY));
});
