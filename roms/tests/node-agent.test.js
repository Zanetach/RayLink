import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  NodeRuntimeAdapter,
  NodeTelemetryCollector,
  RayLinkNode
} from "../web/node/raylink-node.mjs";

function jsonResponse(body, status = 200) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "content-type": "application/json" }
  });
}

test("RayLink Node enrolls once and persists its node credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-enroll-"));
  const statePath = join(directory, "node.json");
  const requests = [];
  const node = new RayLinkNode({
    serverUrl: "https://panel.example.com",
    enrollmentToken: "one-time-token",
    statePath,
    metadataProvider: async () => ({
      hostname: "fra-vps-02",
      platform: "linux",
      architecture: "x64",
      agentVersion: "0.1.0",
      runtimeVersion: "1.13.12",
      buildTags: ["with_quic"]
    }),
    fetchFn: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({ hostId: "host-fra", nodeSecret: "node-secret" }, 201);
    }
  });

  const state = await node.ensureEnrolled();

  assert.deepEqual(state, { hostId: "host-fra", nodeSecret: "node-secret" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://panel.example.com/api/node/enroll");
  assert.equal(JSON.parse(requests[0].init.body).hostname, "fra-vps-02");
  assert.deepEqual(
    JSON.parse(await readFile(statePath, "utf8")),
    { hostId: "host-fra", nodeSecret: "node-secret" }
  );

  await node.ensureEnrolled();
  assert.equal(requests.length, 1);
});

test("RayLink Node heartbeats, applies the next config and reports success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-publish-"));
  const statePath = join(directory, "node.json");
  const calls = [];
  const publications = [];
  const responses = [
    jsonResponse({ hostId: "host-fra", nodeSecret: "node-secret" }, 201),
    jsonResponse({ ok: true }),
    jsonResponse({
      id: "task-1",
      kind: "publish-config",
      attempt: 1,
      payload: {
        version: 4,
        checksum: "sha256:config",
        configText: "{\"log\":{\"level\":\"info\"}}"
      }
    }),
    jsonResponse({ ok: true })
  ];
  const node = new RayLinkNode({
    serverUrl: "https://panel.example.com/",
    enrollmentToken: "one-time-token",
    statePath,
    metadataProvider: async () => ({
      hostname: "fra-vps-02",
      platform: "linux",
      architecture: "x64",
      agentVersion: "0.1.0",
      runtimeVersion: "1.13.12",
      buildTags: ["with_quic"]
    }),
    runtimeAdapter: {
      async publish(task) {
        publications.push(task);
        return { runtimeVersion: "1.13.12", configPath: "/var/lib/raylink-node/sing-box/config.json" };
      }
    },
    fetchFn: async (url, init = {}) => {
      calls.push({ url, init });
      return responses.shift();
    }
  });

  await node.pollOnce();

  assert.equal(publications.length, 1);
  assert.equal(publications[0].configText, "{\"log\":{\"level\":\"info\"}}");
  const heartbeat = calls.find((call) => call.url.endsWith("/api/node/heartbeat"));
  assert.equal(heartbeat.init.headers.authorization, "Bearer node-secret");
  assert.equal(heartbeat.init.headers["x-raylink-host-id"], "host-fra");
  const completion = calls.find((call) => call.url.endsWith("/api/node/tasks/task-1/complete"));
  assert.deepEqual(JSON.parse(completion.init.body), {
    attempt: 1,
    status: "succeeded",
    result: {
      runtimeVersion: "1.13.12",
      configPath: "/var/lib/raylink-node/sing-box/config.json"
    }
  });
});

