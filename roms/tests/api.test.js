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
    nodeHeartbeatMinIntervalMs: 0,
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

test("authenticated bootstrap returns users with independent entitlements", async (t) => {
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
  assert.equal(body.hosts[0].name, "RayLink Runtime");
  assert.equal(body.users.length, 6);
  assert.equal("plans" in body, false);
  const user = body.users.find((candidate) => candidate.email === "lin.zhixia@meridian-log.cn");
  assert.equal(user.quotaGb, 120);
  assert.equal("deviceLimit" in user, false);
  assert.deepEqual(user.nodeScope, ["tokyo", "singapore"]);
  assert.deepEqual(user.clientFormats, ["mihomo", "sing-box"]);
  assert.equal("planId" in user, false);
  assert.equal("passwordHash" in body.users[0], false);
  assert.equal("runtimeCredential" in body.users[0], false);
});

test("production initialization can start without known demo users", async (t) => {
  const testApp = await startTestApp({ seedDemoData: false });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const response = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const body = await response.json();
  assert.deepEqual(body.users, []);
  assert.equal("plans" in body, false);
});

test("authenticated bootstrap reports current local host telemetry", async (t) => {
  let telemetrySamples = 0;
  const testApp = await startTestApp({
    telemetryIntervalMs: 20,
    telemetryProvider: async () => {
      telemetrySamples += 1;
      return {
        cpuPercent: 21.4,
        memoryUsedBytes: 3_000,
        memoryTotalBytes: 8_000,
        networkRxBytes: 40_000,
        networkTxBytes: 20_000,
        networkRxBps: 640_000,
        networkTxBps: 160_000,
        serviceStatus: "running"
      };
    }
  });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  await new Promise((resolve) => setTimeout(resolve, 45));

  const response = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const body = await response.json();
  const localHost = body.hosts.find((host) => host.id === "local");

  assert.equal(localHost.telemetry.cpuPercent, 21.4);
  assert.equal(localHost.telemetry.memoryUsedBytes, 3_000);
  assert.equal(localHost.telemetry.serviceStatus, "running");
  assert.equal(body.telemetry.networkSeries.at(-1).downloadBps, 640_000);
  assert.ok(telemetrySamples >= 2);
});

