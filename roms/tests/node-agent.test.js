import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NodeRuntimeAdapter, RayLinkNode } from "../web/node/raylink-node.mjs";

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
      runtimeVersion: "1.13.14",
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
      runtimeVersion: "1.13.14",
      buildTags: ["with_quic"]
    }),
    runtimeAdapter: {
      async publish(task) {
        publications.push(task);
        return { runtimeVersion: "1.13.14", configPath: "/var/lib/raylink-node/sing-box/config.json" };
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
    status: "succeeded",
    result: {
      runtimeVersion: "1.13.14",
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
    status: "failed",
    result: { error: "sing-box check failed" }
  });
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
      return { stdout: "sing-box version 1.13.14\n", stderr: "" };
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
      return { stdout: "sing-box version 1.13.14\n", stderr: "" };
    }
  });

  await assert.rejects(
    adapter.publish({ configText: "{\"version\":\"candidate\"}", version: 1, checksum: "sha256:candidate" }),
    /service failed to start/
  );
  await assert.rejects(access(join(directory, "config.json")), { code: "ENOENT" });
});
