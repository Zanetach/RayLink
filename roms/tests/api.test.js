import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRayLinkApp } from "../server/app.js";

async function startTestApp(overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-api-"));
  const app = await createRayLinkApp({
    dataDir,
    adminUsername: "admin",
    adminPassword: "Admin@2026",
    publicOrigin: "http://127.0.0.1",
    runtimeMode: "dry-run",
    ...overrides
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "Admin@2026" })
  });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie()[0].split(";")[0];
}

async function api(baseUrl, cookie, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      cookie,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
}

test("authenticated bootstrap returns separate users and plans", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());

  const anonymous = await fetch(`${testApp.baseUrl}/api/bootstrap`);
  assert.equal(anonymous.status, 401);

  const cookie = await login(testApp.baseUrl);
  const response = await fetch(`${testApp.baseUrl}/api/bootstrap`, {
    headers: { cookie }
  });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.currentAdmin.username, "admin");
  assert.equal(body.users.length, 6);
  assert.equal(body.plans.length, 3);
  assert.equal(body.users.find((user) => user.email === "lin.zhixia@meridian-log.cn").planId, "standard");
  assert.ok(body.plans.some((plan) => plan.id === "standard"));
  assert.equal("passwordHash" in body.users[0], false);
  assert.equal("runtimeCredential" in body.users[0], false);
});

test("admin creates a reusable plan and assigns exactly one plan to a user", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const planResponse = await api(testApp.baseUrl, cookie, "/api/plans", {
    method: "POST",
    body: JSON.stringify({
      id: "regional",
      name: "区域办公",
      quotaGb: 86,
      deviceLimit: 2,
      nodeScope: ["tokyo"],
      clientFormats: ["sing-box"],
      description: "适合区域办公室",
      tone: "standard"
    })
  });
  assert.equal(planResponse.status, 201);

  const planUpdateResponse = await api(testApp.baseUrl, cookie, "/api/plans/regional", {
    method: "PATCH",
    body: JSON.stringify({ quotaGb: 92, deviceLimit: 3 })
  });
  assert.equal(planUpdateResponse.status, 200);
  assert.equal((await planUpdateResponse.json()).quotaGb, 92);

  const userResponse = await api(testApp.baseUrl, cookie, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "徐清扬",
      email: "qingyang.xu@example.cn",
      planId: "regional",
      expiresAt: "2027-01-31"
    })
  });
  assert.equal(userResponse.status, 201);
  const user = await userResponse.json();
  assert.equal(user.planId, "regional");
  assert.equal("runtimePassword" in user, false);
  assert.equal("runtimeUuid" in user, false);

  const updateResponse = await api(testApp.baseUrl, cookie, `/api/users/${user.id}`, {
    method: "PATCH",
    body: JSON.stringify({ planId: "standard" })
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).planId, "standard");

  const bootstrap = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const snapshot = await bootstrap.json();
  assert.equal(snapshot.users.find((item) => item.id === user.id).planId, "standard");
  assert.equal(snapshot.plans.find((plan) => plan.id === "regional").assignedUsers, 0);
  assert.equal(snapshot.plans.find((plan) => plan.id === "standard").assignedUsers, 5);
});

test("user creation rejects an unknown plan", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const response = await api(testApp.baseUrl, cookie, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "无方案用户",
      email: "missing-plan@example.cn",
      planId: "missing",
      expiresAt: "2027-01-31"
    })
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "PLAN_NOT_FOUND");
});

test("admin previews and publishes the current database snapshot", async (t) => {
  const publications = [];
  const runtimeAdapter = {
    async publish(publication) {
      publications.push(publication);
      return { state: "running", mode: "test", runtimeVersion: "1.13.14" };
    },
    async status() {
      return { state: "running", mode: "test", runtimeVersion: "1.13.14" };
    }
  };
  const testApp = await startTestApp({ runtimeAdapter });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const previewResponse = await api(testApp.baseUrl, cookie, "/api/deployments/preview", { method: "POST" });
  assert.equal(previewResponse.status, 200);
  assert.equal((await previewResponse.json()).eligibleUsers, 5);

  const publishResponse = await api(testApp.baseUrl, cookie, "/api/deployments", { method: "POST" });
  assert.equal(publishResponse.status, 201);
  const deployment = await publishResponse.json();
  assert.equal(deployment.status, "active");
  assert.equal(publications.length, 1);

  const bootstrap = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const snapshot = await bootstrap.json();
  assert.equal(snapshot.runtime.state, "running");
  assert.equal(snapshot.deployments[0].status, "active");
});

test("active user logs in and downloads a credential-scoped sing-box client config", async (t) => {
  const testApp = await startTestApp({ proxyHost: "node.cyclelink.org", listenPort: 8388 });
  t.after(() => testApp.close());

  const loginResponse = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  assert.equal(loginResponse.status, 200);
  const portalCookie = loginResponse.headers.getSetCookie()[0].split(";")[0];

  const profileResponse = await fetch(`${testApp.baseUrl}/api/portal/me`, {
    headers: { cookie: portalCookie }
  });
  assert.equal(profileResponse.status, 200);
  const profile = await profileResponse.json();
  assert.equal(profile.user.planId, "high-speed");
  assert.equal(profile.plan.deviceLimit, 5);

  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(config.outbounds[0].server, "node.cyclelink.org");
  assert.equal(config.outbounds[0].server_port, 8388);
  assert.ok(config.outbounds[0].password);
  assert.equal(JSON.stringify(config).includes("shadowsocks_master_password"), false);
});

test("invited user cannot log in before activation", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const response = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "lars@nordhavn-data.se",
      password: "raylink-demo"
    })
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "ACCOUNT_NOT_ACTIVE");
});

test("admin can activate a new portal user with a separate login password", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const createResponse = await api(testApp.baseUrl, cookie, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "赵明",
      email: "zhao.ming@example.cn",
      password: "PortalPass@2026",
      portalStatus: "active",
      state: "active",
      planId: "standard",
      expiresAt: "2027-01-31"
    })
  });
  assert.equal(createResponse.status, 201);
  assert.equal((await createResponse.json()).portalStatus, "active");

  const portalResponse = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "zhao.ming@example.cn", password: "PortalPass@2026" })
  });
  assert.equal(portalResponse.status, 200);
  assert.equal((await portalResponse.json()).user.email, "zhao.ming@example.cn");
});

test("admin updates the single runtime host used by portal client configs", async (t) => {
  const testApp = await startTestApp({ proxyHost: "old-node.example.com", listenPort: 8388 });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const updateResponse = await api(testApp.baseUrl, cookie, "/api/hosts/local", {
    method: "PATCH",
    body: JSON.stringify({
      name: "东京生产节点",
      address: "node.example.com",
      region: "tokyo"
    })
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).address, "node.example.com");

  const portalLogin = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = portalLogin.headers.getSetCookie()[0].split(";")[0];
  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });
  assert.equal((await configResponse.json()).outbounds[0].server, "node.example.com");
});

test("control plane serves the RayLink web application on the same origin", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());

  const indexResponse = await fetch(`${testApp.baseUrl}/`);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get("content-type"), /text\/html/);
  assert.match(await indexResponse.text(), /用户与订阅/);

  const scriptResponse = await fetch(`${testApp.baseUrl}/app.js`);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type"), /javascript/);
});
