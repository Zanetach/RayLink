import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRayLinkApp } from "../server/app.js";
import { hashSessionSecret } from "../server/security.js";

async function startSetupApp() {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-setup-"));
  const setupToken = "raylink-setup-token-for-tests";
  const app = await createRayLinkApp({
    dataDir,
    adminUsername: "bootstrap-admin",
    adminPassword: "Bootstrap@Password2026",
    publicOrigin: "http://127.0.0.1",
    runtimeMode: "dry-run",
    seedDemoData: false,
    setupRequired: true,
    setupTokenHash: hashSessionSecret(setupToken),
    setupTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    telemetryIntervalMs: 60_000,
    runtimeUpdateCheckIntervalMs: 0,
    ruleSetCache: {
      prepare: async () => {},
      available: () => false,
      get: async () => null
    }
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  return {
    app,
    setupToken,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

test("an uninitialized instance exposes only the setup flow", async (t) => {
  const testApp = await startSetupApp();
  t.after(() => testApp.close());

  const root = await fetch(`${testApp.baseUrl}/`, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/setup");

  const setup = await fetch(`${testApp.baseUrl}/setup`);
  assert.equal(setup.status, 200);
  assert.match(await setup.text(), /首次初始化 RayLink/);

  const status = await fetch(`${testApp.baseUrl}/api/setup/status`);
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.state, "SETUP_PENDING");
  assert.equal(statusBody.version, 1);
  assert.match(statusBody.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

  const login = await fetch(`${testApp.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "bootstrap-admin",
      password: "Bootstrap@Password2026"
    })
  });
  assert.equal(login.status, 423);
  assert.equal((await login.json()).error.code, "SETUP_REQUIRED");
});

test("the durable INITIALIZING state keeps the control plane locked and is recoverable", async (t) => {
  const testApp = await startSetupApp();
  t.after(() => testApp.close());

  testApp.app.store.beginSetupInitialization();
  const initializing = await fetch(`${testApp.baseUrl}/api/setup/status`);
  assert.deepEqual(await initializing.json(), {
    state: "INITIALIZING",
    version: 1
  });

  const bootstrap = await fetch(`${testApp.baseUrl}/api/bootstrap`);
  assert.equal(bootstrap.status, 423);
  assert.equal((await bootstrap.json()).error.code, "SETUP_REQUIRED");

  testApp.app.store.failSetupInitialization();
  const recovered = await fetch(`${testApp.baseUrl}/api/setup/status`);
  assert.equal((await recovered.json()).state, "SETUP_PENDING");
});

test("the one-time setup token initializes access, admin, and local runtime", async (t) => {
  const testApp = await startSetupApp();
  t.after(() => testApp.close());

  const payload = {
    token: testApp.setupToken,
    access: {
      mode: "ip",
      canonicalOrigin: testApp.baseUrl,
      allowedOrigins: [testApp.baseUrl]
    },
    certificate: { mode: "external" },
    admin: {
      username: "admin",
      password: "Production@Admin2026"
    },
    runtime: {
      name: "Tokyo Gateway",
      address: "127.0.0.1",
      region: "tokyo"
    }
  };

  const rejected = await fetch(`${testApp.baseUrl}/api/setup/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, token: "wrong-token" })
  });
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).error.code, "SETUP_TOKEN_INVALID");

  const inactiveOrigin = await fetch(`${testApp.baseUrl}/api/setup/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...payload,
      access: {
        ...payload.access,
        canonicalOrigin: "http://localhost",
        allowedOrigins: ["http://localhost"]
      }
    })
  });
  assert.equal(inactiveOrigin.status, 422);
  assert.equal((await inactiveOrigin.json()).error.code, "SETUP_ORIGIN_NOT_ACTIVE");

  const preflight = await fetch(`${testApp.baseUrl}/api/setup/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(preflight.status, 200);
  assert.deepEqual((await preflight.json()).checks, {
    setupToken: "passed",
    accessOrigin: "passed",
    https: "development",
    runtime: "development"
  });

  const completed = await fetch(`${testApp.baseUrl}/api/setup/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(completed.status, 201);
  const result = await completed.json();
  assert.equal(result.state, "READY");
  assert.equal(result.currentAdmin.username, "admin");
  assert.equal(result.redirectTo, "/");
  assert.match(completed.headers.get("set-cookie"), /^raylink_session=/);

  const status = await fetch(`${testApp.baseUrl}/api/setup/status`);
  assert.deepEqual(await status.json(), { state: "READY", version: 1 });

  const reused = await fetch(`${testApp.baseUrl}/api/setup/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(reused.status, 409);
  assert.equal((await reused.json()).error.code, "SETUP_ALREADY_COMPLETE");

  const login = await fetch(`${testApp.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "Production@Admin2026"
    })
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).currentAdmin.username, "admin");

  assert.equal(testApp.app.store.getHost("local").name, "Tokyo Gateway");
});

test("the control-plane installer emits a fragment setup URL and never persists plaintext token", async () => {
  const installer = await readFile(
    new URL("../deploy/install-control-plane.sh", import.meta.url),
    "utf8"
  );
  const rotator = await readFile(
    new URL("../deploy/rotate-setup-token.sh", import.meta.url),
    "utf8"
  );
  assert.match(installer, /\/setup#token=/);
  assert.match(installer, /RAYLINK_SETUP_TOKEN_HASH=/);
  assert.doesNotMatch(installer, /RAYLINK_SETUP_TOKEN=/);
  assert.match(installer, /systemctl enable --now raylink/);
  assert.match(installer, /\*:\*\) public_host="\[\$public_ip\]"/);
  assert.match(installer, /systemctl enable sing-box-raylink/);
  assert.match(rotator, /systemctl restart raylink/);
  assert.match(rotator, /\/setup#token=/);
  assert.doesNotMatch(rotator, /RAYLINK_SETUP_TOKEN=/);
});
