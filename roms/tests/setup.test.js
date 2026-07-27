import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createRayLinkApp } from "../server/app.js";
import { hashSessionSecret } from "../server/security.js";

const execFile = promisify(execFileCallback);

async function requestJson(baseUrl, path, { method = "GET", headers = {}, body = "" } = {}) {
  const target = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, {
      method,
      headers: {
        ...headers,
        ...(body ? { "content-length": Buffer.byteLength(body) } : {})
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

async function startSetupApp(overrides = {}) {
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
    },
    ...overrides
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

test("setup page assets load when previewed directly from disk", async () => {
  const setupPage = new URL("../web/setup.html", import.meta.url);
  const html = await readFile(setupPage, "utf8");
  const assetReferences = [
    ...html.matchAll(/(?:href|src)="([^"]+\.(?:css|js|svg)(?:\?[^"]*)?)"/g)
  ].map((match) => match[1]);

  assert.ok(assetReferences.length >= 4);
  for (const reference of assetReferences) {
    const asset = new URL(reference, setupPage);
    asset.search = "";
    await readFile(asset);
  }
});

test("setup form keeps validation feedback inside the RayLink interface", async () => {
  const setupPage = new URL("../web/setup.html", import.meta.url);
  const setupScript = new URL("../web/setup.js", import.meta.url);
  const [html, script] = await Promise.all([
    readFile(setupPage, "utf8"),
    readFile(setupScript, "utf8")
  ]);

  assert.match(html, /<form[^>]+id="setup-form"[^>]+novalidate/);
  assert.doesNotMatch(script, /\.reportValidity\(/);
  assert.match(script, /管理员密码至少需要 12 位/);
});

test("setup page exposes durable initialization progress instead of only disabling submit", async () => {
  const setupPage = new URL("../web/setup.html", import.meta.url);
  const setupScript = new URL("../web/setup.js", import.meta.url);
  const [html, script] = await Promise.all([
    readFile(setupPage, "utf8"),
    readFile(setupScript, "utf8")
  ]);

  assert.match(html, /id="setup-initialization-progress"/);
  assert.match(html, /data-initialization-stage="network"/);
  assert.match(html, /BBR 网络加速/);
  assert.match(html, /data-initialization-stage="runtime"/);
  assert.match(html, /data-initialization-stage="access"/);
  assert.match(html, /data-initialization-stage="account"/);
  assert.match(script, /monitorInitialization/);
  assert.match(script, /\/api\/setup\/status/);
});

test("address roles stay user-configurable and each Host exposes its own node address", async () => {
  const setupPage = new URL("../web/setup.html", import.meta.url);
  const setupScript = new URL("../web/setup.js", import.meta.url);
  const appScript = new URL("../web/app.js", import.meta.url);
  const [html, setup, app] = await Promise.all([
    readFile(setupPage, "utf8"),
    readFile(setupScript, "utf8"),
    readFile(appScript, "utf8")
  ]);

  assert.match(html, /这些是地址角色，不是固定域名/);
  assert.match(html, /当前 Host 独立配置/);
  assert.doesNotMatch(setup, /canonicalOrigin\.value = "https:\/\/panel\.example\.com"/);
  assert.doesNotMatch(setup, /subscriptionOrigin\.value = "https:\/\/sub\.example\.com"/);
  assert.doesNotMatch(setup, /runtimeAddress\.value = "node\.example\.com"/);
  assert.match(app, /节点连接地址（每台 Host 独立）/);
  assert.match(app, /每台 Host 可以使用不同的域名或公网 IP/);
});

test("setup-required instances without a token expose UNINITIALIZED until a token is generated", async (t) => {
  const testApp = await startSetupApp({
    setupTokenHash: "",
    setupTokenExpiresAt: ""
  });
  t.after(() => testApp.close());

  const status = await fetch(`${testApp.baseUrl}/api/setup/status`);
  assert.deepEqual(await status.json(), { state: "UNINITIALIZED", version: 1 });

  const complete = await fetch(`${testApp.baseUrl}/api/setup/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}"
  });
  assert.equal(complete.status, 409);
  assert.equal((await complete.json()).error.code, "SETUP_TOKEN_REQUIRED");
});

test("an uninitialized instance exposes only the setup flow", async (t) => {
  const testApp = await startSetupApp();
  t.after(() => testApp.close());

  const root = await fetch(`${testApp.baseUrl}/`, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/setup");

  const setup = await fetch(`${testApp.baseUrl}/setup`);
  assert.equal(setup.status, 200);
  assert.equal(setup.headers.get("cache-control"), "no-cache");
  const setupHtml = await setup.text();
  assert.match(setupHtml, /首次初始化 RayLink/);
  assert.match(setupHtml, /Caddy 自动 HTTPS/);
  assert.match(setupHtml, /name="certificateEmail"/);
  assert.match(setupHtml, /name="subscriptionOrigin"/);
  assert.match(setupHtml, /订阅服务地址/);
  assert.match(setupHtml, /节点连接地址/);

  const setupSlash = await fetch(`${testApp.baseUrl}/setup/`, { redirect: "manual" });
  assert.equal(setupSlash.status, 302);
  assert.equal(setupSlash.headers.get("location"), "/setup");

  const logo = await fetch(
    `${testApp.baseUrl}/assets/brand/raylink-mark.svg?v=20260726`
  );
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get("content-type"), /image\/svg\+xml/);

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
  testApp.app.store.updateSetupProgress({
    stage: "access",
    current: 2,
    total: 3,
    message: "正在配置 Caddy 与 HTTPS"
  });
  const initializing = await fetch(`${testApp.baseUrl}/api/setup/status`);
  const initializingStatus = await initializing.json();
  assert.equal(initializingStatus.state, "INITIALIZING");
  assert.deepEqual(
    {
      stage: initializingStatus.progress.stage,
      current: initializingStatus.progress.current,
      total: initializingStatus.progress.total,
      message: initializingStatus.progress.message
    },
    {
      stage: "access",
      current: 2,
      total: 3,
      message: "正在配置 Caddy 与 HTTPS"
    }
  );
  assert.match(initializingStatus.progress.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(initializingStatus.version, 1);

  const bootstrap = await fetch(`${testApp.baseUrl}/api/bootstrap`);
  assert.equal(bootstrap.status, 423);
  assert.equal((await bootstrap.json()).error.code, "SETUP_REQUIRED");

  testApp.app.store.failSetupInitialization();
  const recovered = await fetch(`${testApp.baseUrl}/api/setup/status`);
  assert.equal((await recovered.json()).state, "SETUP_PENDING");
});

test("IPv6 literals remain IP access origins through setup preflight", async (t) => {
  const testApp = await startSetupApp({
    publicOrigin: "https://[2001:db8::10]",
    trustProxy: true
  });
  t.after(() => testApp.close());

  const response = await requestJson(testApp.baseUrl, "/api/setup/preflight", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "[2001:db8::10]",
      "x-forwarded-proto": "https"
    },
    body: JSON.stringify({
      token: testApp.setupToken,
      access: {
        mode: "ip",
        canonicalOrigin: "https://[2001:db8::10]",
        allowedOrigins: ["https://[2001:db8::10]"]
      },
      certificate: { mode: "ip-self-signed" },
      admin: {
        username: "admin",
        password: "Production@Admin2026"
      },
      runtime: {
        name: "IPv6 Gateway",
        address: "[2001:db8::10]",
        region: "tokyo"
      }
    })
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.checks.accessOrigin, "passed");
});

test("the one-time setup token initializes access, admin, and local runtime", async (t) => {
  let bbrConfigurationCount = 0;
  const testApp = await startSetupApp({
    bbrManager: {
      async inspect() {
        return { status: "available" };
      },
      async configure() {
        bbrConfigurationCount += 1;
        return { status: "enabled" };
      }
    }
  });
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
    runtime: "development",
    bbr: "available"
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
  assert.equal(result.bbr, "enabled");
  assert.equal(bbrConfigurationCount, 1);
  assert.match(completed.headers.get("set-cookie"), /^raylink_session=/);
  const setupCookie = completed.headers.get("set-cookie").split(";")[0];

  const bootstrap = await fetch(`${testApp.baseUrl}/api/bootstrap`, {
    headers: { cookie: setupCookie }
  });
  assert.equal(bootstrap.status, 200);
  const cleanWorkspace = await bootstrap.json();
  assert.deepEqual(cleanWorkspace.users, []);
  assert.deepEqual(cleanWorkspace.hosts.map((host) => host.id), ["local"]);

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

test("domain setup activates Caddy from the IP initialization entry point", async (t) => {
  const calls = [];
  let releaseActivation;
  let reportActivationStarted;
  const activationStarted = new Promise((resolve) => {
    reportActivationStarted = resolve;
  });
  const setupAccessManager = {
    async preflight(input) {
      calls.push([
        "preflight",
        input.access.canonicalOrigin,
        input.access.subscriptionOrigin,
        input.runtime.address,
        input.certificate.email
      ]);
      return { dns: "passed", caddy: "passed" };
    },
    async activate(input) {
      calls.push([
        "activate",
        input.access.canonicalOrigin,
        input.access.subscriptionOrigin,
        input.runtime.address,
        input.certificate.email
      ]);
      reportActivationStarted();
      await new Promise((resolve) => {
        releaseActivation = resolve;
      });
      return { rollback: async () => calls.push(["rollback"]) };
    }
  };
  const testApp = await startSetupApp({ setupAccessManager });
  t.after(() => testApp.close());
  const payload = {
    token: testApp.setupToken,
    access: {
      mode: "domain",
      canonicalOrigin: "https://panel.example.com",
      subscriptionOrigin: "https://sub.example.com",
      allowedOrigins: [testApp.baseUrl]
    },
    certificate: {
      mode: "caddy-auto",
      email: "ops@example.com"
    },
    admin: {
      username: "admin",
      password: "Production@Admin2026"
    },
    runtime: {
      name: "Domain Gateway",
      address: "node.example.com",
      region: "tokyo"
    }
  };

  const preflight = await requestJson(testApp.baseUrl, "/api/setup/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(preflight.status, 200, JSON.stringify(preflight.body));
  assert.deepEqual(preflight.body.checks, {
    setupToken: "passed",
    accessOrigin: "configuration-ready",
    https: "automatic",
    runtime: "development",
    bbr: "development",
    dns: "passed",
    caddy: "passed"
  });

  const completionRequest = requestJson(testApp.baseUrl, "/api/setup/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  await activationStarted;
  const activeProgress = await requestJson(testApp.baseUrl, "/api/setup/status");
  assert.equal(activeProgress.status, 200);
  assert.deepEqual(
    {
      state: activeProgress.body.state,
      stage: activeProgress.body.progress.stage,
      current: activeProgress.body.progress.current,
      total: activeProgress.body.progress.total
    },
    {
      state: "INITIALIZING",
      stage: "access",
      current: 3,
      total: 4
    }
  );
  releaseActivation();
  const completed = await completionRequest;
  assert.equal(completed.status, 201, JSON.stringify(completed.body));
  assert.equal(completed.body.state, "READY");
  assert.equal(completed.body.redirectTo, "https://panel.example.com/");
  assert.deepEqual(
    testApp.app.store.setupStatus().access.allowedOrigins.sort(),
    ["http://127.0.0.1", testApp.baseUrl, "https://panel.example.com"].sort()
  );
  assert.equal(
    testApp.app.store.setupStatus().access.subscriptionOrigin,
    "https://sub.example.com"
  );
  assert.equal(testApp.app.store.getHost("local").address, "node.example.com");
  assert.deepEqual(calls, [
    [
      "preflight",
      "https://panel.example.com",
      "https://sub.example.com",
      "node.example.com",
      "ops@example.com"
    ],
    [
      "preflight",
      "https://panel.example.com",
      "https://sub.example.com",
      "node.example.com",
      "ops@example.com"
    ],
    [
      "activate",
      "https://panel.example.com",
      "https://sub.example.com",
      "node.example.com",
      "ops@example.com"
    ]
  ]);
});

test("automatic Caddy setup rejects a nonstandard HTTPS port", async (t) => {
  const testApp = await startSetupApp({
    setupAccessManager: {
      preflight: async () => ({ dns: "passed", caddy: "passed" }),
      activate: async () => ({ rollback: async () => {} })
    }
  });
  t.after(() => testApp.close());

  const response = await requestJson(testApp.baseUrl, "/api/setup/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: testApp.setupToken,
      access: {
        mode: "domain",
        canonicalOrigin: "https://panel.example.com:8443",
        allowedOrigins: [testApp.baseUrl]
      },
      certificate: {
        mode: "caddy-auto",
        email: "ops@example.com"
      },
      admin: {
        username: "admin",
        password: "Production@Admin2026"
      },
      runtime: {
        name: "Domain Gateway",
        address: "panel.example.com",
        region: "tokyo"
      }
    })
  });

  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, "CADDY_STANDARD_HTTPS_REQUIRED");

  const unsafeEmail = await requestJson(testApp.baseUrl, "/api/setup/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: testApp.setupToken,
      access: {
        mode: "domain",
        canonicalOrigin: "https://panel.example.com",
        allowedOrigins: [testApp.baseUrl]
      },
      certificate: {
        mode: "caddy-auto",
        email: "ops@example.com{"
      },
      admin: {
        username: "admin",
        password: "Production@Admin2026"
      },
      runtime: {
        name: "Domain Gateway",
        address: "panel.example.com",
        region: "tokyo"
      }
    })
  });
  assert.equal(unsafeEmail.status, 422);
  assert.equal(unsafeEmail.body.error.code, "INVALID_SETUP_INPUT");
});

test("a failed Caddy activation leaves first-run setup retryable", async (t) => {
  const activationError = Object.assign(new Error("certificate challenge failed"), {
    code: "CADDY_ACTIVATION_FAILED",
    statusCode: 502
  });
  const testApp = await startSetupApp({
    setupAccessManager: {
      preflight: async () => ({ dns: "passed", caddy: "passed" }),
      activate: async () => {
        throw activationError;
      }
    }
  });
  t.after(() => testApp.close());
  const response = await requestJson(testApp.baseUrl, "/api/setup/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: testApp.setupToken,
      access: {
        mode: "domain",
        canonicalOrigin: "https://panel.example.com",
        allowedOrigins: [testApp.baseUrl]
      },
      certificate: {
        mode: "caddy-auto",
        email: "ops@example.com"
      },
      admin: {
        username: "admin",
        password: "Production@Admin2026"
      },
      runtime: {
        name: "Domain Gateway",
        address: "panel.example.com",
        region: "tokyo"
      }
    })
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, "CADDY_ACTIVATION_FAILED");
  const status = await fetch(`${testApp.baseUrl}/api/setup/status`);
  assert.equal((await status.json()).state, "SETUP_PENDING");
  const login = await fetch(`${testApp.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "Production@Admin2026"
    })
  });
  assert.equal(login.status, 423);
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
  assert.match(installer, /自动检测到私网地址/);
  assert.ok(
    installer.indexOf('public_ip="${RAYLINK_PUBLIC_IP:-}"')
      < installer.indexOf('install -d -m 0755 "$install_root"'),
    "public address validation must happen before the installation root is created"
  );
  assert.match(installer, /systemctl enable sing-box-raylink/);
  assert.match(installer, /RAYLINK_BBR_CONFIG=\$\{managed_root\}\/99-raylink-bbr\.conf/);
  assert.match(
    installer,
    /ln -sfn "\$managed_root\/99-raylink-bbr\.conf" \/etc\/sysctl\.d\/99-raylink-bbr\.conf/
  );
  assert.match(
    installer,
    /web\/node\/runtime\/raylink-sing-box-\$\{runtime_version\}-linux-\$\{runtime_arch\}/
  );
  assert.match(installer, /未找到预编译 Runtime，回退到本机编译/);
  assert.match(installer, /with_naive_outbound/);
  assert.match(installer, /with_v2ray_api/);
  assert.doesNotMatch(installer, /\$source_root\/data/);
  const artifactBuilder = await readFile(
    new URL("../deploy/build-runtime-artifact.sh", import.meta.url),
    "utf8"
  );
  assert.match(artifactBuilder, /web\/node\/runtime/);
  assert.match(artifactBuilder, /RAYLINK_TARGET_ARCH="\$runtime_arch"/);
  assert.match(
    artifactBuilder,
    /output_root="\$\(CDPATH= cd -- "\$output_root" && pwd\)"/
  );
  const runtimeBuilder = await readFile(
    new URL("../web/node/build-metered-runtime.sh", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(runtimeBuilder, /go\.dev\/dl\/\$\{archive\}\.sha256/);
  assert.match(
    runtimeBuilder,
    /da18191ddb7db8a9339816f3e2b54bdded8047cdc2a5d67059478f8d1595c43f/
  );
  assert.match(
    runtimeBuilder,
    /fd2bccce882e29369f56c86487663bb78ba7ea9e02188a5b0269303a0c3d33ab/
  );
  assert.ok(
    runtimeBuilder.includes(
      String.raw`sed -n 's/^[[:space:]]*"Sum": "\([^"]*\)",[[:space:]]*$/\1/p'`
    ),
    "the approved sing-box module checksum must be parsed from go mod JSON"
  );
  assert.match(
    runtimeBuilder,
    /github\.com\/sagernet\/sing-box\/constant\.Version=\$\{SING_BOX_VERSION\}/
  );
  assert.match(rotator, /systemctl restart raylink/);
  assert.match(rotator, /\/setup#token=/);
  assert.doesNotMatch(rotator, /RAYLINK_SETUP_TOKEN=/);
});

test("the release package keeps every installer dependency executable", async () => {
  for (const relativePath of [
    "../web/node/build-metered-runtime.sh",
    "../deploy/build-runtime-artifact.sh",
    "../deploy/install.sh",
    "../deploy/package-release.sh"
  ]) {
    const dependency = await stat(new URL(relativePath, import.meta.url));
    assert.notEqual(
      dependency.mode & 0o111,
      0,
      `${relativePath} must be executable in the release package`
    );
  }
});

test("one-command bootstrap verifies and prepares the matching release package", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-bootstrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = "0.2.5";
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  const releaseDirectory = join(directory, `v${version}`);
  const packageDirectory = join(directory, `raylink-${version}`);
  const packageDeployDirectory = join(packageDirectory, "deploy");
  const installRecordPath = join(directory, "install-record.txt");
  const fakeBinDirectory = join(directory, "bin");
  const armBinDirectory = join(directory, "arm-bin");
  await mkdir(releaseDirectory, { recursive: true });
  await mkdir(packageDeployDirectory, { recursive: true });
  await mkdir(fakeBinDirectory, { recursive: true });
  await mkdir(armBinDirectory, { recursive: true });
  await writeFile(
    join(packageDeployDirectory, "install-control-plane.sh"),
    [
      "#!/usr/bin/env bash",
      "printf '%s' \"${RAYLINK_PUBLIC_IP:-}\" > \"${INSTALL_RECORD_PATH:?}\"",
      "exit \"${INSTALL_EXIT_CODE:-0}\"",
      ""
    ].join("\n")
  );
  await writeFile(join(directory, `._raylink-${version}`), "appledouble metadata");
  await writeFile(join(packageDirectory, "._package.json"), "appledouble metadata");
  const archiveName = `raylink-${version}-linux-${architecture}.tar.gz`;
  const archivePath = join(releaseDirectory, archiveName);
  await execFile("tar", [
    "-czf",
    archivePath,
    "-C",
    directory,
    `._raylink-${version}`,
    `raylink-${version}`
  ]);
  const digest = createHash("sha256").update(await readFile(archivePath)).digest("hex");
  await writeFile(
    `${archivePath}.sha256`,
    `${digest}  ${archiveName}\n`
  );

  const result = await execFile("bash", [
    new URL("../deploy/install.sh", import.meta.url).pathname,
    "--dry-run",
    "--public-ip",
    "203.0.113.10",
    "--release-base-url",
    `file://${directory}`
  ]);

  assert.match(result.stdout, new RegExp(`RayLink v${version.replaceAll(".", "\\.")}`));
  assert.match(result.stdout, new RegExp(`linux-${architecture}`));
  assert.match(result.stdout, /SHA-256 校验通过/);
  assert.match(result.stdout, /RAYLINK_PUBLIC_IP=203\.0\.113\.10/);
  assert.match(result.stdout, /deploy\/install-control-plane\.sh/);

  await writeFile(
    `${archivePath}.sha256`,
    `${"0".repeat(64)}  ${archiveName}\n`
  );
  await assert.rejects(
    () => execFile("bash", [
      new URL("../deploy/install.sh", import.meta.url).pathname,
      "--dry-run",
      "--version",
      version,
      "--release-base-url",
      `file://${directory}`
    ]),
    (error) => {
      assert.match(error.stderr, /SHA-256 校验失败/);
      return true;
    }
  );

  await writeFile(
    `${archivePath}.sha256`,
    `${digest}  ${archiveName}\n`
  );
  await writeFile(
    join(fakeBinDirectory, "uname"),
    [
      "#!/usr/bin/env bash",
      "case \"${1:-}\" in",
      "  -s) printf 'Linux\\n' ;;",
      `  -m) printf '${architecture === "arm64" ? "aarch64" : "x86_64"}\\n' ;;`,
      "  *) /usr/bin/uname \"$@\" ;;",
      "esac",
      ""
    ].join("\n")
  );
  await writeFile(
    join(fakeBinDirectory, "id"),
    "#!/usr/bin/env bash\n[ \"${1:-}\" = '-u' ] && printf '0\\n' || /usr/bin/id \"$@\"\n"
  );
  await chmod(join(fakeBinDirectory, "uname"), 0o755);
  await chmod(join(fakeBinDirectory, "id"), 0o755);

  const installerEnvironment = {
    ...process.env,
    PATH: `${fakeBinDirectory}:${process.env.PATH}`,
    INSTALL_RECORD_PATH: installRecordPath
  };
  const installerArguments = [
    new URL("../deploy/install.sh", import.meta.url).pathname,
    "--public-ip",
    "203.0.113.10",
    "--version",
    version,
    "--release-base-url",
    `file://${directory}`
  ];
  await execFile("bash", installerArguments, { env: installerEnvironment });
  assert.equal(await readFile(installRecordPath, "utf8"), "203.0.113.10");

  await assert.rejects(
    () => execFile("bash", installerArguments, {
      env: {
        ...installerEnvironment,
        INSTALL_EXIT_CODE: "23"
      }
    }),
    (error) => {
      assert.equal(error.code, 23);
      return true;
    }
  );

  await assert.rejects(
    () => execFile("bash", [
      new URL("../deploy/install.sh", import.meta.url).pathname,
      "--public-ip",
      "--dry-run"
    ]),
    (error) => {
      assert.match(error.stderr, /--public-ip 缺少参数/);
      return true;
    }
  );

  await writeFile(
    join(armBinDirectory, "uname"),
    [
      "#!/usr/bin/env bash",
      "case \"${1:-}\" in",
      "  -s) printf 'Linux\\n' ;;",
      "  -m) printf 'aarch64\\n' ;;",
      "  *) /usr/bin/uname \"$@\" ;;",
      "esac",
      ""
    ].join("\n")
  );
  await chmod(join(armBinDirectory, "uname"), 0o755);
  await assert.rejects(
    () => execFile("bash", [
      new URL("../deploy/install.sh", import.meta.url).pathname,
      "--dry-run"
    ], {
      env: {
        ...process.env,
        PATH: `${armBinDirectory}:${process.env.PATH}`
      }
    }),
    (error) => {
      assert.match(error.stderr, /官方发布包目前仅提供 linux-amd64/);
      return true;
    }
  );
});