test("admin creates and updates a user-owned entitlement", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const userResponse = await api(testApp.baseUrl, cookie, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "徐清扬",
      email: "qingyang.xu@example.cn",
      quotaGb: 86,
      nodeScope: ["tokyo"],
      clientFormats: ["sing-box"],
      state: "disabled",
      expiresAt: "2027-01-31"
    })
  });
  assert.equal(userResponse.status, 201);
  const user = await userResponse.json();
  assert.equal(user.quotaGb, 86);
  assert.equal("deviceLimit" in user, false);
  assert.deepEqual(user.nodeScope, ["tokyo"]);
  assert.deepEqual(user.clientFormats, ["sing-box"]);
  assert.equal(user.state, "disabled");
  assert.equal("planId" in user, false);
  assert.equal("runtimePassword" in user, false);
  assert.equal("runtimeUuid" in user, false);

  const updateResponse = await api(testApp.baseUrl, cookie, `/api/users/${user.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      quotaGb: 92,
      nodeScope: ["all"]
    })
  });
  assert.equal(updateResponse.status, 200);
  const updatedUser = await updateResponse.json();
  assert.equal(updatedUser.quotaGb, 92);
  assert.equal("deviceLimit" in updatedUser, false);
  assert.deepEqual(updatedUser.nodeScope, ["all"]);

  const bootstrap = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const snapshot = await bootstrap.json();
  assert.equal(snapshot.users.find((item) => item.id === user.id).quotaGb, 92);
  assert.equal("plans" in snapshot, false);

  const retiredPlanEndpoint = await api(testApp.baseUrl, cookie, "/api/plans", {
    method: "POST",
    body: JSON.stringify({})
  });
  assert.equal(retiredPlanEndpoint.status, 404);
});

test("user creation rejects invalid entitlement limits", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const response = await api(testApp.baseUrl, cookie, "/api/users", {
    method: "POST",
    body: JSON.stringify({
      name: "无效权益用户",
      email: "invalid-entitlement@example.cn",
      quotaGb: 0,
      nodeScope: ["tokyo"],
      clientFormats: ["sing-box"],
      expiresAt: "2027-01-31"
    })
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, "INVALID_QUOTA");
});

test("admin previews and publishes the current database snapshot", async (t) => {
  const publications = [];
  const runtimeAdapter = {
    async publish(publication) {
      publications.push(publication);
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    },
    async status() {
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
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
  assert.equal(snapshot.deployments[0].publisherUsername, "admin");
});

test("admin detects sing-box, enables a protocol profile and triggers one-click installation", async (t) => {
  let installCalls = 0;
  const installer = {
    async status() {
      return {
        installed: installCalls > 0,
        version: installCalls > 0 ? "1.13.12" : null,
        platform: "darwin",
        architecture: "arm64",
        tags: installCalls > 0 ? ["with_quic", "with_utls"] : [],
        binaryPath: "sing-box"
      };
    },
    async install() {
      installCalls += 1;
      return this.status();
    },
    async generateRealityKeypair() {
      return { privateKey: "private-key", publicKey: "public-key" };
    }
  };
  const testApp = await startTestApp({ installer });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const initialResponse = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const initial = await initialResponse.json();
  assert.equal(initial.installation.installed, false);
  assert.equal(initial.protocols.find((profile) => profile.type === "shadowsocks").enabled, true);
  assert.ok(initial.protocolCatalog.some((protocol) => protocol.type === "hysteria2"));

  const installResponse = await api(testApp.baseUrl, cookie, "/api/runtime/install", { method: "POST" });
  assert.equal(installResponse.status, 200);
  assert.equal((await installResponse.json()).version, "1.13.12");

  const updateResponse = await api(testApp.baseUrl, cookie, "/api/runtime/protocols/vless", {
    method: "PATCH",
    body: JSON.stringify({
      enabled: true,
      listen: "::",
      port: 8443,
      tls: { mode: "none" },
      transport: { type: "ws", path: "/raylink" },
      options: {}
    })
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).enabled, true);

  const previewResponse = await api(testApp.baseUrl, cookie, "/api/deployments/preview", { method: "POST" });
  const preview = await previewResponse.json();
  assert.equal(preview.inboundCount, 2);
  assert.deepEqual(preview.protocols, ["shadowsocks", "vless"]);

  const conflictResponse = await api(testApp.baseUrl, cookie, "/api/runtime/protocols/vmess", {
    method: "PATCH",
    body: JSON.stringify({
      enabled: true,
      listen: "::",
      port: 8443,
      tls: { mode: "none" },
      transport: { type: "none" },
      options: {}
    })
  });
  assert.equal(conflictResponse.status, 422);
  assert.equal((await conflictResponse.json()).error.code, "PROTOCOL_PORT_CONFLICT");
});

test("admin cannot enable Reality or QUIC transport when the sing-box build tags are missing", async (t) => {
  const installer = {
    async status() {
      return {
        installed: true,
        version: "1.13.12",
        platform: "linux",
        architecture: "amd64",
        tags: [],
        binaryPath: "sing-box"
      };
    }
  };
  const testApp = await startTestApp({ installer });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const baseProfile = {
    enabled: true,
    listen: "::",
    port: 8443,
    options: {}
  };

  const realityResponse = await api(testApp.baseUrl, cookie, "/api/runtime/protocols/vless", {
    method: "PATCH",
    body: JSON.stringify({
      ...baseProfile,
      tls: {
        mode: "reality",
        serverName: "www.microsoft.com",
        handshakeServer: "www.microsoft.com",
        handshakePort: 443,
        privateKey: "private-key",
        publicKey: "public-key",
        shortId: "0123456789abcdef"
      },
      transport: { type: "none" }
    })
  });
  assert.equal(realityResponse.status, 422);
  assert.equal((await realityResponse.json()).error.code, "REALITY_UNAVAILABLE");

  const quicResponse = await api(testApp.baseUrl, cookie, "/api/runtime/protocols/vless", {
    method: "PATCH",
    body: JSON.stringify({
      ...baseProfile,
      tls: {
        mode: "certificate",
        serverName: "node.example.com",
        certificatePath: "/tmp/cert.pem",
        keyPath: "/tmp/key.pem"
      },
      transport: { type: "quic" }
    })
  });
  assert.equal(quicResponse.status, 422);
  assert.equal((await quicResponse.json()).error.code, "QUIC_UNAVAILABLE");
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
  assert.equal("planId" in profile.user, false);
  assert.equal("deviceLimit" in profile.entitlement, false);
  assert.equal(profile.entitlement.quotaGb, 320);

  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(config.outbounds[0].server, "node.cyclelink.org");
  assert.equal(config.outbounds[0].server_port, 8388);
  assert.ok(config.outbounds[0].password);
  const passwordParts = config.outbounds[0].password.split(":");
  assert.equal(passwordParts.length, 2);
  assert.equal(Buffer.from(passwordParts[0], "base64").length, 16);
  assert.equal(Buffer.from(passwordParts[1], "base64").length, 16);
  assert.equal(JSON.stringify(config).includes("shadowsocks_master_password"), false);
});

test("portal excludes a staged local Runtime when production delivery is enforced", async (t) => {
  const testApp = await startTestApp({
    proxyHost: "node.example.com",
    allowStagedClientConfigs: false
  });
  t.after(() => testApp.close());
  const loginResponse = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = loginResponse.headers.getSetCookie()[0].split(";")[0];

  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });

  assert.equal(configResponse.status, 403);
  assert.equal((await configResponse.json()).error.code, "ENTITLEMENT_INACTIVE");
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
      quotaGb: 120,
      nodeScope: ["tokyo", "singapore"],
      clientFormats: ["sing-box"],
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

test("admin creates a remote host and RayLink Node enrolls with a one-time token", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const createResponse = await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "新加坡二号机",
      address: "sg-2.example.com",
      region: "singapore"
    })
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json();
  assert.equal(created.host.kind, "remote");
  assert.equal(created.host.status, "pending");
  assert.match(created.enrollmentToken, /^[A-Za-z0-9_-]{40,}$/);

  const bootstrapResponse = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const bootstrap = await bootstrapResponse.json();
  const pendingHost = bootstrap.hosts.find((host) => host.id === created.host.id);
  assert.equal(pendingHost.status, "pending");
  assert.equal("enrollmentToken" in pendingHost, false);

  const enrollResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "sg-vps-02",
      platform: "linux",
      architecture: "amd64",
      agentVersion: "0.1.0",
      runtimeVersion: "1.13.12",
      buildTags: ["with_quic", "with_utls"]
    })
  });
  assert.equal(enrollResponse.status, 201);
  const enrolled = await enrollResponse.json();
  assert.equal(enrolled.hostId, created.host.id);
  assert.match(enrolled.nodeSecret, /^[A-Za-z0-9_-]{40,}$/);

  const reuseResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: created.enrollmentToken })
  });
  assert.equal(reuseResponse.status, 401);

  const heartbeatResponse = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${enrolled.nodeSecret}`,
      "content-type": "application/json",
      "x-raylink-host-id": enrolled.hostId
    },
    body: JSON.stringify({
      runtimeState: "running",
      runtimeVersion: "1.13.12",
      agentVersion: "0.1.0",
      telemetry: {
        cpuPercent: 37.5,
        memoryUsedBytes: 2_147_483_648,
        memoryTotalBytes: 4_294_967_296,
        networkRxBytes: 12_884_901_888,
        networkTxBytes: 3_221_225_472,
        networkRxBps: 12_500_000,
        networkTxBps: 2_500_000,
        serviceStatus: "running"
      }
    })
  });
  assert.equal(heartbeatResponse.status, 200);
  assert.equal((await heartbeatResponse.json()).nextPollSeconds, 10);

  const refreshedResponse = await api(testApp.baseUrl, cookie, "/api/bootstrap");
  const refreshed = await refreshedResponse.json();
  const onlineHost = refreshed.hosts.find((host) => host.id === created.host.id);
  assert.equal(onlineHost.status, "online");
  assert.equal(onlineHost.runtimeVersion, "1.13.12");
  assert.ok(onlineHost.lastSeenAt);
  assert.deepEqual({
    ...onlineHost.telemetry,
    updatedAt: undefined
  }, {
    cpuPercent: 37.5,
    memoryUsedBytes: 2_147_483_648,
    memoryTotalBytes: 4_294_967_296,
    networkRxBytes: 12_884_901_888,
    networkTxBytes: 3_221_225_472,
    networkRxBps: 12_500_000,
    networkTxBps: 2_500_000,
    serviceStatus: "running",
    updatedAt: undefined
  });
  assert.ok(onlineHost.telemetry.updatedAt);
  assert.equal(refreshed.telemetry.networkSeries.at(-1).downloadBps, 12_500_000);
  assert.equal(refreshed.telemetry.networkSeries.at(-1).uploadBps, 2_500_000);

  const failedHeartbeat = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${enrolled.nodeSecret}`,
      "content-type": "application/json",
      "x-raylink-host-id": enrolled.hostId
    },
    body: JSON.stringify({ telemetry: { serviceStatus: "failed" } })
  });
  assert.equal(failedHeartbeat.status, 200);
  let recoveryBootstrap = await (await api(testApp.baseUrl, cookie, "/api/bootstrap")).json();
  assert.equal(recoveryBootstrap.hosts.find((host) => host.id === created.host.id).status, "degraded");

  const recoveredHeartbeat = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${enrolled.nodeSecret}`,
      "content-type": "application/json",
      "x-raylink-host-id": enrolled.hostId
    },
    body: JSON.stringify({
      telemetry: {
        networkRxBytes: null,
        networkTxBytes: null,
        networkRxBps: 1_000,
        networkTxBps: 2_000,
        serviceStatus: "running"
      }
    })
  });
  assert.equal(recoveredHeartbeat.status, 200);
  recoveryBootstrap = await (await api(testApp.baseUrl, cookie, "/api/bootstrap")).json();
  const recoveredHost = recoveryBootstrap.hosts.find((host) => host.id === created.host.id);
  assert.equal(recoveredHost.status, "online");
  assert.equal(recoveredHost.telemetry.networkRxBytes, null);
  assert.equal(
    testApp.app.store.db.prepare(
      "SELECT COUNT(*) AS count FROM host_metric_samples WHERE host_id = ?"
    ).get(created.host.id).count,
    1
  );
});

