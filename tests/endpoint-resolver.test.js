import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EndpointResolver } from "../server/subscriptions/endpoint-resolver.js";

test("endpoint resolver caches healthy DNS answers until their TTL expires", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-endpoints-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = 1_000;
  let lookupCalls = 0;
  let probeCalls = 0;
  const resolver = new EndpointResolver({
    cachePath: join(dataDir, "endpoint-cache.json"),
    now: () => now,
    lookup: async () => {
      lookupCalls += 1;
      return [{
        address: lookupCalls === 1 ? "203.0.113.20" : "203.0.113.21",
        ttl: 60
      }];
    },
    probe: async ({ port }) => {
      probeCalls += 1;
      return port === 8388;
    }
  });
  const input = {
    hostname: "node.example.com",
    protocols: [{ type: "shadowsocks", port: 8388, enabled: true }],
    fallbackAddress: "203.0.113.10"
  };

  assert.deepEqual(await resolver.resolve(input), {
    address: "203.0.113.20",
    source: "dns"
  });
  assert.deepEqual(await resolver.resolve(input), {
    address: "203.0.113.20",
    source: "cache"
  });
  assert.equal(lookupCalls, 1);
  assert.equal(probeCalls, 1);

  now += 60_001;
  assert.deepEqual(await resolver.resolve(input), {
    address: "203.0.113.21",
    source: "dns"
  });
  assert.equal(lookupCalls, 2);
  assert.equal(probeCalls, 2);
});

test("endpoint resolver skips unhealthy DNS answers", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-endpoints-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const resolver = new EndpointResolver({
    cachePath: join(dataDir, "endpoint-cache.json"),
    lookup: async () => [
      { address: "203.0.113.20", ttl: 60 },
      { address: "203.0.113.21", ttl: 60 }
    ],
    probe: async ({ address }) => address === "203.0.113.21"
  });

  assert.deepEqual(await resolver.resolve({
    hostname: "node.example.com",
    protocols: [{ type: "naive", port: 8443, enabled: true }],
    fallbackAddress: "203.0.113.10"
  }), {
    address: "203.0.113.21",
    source: "dns"
  });
});

test("endpoint resolver probes every candidate and TCP port in one health window", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-endpoints-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const releases = [];
  let probeCalls = 0;
  const resolver = new EndpointResolver({
    cachePath: join(dataDir, "endpoint-cache.json"),
    lookup: async () => [
      { address: "203.0.113.20", ttl: 60 },
      { address: "203.0.113.21", ttl: 60 }
    ],
    probe: async ({ address, port }) => new Promise((resolve) => {
      probeCalls += 1;
      releases.push(() => resolve(address === "203.0.113.21" && port === 8443));
      if (releases.length === 4) queueMicrotask(() => releases.forEach((release) => release()));
    })
  });

  assert.deepEqual(await resolver.resolve({
    hostname: "node.example.com",
    protocols: [
      { type: "shadowsocks", port: 8388, enabled: true },
      { type: "naive", port: 8443, enabled: true }
    ],
    fallbackAddress: "203.0.113.10"
  }), {
    address: "203.0.113.21",
    source: "dns"
  });
  assert.equal(probeCalls, 4);
});

test("endpoint resolver reaches fallback within its trusted DNS deadline", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-endpoints-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const resolver = new EndpointResolver({
    cachePath: join(dataDir, "endpoint-cache.json"),
    lookupTimeoutMs: 10,
    lookup: async () => new Promise(() => {}),
    probe: async () => true
  });
  const startedAt = Date.now();

  assert.deepEqual(await resolver.resolve({
    hostname: "node.example.com",
    protocols: [{ type: "shadowsocks", port: 8388, enabled: true }],
    fallbackAddress: "203.0.113.10"
  }), {
    address: "203.0.113.10",
    source: "configured-fallback"
  });
  assert.ok(Date.now() - startedAt < 250);
});

test("endpoint resolver persists last-known-good and then uses the configured fallback", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-endpoints-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cachePath = join(dataDir, "endpoint-cache.json");
  const healthy = new EndpointResolver({
    cachePath,
    lookup: async () => [{ address: "203.0.113.20", ttl: 1 }],
    probe: async () => true,
    now: () => 1_000
  });
  await healthy.resolve({
    hostname: "node.example.com",
    protocols: [{ type: "trojan", port: 9443, enabled: true }],
    fallbackAddress: "203.0.113.10"
  });

  const unavailable = new EndpointResolver({
    cachePath,
    lookup: async () => {
      throw new Error("trusted DNS unavailable");
    },
    probe: async () => false,
    now: () => 10_000
  });
  assert.deepEqual(await unavailable.resolve({
    hostname: "node.example.com",
    protocols: [{ type: "trojan", port: 9443, enabled: true }],
    fallbackAddress: "203.0.113.10"
  }), {
    address: "203.0.113.20",
    source: "last-known-good"
  });

  assert.deepEqual(await unavailable.resolve({
    hostname: "new-node.example.com",
    protocols: [{ type: "trojan", port: 9443, enabled: true }],
    fallbackAddress: "203.0.113.10"
  }), {
    address: "203.0.113.10",
    source: "configured-fallback"
  });
});

test("endpoint resolver still serves a healthy DNS answer when persistence fails", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-endpoints-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const invalidDirectory = join(dataDir, "not-a-directory");
  await writeFile(invalidDirectory, "occupied");
  const resolver = new EndpointResolver({
    cachePath: join(invalidDirectory, "endpoint-cache.json"),
    lookup: async () => [{ address: "203.0.113.20", ttl: 60 }],
    probe: async () => true
  });

  assert.deepEqual(await resolver.resolve({
    hostname: "node.example.com",
    protocols: [{ type: "shadowsocks", port: 8388, enabled: true }]
  }), {
    address: "203.0.113.20",
    source: "dns"
  });
});
