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