test("admin can replace a lost enrollment token before the remote host enrolls", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const createResponse = await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "伦敦备用机",
      address: "london.example.com",
      region: "london"
    })
  });
  const created = await createResponse.json();
  const rotateResponse = await api(
    testApp.baseUrl,
    cookie,
    `/api/hosts/${created.host.id}/enrollment-token`,
    { method: "POST" }
  );
  assert.equal(rotateResponse.status, 201);
  const rotated = await rotateResponse.json();
  assert.notEqual(rotated.enrollmentToken, created.enrollmentToken);

  const oldTokenResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: created.enrollmentToken })
  });
  assert.equal(oldTokenResponse.status, 401);
  const enrollResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: rotated.enrollmentToken, hostname: "london-vps" })
  });
  assert.equal(enrollResponse.status, 201);

  const enrolledRotationResponse = await api(
    testApp.baseUrl,
    cookie,
    `/api/hosts/${created.host.id}/enrollment-token`,
    { method: "POST" }
  );
  assert.equal(enrolledRotationResponse.status, 409);
});

test("control plane rate limits authenticated node heartbeat writes", async (t) => {
  const testApp = await startTestApp({ nodeHeartbeatMinIntervalMs: 5_000 });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const created = await (await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "限速测试节点",
      address: "rate-limit.example.com",
      region: "singapore"
    })
  })).json();
  const enrolled = await (await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "rate-limit-vps",
      agentVersion: "0.2.0",
      runtimeVersion: "1.13.12"
    })
  })).json();
  const headers = {
    authorization: `Bearer ${enrolled.nodeSecret}`,
    "content-type": "application/json",
    "x-raylink-host-id": enrolled.hostId
  };

  const first = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ telemetry: { serviceStatus: "running" } })
  });
  const second = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ telemetry: { serviceStatus: "running" } })
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, "HEARTBEAT_RATE_LIMITED");
});

