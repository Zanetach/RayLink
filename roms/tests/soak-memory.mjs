import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRayLinkApp } from "../server/app.js";

if (typeof global.gc !== "function") {
  throw new Error("memory soak requires node --expose-gc");
}

const dataDir = await mkdtemp(join(tmpdir(), "raylink-memory-soak-"));
const runtimeAdapter = {
  activePath: join(dataDir, "sing-box", "config.json"),
  async status() {
    return {
      state: "running",
      mode: "dry-run",
      configPath: this.activePath,
      runtimeVersion: "1.13.14"
    };
  },
  async publish() {
    return this.status();
  }
};
const app = await createRayLinkApp({
  dataDir,
  adminUsername: "admin",
  adminPassword: "Admin@2026",
  publicOrigin: "http://127.0.0.1",
  runtimeMode: "dry-run",
  seedDemoData: true,
  runtimeAdapter,
  runtimeUpdateCheckIntervalMs: 0,
  telemetryIntervalMs: 60 * 60 * 1000,
  usageMeteringIntervalMs: 60 * 60 * 1000,
  entitlementReconcileIntervalMs: 60 * 60 * 1000,
  operationalMaintenanceIntervalMs: 60 * 60 * 1000,
  installer: {
    async status() {
      return {
        installed: true,
        version: "1.13.14",
        platform: "linux",
        architecture: "amd64",
        tags: ["with_v2ray_api"]
      };
    },
    async checkForUpdates() {
      return null;
    },
    releaseStatus() {
      return { status: "not-checked" };
    }
  },
  usageCollector: {
    async collect() {
      return {
        sampleId: "memory-soak-initial",
        runtimeInstanceId: "memory-soak-runtime",
        observedAt: new Date().toISOString(),
        users: []
      };
    }
  },
  ruleSetCache: {
    prepare: async () => {},
    available: () => false,
    get: async () => null
  }
});

try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "Admin@2026" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];

  const requestBatch = async (count) => {
    const responses = await Promise.all(Array.from({ length: count }, () => (
      fetch(`${baseUrl}/api/bootstrap`, { headers: { cookie } })
    )));
    for (const response of responses) {
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }
  };

  for (let index = 0; index < 10; index += 1) await requestBatch(50);
  global.gc();
  await new Promise((resolve) => setTimeout(resolve, 25));
  global.gc();
  const baselineMemory = process.memoryUsage();
  const baselineHandles = process._getActiveHandles().length;

  for (let index = 0; index < 60; index += 1) await requestBatch(50);
  global.gc();
  await new Promise((resolve) => setTimeout(resolve, 25));
  global.gc();
  const finalMemory = process.memoryUsage();
  const finalHandles = process._getActiveHandles().length;
  const heapGrowthBytes = finalMemory.heapUsed - baselineMemory.heapUsed;
  const rssGrowthBytes = finalMemory.rss - baselineMemory.rss;
  const externalGrowthBytes = finalMemory.external - baselineMemory.external;

  assert.ok(
    heapGrowthBytes <= 16 * 1024 * 1024,
    `heap grew by ${(heapGrowthBytes / 1024 / 1024).toFixed(2)} MiB; limit is 16 MiB`
  );
  assert.ok(
    rssGrowthBytes <= 64 * 1024 * 1024,
    `RSS grew by ${(rssGrowthBytes / 1024 / 1024).toFixed(2)} MiB; limit is 64 MiB`
  );
  assert.ok(
    externalGrowthBytes <= 8 * 1024 * 1024,
    `external memory grew by ${(externalGrowthBytes / 1024 / 1024).toFixed(2)} MiB; limit is 8 MiB`
  );
  assert.ok(
    finalHandles <= baselineHandles + 8,
    `active handles grew from ${baselineHandles} to ${finalHandles}`
  );
  console.log(JSON.stringify({
    requests: 3_500,
    usersPerResponse: 6,
    baselineMemory,
    finalMemory,
    growth: {
      heapUsedBytes: heapGrowthBytes,
      rssBytes: rssGrowthBytes,
      externalBytes: externalGrowthBytes,
      activeHandles: finalHandles - baselineHandles
    }
  }));
} finally {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
