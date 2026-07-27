import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RayLinkStore } from "../server/database.js";
import { RuntimeManager } from "../server/singbox/runtime-manager.js";

class RecordingRuntimeAdapter {
  constructor() {
    this.publications = [];
  }

  async publish(publication) {
    this.publications.push(publication);
    return { mode: "test", runtimeVersion: "sing-box-test" };
  }

  async status() {
    return { state: "running", mode: "test", runtimeVersion: "sing-box-test" };
  }
}

test("deployment publishes a validated snapshot without exposing credentials in its result", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-deploy-"));
  const store = new RayLinkStore({
    dbPath: join(dataDir, "raylink.db"),
    adminUsername: "admin",
    adminPassword: "Admin@2026"
  });
  const adapter = new RecordingRuntimeAdapter();
  const manager = new RuntimeManager({ store, adapter, listenPort: 8388 });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const preview = manager.preview();
  assert.equal(preview.eligibleUsers, 5);
  assert.match(preview.checksum, /^[a-f0-9]{64}$/);
  assert.equal("configText" in preview, false);

  const deployment = await manager.publish();
  assert.equal(deployment.status, "active");
  assert.equal(deployment.eligibleUsers, 5);
  assert.equal("configJson" in deployment, false);
  assert.equal(adapter.publications.length, 1);

  const publishedConfig = JSON.parse(adapter.publications[0].configText);
  assert.equal(publishedConfig.inbounds[0].users.length, 5);
  assert.ok(publishedConfig.inbounds[0].users.every((user) => user.password));
  assert.equal(store.listDeployments()[0].status, "active");
});

test("deployment failure is recorded and leaves the previous runtime untouched", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-deploy-fail-"));
  const store = new RayLinkStore({
    dbPath: join(dataDir, "raylink.db"),
    adminUsername: "admin",
    adminPassword: "Admin@2026"
  });
  const adapter = {
    async publish() {
      throw new Error("sing-box check failed");
    },
    async status() {
      return { state: "unknown", mode: "test" };
    }
  };
  const manager = new RuntimeManager({ store, adapter, listenPort: 8388 });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  await assert.rejects(() => manager.publish(), /sing-box check failed/);
  assert.equal(store.listDeployments()[0].status, "failed");
});

test("runtime manager rejects a concurrent publication", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-deploy-concurrent-"));
  const store = new RayLinkStore({
    dbPath: join(dataDir, "raylink.db"),
    adminUsername: "admin",
    adminPassword: "Admin@2026"
  });
  let releasePublish;
  const gate = new Promise((resolve) => {
    releasePublish = resolve;
  });
  const adapter = {
    async publish() {
      await gate;
      return { mode: "test", runtimeVersion: "1.13.12" };
    },
    async status() {
      return { state: "running", mode: "test" };
    }
  };
  const manager = new RuntimeManager({ store, adapter, listenPort: 8388 });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const first = manager.publish();
  store.updateHostProtocolConfig("local", "vless", {
    enabled: true,
    listen: "::",
    port: 8443,
    tls: { mode: "none" },
    transport: { type: "none" },
    options: {}
  });
  await assert.rejects(
    () => manager.publish(),
    (error) => error.code === "DEPLOYMENT_IN_PROGRESS" && error.statusCode === 409
  );
  releasePublish();
  assert.equal((await first).status, "active");
  assert.equal(
    store.getHost("local").appliedProtocols.find((profile) => profile.type === "vless").enabled,
    false
  );
  assert.equal(store.listDeployments().length, 1);
});

test("rollback republishes an immutable historical snapshot as a new active deployment", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-deploy-rollback-"));
  const store = new RayLinkStore({
    dbPath: join(dataDir, "raylink.db"),
    adminUsername: "admin",
    adminPassword: "Admin@2026"
  });
  const adapter = new RecordingRuntimeAdapter();
  const manager = new RuntimeManager({ store, adapter, listenPort: 8388 });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const first = await manager.publish();
  const firstConfig = adapter.publications[0].configText;
  store.updateHostProtocolConfig("local", "vless", {
    enabled: true,
    listen: "::",
    port: 8443,
    tls: { mode: "none" },
    transport: { type: "none" },
    options: {}
  });
  const user = store.listUsers().find((candidate) => candidate.email === "priya@vantage-bioworks.in");
  store.updateUser(user.id, { usedGb: 320 });
  const second = await manager.publish();

  assert.equal(store.listDeployments().find((deployment) => deployment.id === first.id).status, "superseded");
  assert.equal(second.eligibleUsers, 4);
  assert.equal(
    store.getHost("local").appliedProtocols.find((profile) => profile.type === "vless").enabled,
    true
  );

  const rollback = await manager.rollback(first.id);
  assert.match(rollback.version, /^r/);
  assert.equal(rollback.status, "active");
  assert.equal(rollback.eligibleUsers, 5);
  assert.equal(adapter.publications.length, 3);
  assert.equal(adapter.publications[2].configText, firstConfig);
  assert.equal(
    store.getHost("local").appliedProtocols.find((profile) => profile.type === "vless").enabled,
    false
  );
  assert.equal(
    store.listDeployments().find((deployment) => deployment.id === second.id).status,
    "superseded"
  );
});

test("rollback queues the matching historical protocol snapshot for remote Hosts", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-deploy-remote-rollback-"));
  const store = new RayLinkStore({
    dbPath: join(dataDir, "raylink.db"),
    adminUsername: "admin",
    adminPassword: "Admin@2026"
  });
  const created = store.createRemoteHost({
    name: "Singapore",
    address: "sg.example.com",
    region: "singapore"
  });
  const enrolled = store.enrollNode(created.enrollmentToken, {
    hostname: "sg-01",
    platform: "linux",
    architecture: "amd64",
    agentVersion: "0.7.0",
    runtimeVersion: "1.13.12"
  });
  const adapter = new RecordingRuntimeAdapter();
  const manager = new RuntimeManager({ store, adapter, listenPort: 8388 });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  store.updateHostProtocolConfig(enrolled.hostId, "shadowsocks", { enabled: true });
  const first = await manager.publish();
  const firstTask = store.nextNodeTask(enrolled.hostId);
  store.completeNodeTask(enrolled.hostId, firstTask.id, {
    attempt: firstTask.attempt,
    status: "succeeded",
    runtimeVersion: "1.13.12"
  });

  store.updateHostProtocolConfig(enrolled.hostId, "vless", {
    enabled: true,
    listen: "::",
    port: 8443,
    tls: { mode: "none" },
    transport: { type: "none" },
    options: {}
  });
  await manager.publish();
  const secondTask = store.nextNodeTask(enrolled.hostId);
  store.completeNodeTask(enrolled.hostId, secondTask.id, {
    attempt: secondTask.attempt,
    status: "succeeded",
    runtimeVersion: "1.13.12"
  });

  const rollback = await manager.rollback(first.id);
  assert.equal(rollback.remoteQueued, 1);
  const rollbackTask = store.nextNodeTask(enrolled.hostId);
  assert.equal(rollbackTask.priority, "normal");
  assert.deepEqual(
    rollbackTask.payload.protocols
      .filter((profile) => profile.enabled)
      .map((profile) => profile.type),
    ["shadowsocks"]
  );
  assert.deepEqual(
    JSON.parse(rollbackTask.payload.configText).inbounds.map((inbound) => inbound.type),
    ["shadowsocks"]
  );
});