test("user subscription includes every online host allowed by the user node scope", async (t) => {
  const testApp = await startTestApp({ proxyHost: "tokyo.example.com", listenPort: 8388 });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);
  const createResponse = await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "法兰克福二号机",
      address: "fra.example.com",
      region: "frankfurt"
    })
  });
  const created = await createResponse.json();
  const enrollResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "fra-vps-02",
      platform: "linux",
      architecture: "x64",
      runtimeVersion: "1.13.12"
    })
  });
  assert.equal(enrollResponse.status, 201);
  const nodeCredential = await enrollResponse.json();

  const portalLogin = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = portalLogin.headers.getSetCookie()[0].split(";")[0];
  const beforePublishResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });
  assert.equal(beforePublishResponse.status, 200);
  assert.deepEqual(
    (await beforePublishResponse.json()).outbounds
      .filter((outbound) => outbound.type === "shadowsocks")
      .map((outbound) => outbound.server),
    ["tokyo.example.com"]
  );

  const publishResponse = await api(testApp.baseUrl, cookie, "/api/deployments", { method: "POST" });
  assert.equal(publishResponse.status, 201);
  const nodeHeaders = {
    authorization: `Bearer ${nodeCredential.nodeSecret}`,
    "x-raylink-host-id": nodeCredential.hostId
  };
  const taskResponse = await fetch(`${testApp.baseUrl}/api/node/tasks/next`, { headers: nodeHeaders });
  const task = await taskResponse.json();
  const completionResponse = await fetch(
    `${testApp.baseUrl}/api/node/tasks/${encodeURIComponent(task.id)}/complete`,
    {
      method: "POST",
      headers: { ...nodeHeaders, "content-type": "application/json" },
      body: JSON.stringify({ status: "succeeded", result: { runtimeVersion: "1.13.12" } })
    }
  );
  assert.equal(completionResponse.status, 200);
  const heartbeatResponse = await fetch(`${testApp.baseUrl}/api/node/heartbeat`, {
    method: "POST",
    headers: { ...nodeHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      runtimeState: "running",
      telemetry: {
        cpuPercent: 10,
        memoryUsedBytes: 1_000,
        memoryTotalBytes: 2_000,
        networkRxBytes: 1_000,
        networkTxBytes: 1_000,
        networkRxBps: 0,
        networkTxBps: 0,
        serviceStatus: "running"
      }
    })
  });
  assert.equal(heartbeatResponse.status, 200);

  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });

  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  const servers = config.outbounds
    .filter((outbound) => outbound.type === "shadowsocks")
    .map((outbound) => outbound.server);
  assert.deepEqual(servers, ["tokyo.example.com", "fra.example.com"]);
});