test("RayLink Node reports a failed task without swallowing the next poll cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-failure-"));
  const calls = [];
  const responses = [
    jsonResponse({ hostId: "host-fra", nodeSecret: "node-secret" }, 201),
    jsonResponse({ ok: true }),
    jsonResponse({
      id: "task-2",
      kind: "publish-config",
      attempt: 3,
      payload: { version: 5, checksum: "sha256:bad", configText: "{}" }
    }),
    jsonResponse({ ok: true })
  ];
  const node = new RayLinkNode({
    serverUrl: "https://panel.example.com",
    enrollmentToken: "one-time-token",
    statePath: join(directory, "node.json"),
    metadataProvider: async () => ({ hostname: "fra-vps-02" }),
    runtimeAdapter: {
      async publish() {
        throw new Error("sing-box check failed");
      }
    },
    fetchFn: async (url, init = {}) => {
      calls.push({ url, init });
      return responses.shift();
    }
  });

  await node.pollOnce();

  const completion = calls.find((call) => call.url.endsWith("/api/node/tasks/task-2/complete"));
  assert.deepEqual(JSON.parse(completion.init.body), {
    attempt: 3,
    status: "failed",
    result: { error: "sing-box check failed" }
  });
});

test("RayLink Node applies a runtime upgrade task and reports the new version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-upgrade-task-"));
  const calls = [];
  const upgrades = [];
  const responses = [
    jsonResponse({ hostId: "host-fra", nodeSecret: "node-secret" }, 201),
    jsonResponse({ ok: true }),
    jsonResponse({
      id: "task-upgrade-1",
      kind: "upgrade-runtime",
      attempt: 1,
      payload: { targetVersion: "1.13.13" }
    }),
    jsonResponse({ ok: true })
  ];
  const node = new RayLinkNode({
    serverUrl: "https://panel.example.com",
    enrollmentToken: "one-time-token",
    statePath: join(directory, "node.json"),
    metadataProvider: async () => ({ hostname: "fra-vps-02" }),
    runtimeAdapter: {
      async upgrade(task) {
        upgrades.push(task);
        return { runtimeVersion: task.targetVersion, rolledBack: false };
      }
    },
    fetchFn: async (url, init = {}) => {
      calls.push({ url, init });
      return responses.shift();
    }
  });

  await node.pollOnce();

  assert.deepEqual(upgrades, [{ targetVersion: "1.13.13" }]);
  const completion = calls.find((call) => call.url.endsWith("/api/node/tasks/task-upgrade-1/complete"));
  assert.deepEqual(JSON.parse(completion.init.body), {
    attempt: 1,
    status: "succeeded",
    result: { runtimeVersion: "1.13.13", rolledBack: false }
  });
});

test("RayLink Node reports an automatic Runtime rollback to the control plane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-upgrade-report-"));
  const calls = [];
  const responses = [
    jsonResponse({ hostId: "host-fra", nodeSecret: "node-secret" }, 201),
    jsonResponse({ ok: true }),
    jsonResponse({
      id: "task-upgrade-failed",
      kind: "upgrade-runtime",
      attempt: 1,
      payload: { targetVersion: "1.13.13" }
    }),
    jsonResponse({ ok: true })
  ];
  const node = new RayLinkNode({
    serverUrl: "https://panel.example.com",
    enrollmentToken: "one-time-token",
    statePath: join(directory, "node.json"),
    metadataProvider: async () => ({ hostname: "fra-vps-02" }),
    runtimeAdapter: {
      async upgrade() {
        const error = new Error("candidate failed health window");
        error.previousVersion = "1.13.12";
        error.rolledBack = true;
        throw error;
      }
    },
    fetchFn: async (url, init = {}) => {
      calls.push({ url, init });
      return responses.shift();
    }
  });

  await node.pollOnce();

  const completion = calls.find(
    (call) => call.url.endsWith("/api/node/tasks/task-upgrade-failed/complete")
  );
  assert.deepEqual(JSON.parse(completion.init.body), {
    attempt: 1,
    status: "failed",
    result: {
      error: "candidate failed health window",
      previousVersion: "1.13.12",
      rolledBack: true
    }
  });
});

