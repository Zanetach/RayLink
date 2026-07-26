import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RayLinkStore } from "../server/database.js";

async function createStore(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "raylink-maintenance-"));
  const store = new RayLinkStore({
    dbPath: join(directory, "raylink.db"),
    adminUsername: "admin",
    adminPassword: "Admin@2026",
    seedDemoData: true,
    ...overrides
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

test("operational maintenance removes expired administrator and user sessions", async (t) => {
  const store = await createStore(t);
  const admin = await store.authenticateAdmin("admin", "Admin@2026");
  const user = store.listUsers()[0];
  store.createAdminSession(admin.id, -1);
  store.createUserSession(user.id, -1);

  const result = store.performOperationalMaintenance();

  assert.deepEqual(result.sessions, {
    administrator: 1,
    user: 1
  });
});

test("operational maintenance bounds deployment history without deleting the active snapshot", async (t) => {
  const store = await createStore(t);
  const activeId = store.createDeployment({
    version: "v-active",
    configJson: { inbounds: [], outbounds: [] },
    checksum: "active-checksum",
    eligibleUsers: []
  });
  store.finishDeployment(activeId, { status: "active" });
  for (let index = 0; index < 25; index += 1) {
    const id = store.createDeployment({
      version: `v-failed-${index}`,
      configJson: { inbounds: [], outbounds: [] },
      checksum: `failed-${index}`,
      eligibleUsers: []
    });
    store.finishDeployment(id, { status: "failed", error: "expected failure" });
  }

  const result = store.performOperationalMaintenance({
    deploymentHistoryLimit: 20
  });
  const deployments = store.listDeployments(100);

  assert.equal(result.history.deployments, 5);
  assert.equal(deployments.length, 21);
  assert.ok(deployments.some((deployment) => deployment.id === activeId));
});

test("operational maintenance bounds completed task payloads per Host and task kind", async (t) => {
  const store = await createStore(t);
  const created = store.createRemoteHost({
    name: "Singapore Runtime",
    address: "sg.example.com",
    region: "singapore"
  });
  const enrolled = store.enrollNode(created.enrollmentToken, {
    hostname: "sg-vps-01",
    platform: "linux",
    architecture: "x64",
    agentVersion: "0.5.0",
    runtimeVersion: "1.13.14"
  });
  const completedTaskIds = [];
  for (let index = 0; index < 25; index += 1) {
    store.queueNodeTask(enrolled.hostId, "upgrade-runtime", {
      targetVersion: "1.13.14",
      sequence: index
    });
    const task = store.nextNodeTask(enrolled.hostId);
    store.completeNodeTask(enrolled.hostId, task.id, {
      attempt: task.attempt,
      status: "succeeded",
      result: { runtimeVersion: "1.13.14" }
    });
    completedTaskIds.push(task.id);
  }

  const result = store.performOperationalMaintenance({
    nodeTaskHistoryLimit: 20
  });

  assert.equal(result.history.nodeTasks, 5);
  assert.throws(
    () => store.completeNodeTask(enrolled.hostId, completedTaskIds[0], {
      attempt: 1,
      status: "succeeded"
    }),
    (error) => error.code === "NODE_TASK_NOT_FOUND"
  );
  assert.deepEqual(
    store.completeNodeTask(enrolled.hostId, completedTaskIds.at(-1), {
      attempt: 1,
      status: "succeeded"
    }),
    { id: completedTaskIds.at(-1), status: "succeeded", ignored: true }
  );
});

test("operational maintenance compacts old usage details without changing user totals", async (t) => {
  let currentTime = new Date("2026-01-01T00:02:00.000Z");
  const store = await createStore(t, {
    clock: () => currentTime
  });
  const user = store.listUsers()[0];
  const first = store.recordUsageSnapshot("local", {
    sampleId: "maintenance-usage-0001",
    runtimeInstanceId: "maintenance-runtime",
    observedAt: "2026-01-01T00:00:00.000Z",
    users: [{
      name: user.email,
      uplinkBytes: 100,
      downlinkBytes: 900
    }]
  });
  const second = store.recordUsageSnapshot("local", {
    sampleId: "maintenance-usage-0002",
    runtimeInstanceId: "maintenance-runtime",
    observedAt: "2026-01-01T00:01:00.000Z",
    users: [{
      name: user.email,
      uplinkBytes: 150,
      downlinkBytes: 1_050
    }]
  });
  assert.equal(first.appliedBytes, 1_000);
  assert.equal(second.appliedBytes, 200);
  const usedBytesBeforeMaintenance = Math.round(store.getUser(user.id).usedGb * 1024 ** 3);

  const result = store.performOperationalMaintenance({
    now: "2026-02-15T00:00:00.000Z",
    usageDetailRetentionDays: 30
  });

  assert.equal(result.history.usageSamples, 2);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM usage_samples").get().count,
    0
  );
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM user_usage_ledger").get().count,
    0
  );
  const dailyUsage = store.db.prepare(`
    SELECT uplink_bytes AS uplinkBytes, downlink_bytes AS downlinkBytes
    FROM daily_user_usage
    WHERE host_id = 'local' AND user_id = ? AND usage_date = '2026-01-01'
  `).get(user.id);
  assert.equal(dailyUsage.uplinkBytes, 150);
  assert.equal(dailyUsage.downlinkBytes, 1_050);
  assert.equal(
    Math.round(store.getUser(user.id).usedGb * 1024 ** 3),
    usedBytesBeforeMaintenance
  );
  currentTime = new Date("2026-02-15T00:00:00.000Z");
  assert.throws(
    () => store.recordUsageSnapshot("local", {
      sampleId: "maintenance-usage-0001",
      runtimeInstanceId: "old-maintenance-runtime",
      observedAt: "2026-01-01T00:00:00.000Z",
      users: [{
        name: user.email,
        uplinkBytes: 100,
        downlinkBytes: 900
      }]
    }),
    (error) => error.code === "STALE_USAGE_SAMPLE"
  );
  assert.equal(
    Math.round(store.getUser(user.id).usedGb * 1024 ** 3),
    usedBytesBeforeMaintenance
  );

  const archiveResult = store.performOperationalMaintenance({
    now: "2028-01-01T00:00:00.000Z",
    dailyUsageRetentionDays: 400
  });
  assert.equal(archiveResult.history.dailyUsage, 1);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM daily_user_usage").get().count,
    0
  );
  assert.equal(
    Math.round(store.getUser(user.id).usedGb * 1024 ** 3),
    usedBytesBeforeMaintenance
  );
});