test("publishing queues a host-specific sing-box configuration for an enrolled RayLink Node", async (t) => {
  const runtimeAdapter = {
    async publish() {
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    },
    async status() {
      return { state: "running", mode: "test", runtimeVersion: "1.13.12" };
    }
  };
  const testApp = await startTestApp({ runtimeAdapter });
  t.after(() => testApp.close());
  const cookie = await login(testApp.baseUrl);

  const createResponse = await api(testApp.baseUrl, cookie, "/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: "法兰克福二号机",
      address: "fra-2.example.com",
      region: "frankfurt"
    })
  });
  const created = await createResponse.json();
  const enrollResponse = await fetch(`${testApp.baseUrl}/api/node/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: created.enrollmentToken,
      hostname: "fra-vps-02",
      platform: "linux",
      architecture: "amd64",
      agentVersion: "0.1.0",
      runtimeVersion: "1.13.12"
    })
  });
  const enrolled = await enrollResponse.json();
  const nodeHeaders = {
    authorization: `Bearer ${enrolled.nodeSecret}`,
    "x-raylink-host-id": enrolled.hostId
  };

  const publishResponse = await api(testApp.baseUrl, cookie, "/api/deployments", {
    method: "POST"
  });
  assert.equal(publishResponse.status, 201);
  assert.equal((await publishResponse.json()).remoteQueued, 1);

  const taskResponse = await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  });
  assert.equal(taskResponse.status, 200);
  const task = await taskResponse.json();
  assert.equal(task.kind, "publish-config");
  assert.match(task.payload.version, /^v/);
  const config = JSON.parse(task.payload.configText);
  assert.equal(config.inbounds[0].users.length, 1);
  assert.equal(config.inbounds[0].users[0].name, "priya@vantage-bioworks.in");

  const completionResponse = await fetch(`${testApp.baseUrl}/api/node/tasks/${task.id}/complete`, {
    method: "POST",
    headers: { ...nodeHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      status: "succeeded",
      runtimeVersion: "1.13.12",
      validation: "sing-box"
    })
  });
  assert.equal(completionResponse.status, 200);

  const emptyResponse = await fetch(`${testApp.baseUrl}/api/node/tasks/next`, {
    headers: nodeHeaders
  });
  assert.equal(emptyResponse.status, 204);
});

test("revoking portal access invalidates an existing user session", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const portalLogin = await fetch(`${testApp.baseUrl}/api/portal/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "priya@vantage-bioworks.in",
      password: "raylink-demo"
    })
  });
  const portalCookie = portalLogin.headers.getSetCookie()[0].split(";")[0];
  const adminCookie = await login(testApp.baseUrl);
  const bootstrapResponse = await api(testApp.baseUrl, adminCookie, "/api/bootstrap");
  const bootstrap = await bootstrapResponse.json();
  const user = bootstrap.users.find((candidate) => candidate.email === "priya@vantage-bioworks.in");
  await api(testApp.baseUrl, adminCookie, `/api/users/${user.id}`, {
    method: "PATCH",
    body: JSON.stringify({ portalStatus: "invited" })
  });

  const configResponse = await fetch(`${testApp.baseUrl}/api/portal/config/sing-box`, {
    headers: { cookie: portalCookie }
  });
  assert.equal(configResponse.status, 403);
  assert.equal((await configResponse.json()).error.code, "ACCOUNT_NOT_ACTIVE");
});

