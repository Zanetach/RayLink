import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttp2Server } from "node:http2";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { RayLinkStore } from "../server/database.js";
import {
  queryV2RayUserStats,
  V2RayStatsCollector
} from "../server/usage/v2ray-stats.js";

const execFile = promisify(execFileCallback);

function testVarint(value) {
  let remaining = value;
  const bytes = [];
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

test("V2Ray Stats client reads the official gRPC QueryStats wire response", async (t) => {
  const server = createHttp2Server();
  t.after(() => server.close());
  server.on("stream", (stream, headers) => {
    assert.equal(
      headers[":path"],
      "/v2ray.core.app.stats.command.StatsService/QueryStats"
    );
    const name = Buffer.from("user>>>wire@example.com>>>traffic>>>uplink");
    const stat = Buffer.concat([
      Buffer.from([0x0a]),
      testVarint(name.length),
      name,
      Buffer.from([0x10]),
      testVarint(2_048)
    ]);
    const response = Buffer.concat([Buffer.from([0x0a]), testVarint(stat.length), stat]);
    const frame = Buffer.alloc(5);
    frame.writeUInt32BE(response.length, 1);
    stream.respond({
      ":status": 200,
      "content-type": "application/grpc",
      "grpc-status": "0"
    });
    stream.end(Buffer.concat([frame, response]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  assert.deepEqual(await queryV2RayUserStats({
    endpoint: `http://127.0.0.1:${port}`
  }), [{
    name: "user>>>wire@example.com>>>traffic>>>uplink",
    value: 2_048
  }]);
});

test("an unavailable V2Ray stats port rejects the query without crashing RayLink", async () => {
  const server = createTcpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const moduleUrl = new URL("../server/usage/v2ray-stats.js", import.meta.url).href;
  const script = `
    import { queryV2RayUserStats } from ${JSON.stringify(moduleUrl)};
    try {
      await queryV2RayUserStats({
        endpoint: ${JSON.stringify(`http://127.0.0.1:${port}`)},
        timeoutMs: 250
      });
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(error.code || error.message);
    }
  `;

  const result = await execFile(process.execPath, ["--input-type=module", "-e", script]);

  assert.match(result.stdout, /ECONNREFUSED|ERR_HTTP2_STREAM_CANCEL|V2Ray Stats/);
});

test("V2Ray Stats collector exposes cumulative per-user uplink and downlink counters", async () => {
  const collector = new V2RayStatsCollector({
    query: async () => [
      { name: "user>>>user@example.com>>>traffic>>>downlink", value: 8192 },
      { name: "user>>>user@example.com>>>traffic>>>uplink", value: 2048 },
      { name: "outbound>>>direct>>>traffic>>>uplink", value: 999 }
    ],
    runtimeInstanceProvider: async () => "invocation-1",
    clock: () => new Date("2026-07-26T10:00:00.000Z"),
    sampleId: () => "sample-0001"
  });

  assert.deepEqual(await collector.collect(), {
    sampleId: "sample-0001",
    runtimeInstanceId: "invocation-1",
    observedAt: "2026-07-26T10:00:00.000Z",
    users: [{
      name: "user@example.com",
      uplinkBytes: 2048,
      downlinkBytes: 8192
    }]
  });
});

test("usage snapshots are idempotent, persist byte deltas and survive Runtime restarts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RayLinkStore({
    dbPath: join(directory, "raylink.db"),
    adminUsername: "admin",
    adminPassword: "Admin@2026",
    seedDemoData: false,
    clock: () => new Date("2026-07-26T10:03:00.000Z")
  });
  t.after(() => store.close());
  const user = store.createUser({
    name: "Metered User",
    email: "metered@example.com",
    password: "password-123",
    portalStatus: "active",
    state: "active",
    quotaGb: 1,
    nodeScope: ["all"],
    clientFormats: ["sing-box"],
    expiresAt: "2027-01-01"
  });

  const first = store.recordUsageSnapshot("local", {
    sampleId: "sample-0001",
    runtimeInstanceId: "runtime-a",
    observedAt: "2026-07-26T10:00:00.000Z",
    users: [{ name: user.email, uplinkBytes: 100, downlinkBytes: 900 }]
  });
  const duplicate = store.recordUsageSnapshot("local", {
    sampleId: "sample-0001",
    runtimeInstanceId: "runtime-a",
    observedAt: "2026-07-26T10:00:00.000Z",
    users: [{ name: user.email, uplinkBytes: 100, downlinkBytes: 900 }]
  });
  const cumulative = store.recordUsageSnapshot("local", {
    sampleId: "sample-0002",
    runtimeInstanceId: "runtime-a",
    observedAt: "2026-07-26T10:01:00.000Z",
    users: [{ name: user.email, uplinkBytes: 150, downlinkBytes: 1_050 }]
  });
  const stale = store.recordUsageSnapshot("local", {
    sampleId: "sample-stale",
    runtimeInstanceId: "runtime-a",
    observedAt: "2026-07-26T10:01:30.000Z",
    users: [{ name: user.email, uplinkBytes: 125, downlinkBytes: 1_000 }]
  });
  const afterStale = store.recordUsageSnapshot("local", {
    sampleId: "sample-after-stale",
    runtimeInstanceId: "runtime-a",
    observedAt: "2026-07-26T10:01:45.000Z",
    users: [{ name: user.email, uplinkBytes: 175, downlinkBytes: 1_075 }]
  });
  const restarted = store.recordUsageSnapshot("local", {
    sampleId: "sample-0003",
    runtimeInstanceId: "runtime-b",
    observedAt: "2026-07-26T10:02:00.000Z",
    users: [{ name: user.email, uplinkBytes: 25, downlinkBytes: 75 }]
  });

  assert.equal(first.appliedBytes, 1_000);
  assert.equal(duplicate.duplicate, true);
  assert.equal(cumulative.appliedBytes, 200);
  assert.equal(stale.appliedBytes, 0);
  assert.equal(afterStale.appliedBytes, 50);
  assert.equal(restarted.appliedBytes, 100);
  assert.equal(Math.round(store.getUser(user.id).usedGb * 1024 ** 3), 1_350);
});
