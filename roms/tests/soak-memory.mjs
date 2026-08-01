import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
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
let clientAgent = null;

try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  clientAgent = new Agent({
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 50,
    scheduling: "lifo"
  });
  const requestBuffer = ({ path, method = "GET", headers = {}, body = "" }) => (
    new Promise((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1",
        port: address.port,
        path,
        method,
        headers: {
          ...headers,
          ...(body ? { "content-length": Buffer.byteLength(body) } : {})
        },
        agent: clientAgent
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks)
        }));
      });
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    })
  );
  const login = await requestBuffer({
    path: "/api/auth/login",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "Admin@2026" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers["set-cookie"][0].split(";")[0];

  const requestBatch = async (count) => {
    const responses = await Promise.all(Array.from({ length: count }, () => (
      requestBuffer({
        path: "/api/bootstrap",
        headers: { cookie }
      })
    )));
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.ok(response.body.length > 0);
    }
  };

  const stabilizedMemory = async () => {
    global.gc();
    await new Promise((resolve) => setTimeout(resolve, 250));
    global.gc();
    return process.memoryUsage();
  };

  for (let index = 0; index < 20; index += 1) await requestBatch(50);
  const baselineMemory = await stabilizedMemory();
  const baselineHandles = process._getActiveHandles().length;

  for (let index = 0; index < 30; index += 1) await requestBatch(50);
  const midpointMemory = await stabilizedMemory();
  for (let index = 0; index < 30; index += 1) await requestBatch(50);
  const finalMemory = await stabilizedMemory();
  const finalHandles = process._getActiveHandles().length;
  const heapGrowthBytes = finalMemory.heapUsed - baselineMemory.heapUsed;
  const rssGrowthBytes = finalMemory.rss - baselineMemory.rss;
  const tailRssGrowthBytes = finalMemory.rss - midpointMemory.rss;
  const externalGrowthBytes = finalMemory.external - baselineMemory.external;
  const report = {
    requests: 4_000,
    warmupRequests: 1_000,
    measuredRequests: 3_000,
    usersPerResponse: 6,
    baselineMemory,
    midpointMemory,
    finalMemory,
    growth: {
      heapUsedBytes: heapGrowthBytes,
      rssBytes: rssGrowthBytes,
      tailRssBytes: tailRssGrowthBytes,
      externalBytes: externalGrowthBytes,
      activeHandles: finalHandles - baselineHandles
    }
  };
  console.log(JSON.stringify(report));

  // RSS includes V8 JIT pages, SQLite native pages and allocator high-water
  // marks. Bound both the absolute process size and the post-warmup slope so a
  // genuine native leak cannot hide behind a looser startup allowance.
  assert.ok(
    heapGrowthBytes <= 16 * 1024 * 1024,
    `heap grew by ${(heapGrowthBytes / 1024 / 1024).toFixed(2)} MiB; limit is 16 MiB`
  );
  assert.ok(
    rssGrowthBytes <= 160 * 1024 * 1024,
    `RSS grew by ${(rssGrowthBytes / 1024 / 1024).toFixed(2)} MiB after warmup; high-water limit is 160 MiB`
  );
  assert.ok(
    tailRssGrowthBytes <= 32 * 1024 * 1024,
    `RSS kept growing by ${(tailRssGrowthBytes / 1024 / 1024).toFixed(2)} MiB in the final 1,500 requests; stable-tail limit is 32 MiB`
  );
  assert.ok(
    finalMemory.rss <= 512 * 1024 * 1024,
    `final RSS is ${(finalMemory.rss / 1024 / 1024).toFixed(2)} MiB; process ceiling is 512 MiB`
  );
  assert.ok(
    externalGrowthBytes <= 8 * 1024 * 1024,
    `external memory grew by ${(externalGrowthBytes / 1024 / 1024).toFixed(2)} MiB; limit is 8 MiB`
  );
  assert.ok(
    finalHandles <= baselineHandles + 8,
    `active handles grew from ${baselineHandles} to ${finalHandles}`
  );
} finally {
  clientAgent?.destroy();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