test("portal refuses a client config when the user entitlement excludes the runtime region", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const adminCookie = await login(testApp.baseUrl);
  const bootstrapResponse = await api(testApp.baseUrl, adminCookie, "/api/bootstrap");
  const bootstrap = await bootstrapResponse.json();
  const user = bootstrap.users.find((candidate) => candidate.email === "priya@vantage-bioworks.in");
  await api(testApp.baseUrl, adminCookie, `/api/users/${user.id}`, {
    method: "PATCH",
    body: JSON.stringify({ nodeScope: ["frankfurt"] })
  });
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
  assert.equal(configResponse.status, 403);
  assert.equal((await configResponse.json()).error.code, "ENTITLEMENT_INACTIVE");
});

test("recorded usage at the user quota removes the user from runtime and blocks config download", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());
  const adminCookie = await login(testApp.baseUrl);
  const bootstrapResponse = await api(testApp.baseUrl, adminCookie, "/api/bootstrap");
  const bootstrap = await bootstrapResponse.json();
  const user = bootstrap.users.find((candidate) => candidate.email === "priya@vantage-bioworks.in");

  const updateResponse = await api(testApp.baseUrl, adminCookie, `/api/users/${user.id}`, {
    method: "PATCH",
    body: JSON.stringify({ usedGb: 320 })
  });
  assert.equal(updateResponse.status, 200);
  assert.equal((await updateResponse.json()).usedGb, 320);

  const previewResponse = await api(testApp.baseUrl, adminCookie, "/api/deployments/preview", {
    method: "POST"
  });
  assert.equal((await previewResponse.json()).eligibleUsers, 4);

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
  assert.equal(configResponse.status, 403);
  assert.equal((await configResponse.json()).error.code, "ENTITLEMENT_INACTIVE");
});