test("node runtime upgrade rolls the binary back when the new build rejects the active config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-upgrade-rollback-"));
  const binaryPath = join(directory, "sing-box");
  const configPath = join(directory, "config.json");
  await writeFile(binaryPath, "previous-binary");
  await writeFile(configPath, "{}");
  let version = "1.13.12";
  let restarts = 0;
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    binaryPath,
    healthCheckDelayMs: 0,
    commandRunner: async (command, args) => {
      if (command === "sh") {
        version = args[1].match(/--version\s+(\d+\.\d+\.\d+)/)?.[1] || version;
        await writeFile(binaryPath, "broken-binary");
        return { stdout: "", stderr: "" };
      }
      if (command === binaryPath && args[0] === "version") {
        return { stdout: `sing-box version ${version}\n`, stderr: "" };
      }
      if (command === binaryPath && args[0] === "check") throw new Error("candidate rejected config");
      if (command === "systemctl" && args[0] === "restart") {
        restarts += 1;
        return { stdout: "", stderr: "" };
      }
      return { stdout: "active\n", stderr: "" };
    }
  });

  await assert.rejects(adapter.upgrade({ targetVersion: "1.13.13" }), /已回滚/);
  assert.equal(await readFile(binaryPath, "utf8"), "previous-binary");
  assert.equal(restarts, 1);
});

test("node runtime refuses an upgrade before touching a Host without an active config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-upgrade-unconfigured-"));
  const binaryPath = join(directory, "sing-box");
  await writeFile(binaryPath, "previous-binary");
  let installCalls = 0;
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    binaryPath,
    healthCheckDelayMs: 0,
    commandRunner: async (command, args) => {
      if (command === "sh") installCalls += 1;
      if (command === binaryPath && args[0] === "version") {
        return { stdout: "sing-box version 1.13.12\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }
  });

  await assert.rejects(
    adapter.upgrade({ targetVersion: "1.13.13" }),
    /没有活动配置/
  );
  assert.equal(installCalls, 0);
});

test("node telemetry reports interval CPU, memory, network and service health", async () => {
  const samples = [
    {
      cpu: { idle: 4_000, total: 10_000 },
      memoryUsedBytes: 2_000,
      memoryTotalBytes: 8_000,
      networkRxBytes: 10_000,
      networkTxBytes: 4_000
    },
    {
      cpu: { idle: 4_200, total: 11_000 },
      memoryUsedBytes: 2_500,
      memoryTotalBytes: 8_000,
      networkRxBytes: 1_010_000,
      networkTxBytes: 504_000
    }
  ];
  const timestamps = [1_000, 2_000];
  const collector = new NodeTelemetryCollector({
    sampleProvider: async () => samples.shift(),
    serviceProvider: async () => "running",
    clock: () => timestamps.shift()
  });

  const initial = await collector.collect();
  const current = await collector.collect();

  assert.equal(initial.networkRxBps, 0);
  assert.equal(current.cpuPercent, 80);
  assert.equal(current.memoryUsedBytes, 2_500);
  assert.equal(current.memoryTotalBytes, 8_000);
  assert.equal(current.networkRxBps, 8_000_000);
  assert.equal(current.networkTxBps, 4_000_000);
  assert.equal(current.serviceStatus, "running");
});

test("node runtime restores the previous config when systemd rejects a publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-rollback-"));
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "config.json");
  await writeFile(configPath, "{\"version\":\"previous\"}\n");
  const commands = [];
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    commandRunner: async (command, args) => {
      commands.push([command, ...args]);
      if (command === "systemctl" && commands.filter(([name]) => name === "systemctl").length === 1) {
        throw new Error("service failed to start");
      }
      return { stdout: "sing-box version 1.13.12\n", stderr: "" };
    }
  });

  await assert.rejects(
    adapter.publish({ configText: "{\"version\":\"candidate\"}", version: 2, checksum: "sha256:candidate" }),
    /service failed to start/
  );
  assert.equal(await readFile(configPath, "utf8"), "{\"version\":\"previous\"}\n");
  assert.equal(commands.filter(([command]) => command === "systemctl").length, 2);
});

test("node runtime removes a first config when the service cannot start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-first-failure-"));
  const adapter = new NodeRuntimeAdapter({
    dataDir: directory,
    commandRunner: async (command) => {
      if (command === "systemctl") throw new Error("service failed to start");
      return { stdout: "sing-box version 1.13.12\n", stderr: "" };
    }
  });

  await assert.rejects(
    adapter.publish({ configText: "{\"version\":\"candidate\"}", version: 1, checksum: "sha256:candidate" }),
    /service failed to start/
  );
  await assert.rejects(access(join(directory, "config.json")), { code: "ENOENT" });
});