test("control plane serves the RayLink web application on the same origin", async (t) => {
  const testApp = await startTestApp();
  t.after(() => testApp.close());

  const indexResponse = await fetch(`${testApp.baseUrl}/`);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get("content-type"), /text\/html/);
  const indexHtml = await indexResponse.text();
  assert.match(indexHtml, /用户管理/);
  assert.doesNotMatch(indexHtml, /方案管理/);
  assert.match(indexHtml, /网络流量趋势/);
  assert.match(indexHtml, /dashboard-network-trend/);
  assert.match(indexHtml, /节点运行情况/);
  assert.match(indexHtml, /dashboard-node-health-grid/);
  assert.match(indexHtml, /来自 RayLink Node 的真实遥测/);
  assert.doesNotMatch(indexHtml, /按启用账号数量缩放趋势样例/);

  const scriptResponse = await fetch(`${testApp.baseUrl}/app.js`);
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type"), /javascript/);

  const nodeInstallerResponse = await fetch(`${testApp.baseUrl}/node/install.sh`);
  assert.equal(nodeInstallerResponse.status, 200);
  assert.match(nodeInstallerResponse.headers.get("content-type"), /text\/plain/);
  const nodeInstaller = await nodeInstallerResponse.text();
  assert.match(nodeInstaller, /raylink-node\.service/);
  assert.match(nodeInstaller, /installed_sing_box_version/);
  assert.match(nodeInstaller, /systemctl is-active --quiet sing-box\.service/);
  assert.match(nodeInstaller, /systemctl disable sing-box\.service/);
  assert.doesNotMatch(nodeInstaller, /disable --now sing-box\.service/);
  assert.ok(
    nodeInstaller.indexOf("systemctl is-active --quiet sing-box.service")
      < nodeInstaller.indexOf("https://sing-box.app/install.sh")
  );

  const nodeRuntimeResponse = await fetch(`${testApp.baseUrl}/node/raylink-node.mjs`);
  assert.equal(nodeRuntimeResponse.status, 200);
  assert.match(nodeRuntimeResponse.headers.get("content-type"), /javascript/);
  const nodeRuntime = await nodeRuntimeResponse.text();
  assert.match(nodeRuntime, /class RayLinkNode/);
  assert.match(nodeRuntime, /AGENT_VERSION = "0\.2\.0"/);

  const portalResponse = await fetch(`${testApp.baseUrl}/portal/`);
  assert.equal(portalResponse.status, 200);
  const portalHtml = await portalResponse.text();
  assert.match(portalHtml, /查看我的网络服务/);
  assert.match(portalHtml, /href="\/styles\.css"/);
  assert.match(portalHtml, /src="\/portal\.js"/);
});
