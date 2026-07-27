import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { RayLinkStore } from "./database.js";
import { validateNodeEncryptionPublicKey } from "./node-secrets.js";
import { CaddySetupAccessManager } from "./setup-access.js";
import { buildUserClientConfig } from "./singbox/client-config.js";
import {
  APPROVED_METERED_RUNTIME_VERSION,
  SingBoxInstaller
} from "./singbox/installer.js";
import { LocalSingBoxAdapter } from "./singbox/local-adapter.js";
import { ManagedRuleSetCache } from "./singbox/rule-set-cache.js";
import {
  protocolAvailability,
  protocolCatalog
} from "./singbox/protocol-catalog.js";
import { RuntimeManager } from "./singbox/runtime-manager.js";
import { LocalTelemetryCollector } from "./telemetry.js";
import { RemoteTlsAssetPackager } from "./tls-assets.js";
import {
  systemdRuntimeInstanceId,
  V2RayStatsCollector
} from "./usage/v2ray-stats.js";

const SESSION_COOKIE = "raylink_session";
const PORTAL_SESSION_COOKIE = "raylink_portal_session";
const REQUIRED_NODE_AGENT_VERSION = "0.5.0";
const defaultWebDir = fileURLToPath(new URL("../web", import.meta.url));

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml"
};

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").flatMap((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 0) return [];
    return [[entry.slice(0, separator).trim(), decodeURIComponent(entry.slice(separator + 1).trim())]];
  }));
}

function bearerToken(header = "") {
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

async function readJson(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("请求内容过大");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求不是有效的 JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...headers
  });
  response.end(payload);
}

function httpError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function versionIsOlder(currentVersion, targetVersion) {
  const current = String(currentVersion || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  const target = String(targetVersion || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!current || !target) return false;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(target[index]) - Number(current[index]);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function sendSubscriptionJson(request, response, body) {
  const payload = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(payload).digest("hex")}"`;
  const headers = {
    "cache-control": "private, no-cache",
    "content-disposition": 'attachment; filename="raylink-sing-box.json"',
    etag,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow"
  };
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  sendJson(response, 200, body, headers);
}

async function sendStatic(response, webDir, pathname) {
  const relativePath = pathname === "/"
    ? "index.html"
    : ["/setup", "/setup/"].includes(pathname)
      ? "setup.html"
    : ["/portal", "/portal/"].includes(pathname)
      ? "portal.html"
      : decodeURIComponent(pathname).replace(/^\/+/, "");
  const filePath = resolve(webDir, relativePath);
  if (filePath !== webDir && !filePath.startsWith(`${webDir}${sep}`)) return false;
  try {
    const payload = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
      "content-length": payload.length,
      "cache-control": filePath.endsWith(".html") ? "no-cache" : "public, max-age=300",
      "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=()"
    });
    response.end(payload);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return false;
    throw error;
  }
}

function normalizedOrigin(value, fieldName) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw httpError("INVALID_SETUP_INPUT", `${fieldName}不是有效地址`, 422);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw httpError("INVALID_SETUP_INPUT", `${fieldName}必须是仅包含协议、域名或 IP 和端口的地址`, 422);
  }
  if (
    url.protocol !== "https:"
    && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  ) {
    throw httpError("HTTPS_REQUIRED", `${fieldName}在非本机环境必须使用 HTTPS`, 422);
  }
  return url.origin;
}

function normalizeSetupInput(body) {
  const accessMode = String(body.access?.mode || "");
  if (!["domain", "ip"].includes(accessMode)) {
    throw httpError("INVALID_SETUP_INPUT", "请选择域名或 IP 访问模式", 422);
  }
  const canonicalOrigin = normalizedOrigin(body.access?.canonicalOrigin, "主访问地址");
  const subscriptionOrigin = normalizedOrigin(
    body.access?.subscriptionOrigin || canonicalOrigin,
    "订阅服务地址"
  );
  const canonicalHost = new URL(canonicalOrigin).hostname.replace(/^\[|\]$/g, "");
  const subscriptionHost = new URL(subscriptionOrigin).hostname.replace(/^\[|\]$/g, "");
  if (accessMode === "domain" && isIP(canonicalHost)) {
    throw httpError("INVALID_SETUP_INPUT", "域名访问模式不能填写 IP 地址", 422);
  }
  if (accessMode === "domain" && isIP(subscriptionHost)) {
    throw httpError("INVALID_SETUP_INPUT", "订阅服务地址必须填写域名", 422);
  }
  if (accessMode === "ip" && !isIP(canonicalHost) && canonicalHost !== "localhost") {
    throw httpError("INVALID_SETUP_INPUT", "IP 访问模式必须填写 IP 地址", 422);
  }
  const allowedOrigins = [
    canonicalOrigin,
    ...(Array.isArray(body.access?.allowedOrigins) ? body.access.allowedOrigins : [])
  ].map((origin) => normalizedOrigin(origin, "允许的管理端地址"));
  const uniqueAllowedOrigins = [...new Set(allowedOrigins)];
  if (uniqueAllowedOrigins.length > 8) {
    throw httpError("INVALID_SETUP_INPUT", "最多允许配置 8 个管理端地址", 422);
  }

  const certificateMode = String(body.certificate?.mode || "");
  const certificateModes = accessMode === "domain"
    ? ["caddy-auto", "external"]
    : ["external", "ip-self-signed"];
  if (!certificateModes.includes(certificateMode)) {
    throw httpError("INVALID_SETUP_INPUT", "证书模式与当前访问方式不匹配", 422);
  }
  if (
    certificateMode === "caddy-auto"
    && (new URL(canonicalOrigin).port || new URL(subscriptionOrigin).port)
  ) {
    throw httpError(
      "CADDY_STANDARD_HTTPS_REQUIRED",
      "Caddy 自动 HTTPS 的控制台和订阅地址需要使用标准 443 端口",
      422
    );
  }
  const certificateEmail = String(body.certificate?.email || "").trim().toLowerCase();
  if (
    certificateMode === "caddy-auto"
    && !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(certificateEmail)
  ) {
    throw httpError("INVALID_SETUP_INPUT", "请输入有效的证书通知邮箱", 422);
  }

  const username = String(body.admin?.username || "").trim();
  const password = String(body.admin?.password || "");
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    throw httpError("INVALID_SETUP_INPUT", "管理员用户名需为 3–64 位字母、数字或 ._-", 422);
  }
  const passwordClasses = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password)
  ].filter(Boolean).length;
  if (password.length < 12 || passwordClasses < 3) {
    throw httpError("INVALID_SETUP_INPUT", "管理员密码至少 12 位，并包含至少三类字符", 422);
  }

  const runtime = {
    name: String(body.runtime?.name || "").trim(),
    address: String(body.runtime?.address || "").trim(),
    region: String(body.runtime?.region || "").trim()
  };

  return {
    access: {
      mode: accessMode,
      canonicalOrigin,
      subscriptionOrigin,
      allowedOrigins: uniqueAllowedOrigins
    },
    certificate: {
      mode: certificateMode,
      ...(certificateMode === "caddy-auto" ? { email: certificateEmail } : {})
    },
    admin: { username, password },
    runtime
  };
}

function setupStateError(state) {
  if (state === "INITIALIZING") {
    return httpError("SETUP_IN_PROGRESS", "RayLink 正在初始化", 409);
  }
  if (state === "UNINITIALIZED") {
    return httpError(
      "SETUP_TOKEN_REQUIRED",
      "尚未生成初始化令牌，请在服务器运行令牌轮换命令",
      409
    );
  }
  return httpError("SETUP_ALREADY_COMPLETE", "RayLink 已完成初始化", 409);
}

function sessionCookie(name, secret, expiresAt, secure) {
  return [
    `${name}=${encodeURIComponent(secret)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    `Expires=${new Date(expiresAt).toUTCString()}`
  ].filter(Boolean).join("; ");
}

function clearedSessionCookie(name, secure) {
  return [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0"
  ].filter(Boolean).join("; ");
}

export async function createRayLinkApp(options) {
  const dbPath = options.dbPath || join(options.dataDir, "raylink.db");
  const publicOrigin = new URL(options.publicOrigin);
  const configuredSubscriptionOrigin = new URL(options.subscriptionOrigin || publicOrigin);
  const proxyHost = options.proxyHost || publicOrigin.hostname;
  const listenPort = options.listenPort || 8388;
  const store = new RayLinkStore({
    dbPath,
    adminUsername: options.adminUsername,
    adminPassword: options.adminPassword,
    initialHostAddress: proxyHost,
    initialListenPort: listenPort,
    seedDemoData: options.seedDemoData,
    nodeTaskRetryBaseMs: options.nodeTaskRetryBaseMs,
    setupRequired: options.setupRequired,
    setupTokenHash: options.setupTokenHash,
    setupTokenExpiresAt: options.setupTokenExpiresAt
  });
  const currentPublicOrigin = () => {
    const configured = store.setupStatus().access?.canonicalOrigin;
    return configured ? new URL(configured) : publicOrigin;
  };
  const currentSubscriptionOrigin = () => {
    const configured = store.setupStatus().access?.subscriptionOrigin;
    return configured ? new URL(configured) : configuredSubscriptionOrigin;
  };
  const requestOriginIsAllowed = (request) => {
    const requestOrigin = request.headers.origin;
    if (!requestOrigin) return true;
    const allowedOrigins = store.setupStatus().access?.allowedOrigins
      || [currentPublicOrigin().origin];
    return allowedOrigins.includes(requestOrigin);
  };
  const webDir = resolve(options.webDir || defaultWebDir);
  const runtimeAdapter = options.runtimeAdapter || new LocalSingBoxAdapter({
    dataDir: options.dataDir,
    binaryPath: options.singBoxBinary || "sing-box",
    mode: options.runtimeMode || "dry-run",
    systemdUnit: options.systemdUnit || "sing-box.service"
  });
  const tlsAssetPackager = options.tlsAssetPackager || new RemoteTlsAssetPackager({
    remoteDataDir: options.remoteNodeDataDir
  });
  const runtimeManager = new RuntimeManager({
    store,
    adapter: runtimeAdapter,
    listenPort,
    tlsAssetPackager
  });
  const ruleSetCache = options.ruleSetCache || new ManagedRuleSetCache({
    dataDir: options.dataDir,
    fetchImpl: options.ruleSetFetch
  });
  const refreshRuleSets = () => ruleSetCache.prepare().catch((error) => {
    console.warn(`[RayLink] Managed rule-set refresh failed: ${error.message}`);
  });
  refreshRuleSets();
  const localTelemetryCollector = new LocalTelemetryCollector();
  const telemetryProvider = options.telemetryProvider
    || ((runtime) => localTelemetryCollector.collect(runtime));
  const telemetryIntervalMs = Math.max(10, Number(options.telemetryIntervalMs || 10_000));
  const entitlementReconcileIntervalMs = Math.max(
    1_000,
    Number(options.entitlementReconcileIntervalMs || 60_000)
  );
  let telemetryTimer = null;
  let telemetrySamplePromise = null;
  let entitlementReconcileTimer = null;
  let ruleSetRefreshTimer = null;
  let runtimeUpdateTimer = null;
  let usageMeteringTimer = null;
  let usageMeteringPromise = null;
  let operationalMaintenanceTimer = null;
  let localRuntimeOperation = null;
  const operationalMaintenanceIntervalMs = Math.max(
    60_000,
    Number(options.operationalMaintenanceIntervalMs || 60 * 60 * 1000)
  );
  const runOperationalMaintenance = () => {
    try {
      return store.performOperationalMaintenance();
    } catch (error) {
      console.warn(`[RayLink] Operational maintenance failed: ${error.message}`);
      return null;
    }
  };
  const runLocalRuntimeOperation = async (operation, callback) => {
    if (localRuntimeOperation) {
      throw httpError(
        "RUNTIME_OPERATION_IN_PROGRESS",
        `Runtime 正在执行${localRuntimeOperation}，请完成后再试`,
        409
      );
    }
    localRuntimeOperation = operation;
    try {
      return await callback();
    } finally {
      localRuntimeOperation = null;
    }
  };
  const sampleLocalTelemetry = () => {
    if (telemetrySamplePromise) return telemetrySamplePromise;
    telemetrySamplePromise = (async () => {
      try {
        const runtime = await runtimeManager.status();
        store.recordHostTelemetry("local", await telemetryProvider(runtime));
      } catch (error) {
        console.warn(`[RayLink] Local telemetry sample failed: ${error.message}`);
      }
    })().finally(() => {
      telemetrySamplePromise = null;
    });
    return telemetrySamplePromise;
  };
  const installer = options.installer || new SingBoxInstaller({
    binaryPath: options.singBoxBinary || "sing-box",
    dataDir: options.dataDir,
    activeConfigPath: runtimeAdapter.activePath,
    runtimeMode: options.runtimeMode || "dry-run",
    systemdUnit: options.systemdUnit || "sing-box.service",
    preferMeteredRuntime: options.preferMeteredRuntime,
    meteredRuntimeBuilder: options.meteredRuntimeBuilder,
    fetchImpl: options.runtimeReleaseFetch
  });
  const requestOriginFor = (request) => {
    const forwardedProtocol = options.trustProxy
      ? String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim()
      : "";
    const requestProtocol = ["http", "https"].includes(forwardedProtocol)
      ? forwardedProtocol
      : request.socket.encrypted
        ? "https"
        : "http";
    return request.headers.host ? `${requestProtocol}://${request.headers.host}` : "";
  };
  const setupAccessManager = options.setupAccessManager || new CaddySetupAccessManager({
    caddyfilePath: options.caddyfilePath || "/etc/caddy/Caddyfile",
    environmentFilePath: options.environmentFilePath || "/etc/raylink/raylink.env",
    initialOrigin: publicOrigin.origin,
    certificatePath: options.controlPlaneCertificatePath
      || "/etc/caddy/raylink/control-plane.crt",
    privateKeyPath: options.controlPlanePrivateKeyPath
      || "/etc/caddy/raylink/control-plane.key",
    caddyBinary: options.caddyBinary || "caddy"
  });
  const preserveAutomaticRecoveryOrigin = (input) => {
    if (
      input.certificate.mode === "caddy-auto"
      && !input.access.allowedOrigins.includes(publicOrigin.origin)
    ) {
      input.access.allowedOrigins.push(publicOrigin.origin);
    }
  };
  const preflightSetup = async (request, input) => {
    const requestOrigin = requestOriginFor(request);
    const automaticDomain = input.certificate.mode === "caddy-auto";
    if (
      automaticDomain
        ? requestOrigin !== publicOrigin.origin
          && !input.access.allowedOrigins.includes(requestOrigin)
        : requestOrigin !== input.access.canonicalOrigin
    ) {
      throw httpError(
        "SETUP_ORIGIN_NOT_ACTIVE",
        automaticDomain
          ? "请通过当前 IP 初始化入口配置域名"
          : "请先通过主访问地址打开初始化链接，确认 DNS 与 HTTPS 可用后再完成初始化",
        422
      );
    }
    const accessChecks = automaticDomain
      ? await setupAccessManager.preflight(input)
      : {};
    const installation = await installer.status();
    if (options.runtimeMode === "systemd") {
      if (!installation.installed) {
        throw httpError("RUNTIME_NOT_INSTALLED", "未检测到 sing-box Runtime", 409);
      }
      if (!installation.tags.includes("with_v2ray_api")) {
        throw httpError(
          "METERING_BUILD_MISSING",
          "sing-box Runtime 缺少 with_v2ray_api，不能用于正式用户计量",
          409
        );
      }
    }
    return {
      checks: {
        setupToken: "passed",
        accessOrigin: automaticDomain ? "configuration-ready" : "passed",
        https: automaticDomain
          ? "automatic"
          : new URL(input.access.canonicalOrigin).protocol === "https:"
            ? "passed"
            : "development",
        runtime: options.runtimeMode === "systemd" ? "passed" : "development",
        ...accessChecks
      }
    };
  };
  const refreshLocalRuntimeCapabilities = async () => {
    const installation = await installer.status();
    store.updateLocalRuntimeCapabilities(installation);
    return installation;
  };
  const usageCollector = options.usageCollector || new V2RayStatsCollector({
    endpoint: options.v2rayStatsEndpoint || "http://127.0.0.1:10085",
    runtimeInstanceProvider: () => systemdRuntimeInstanceId(
      options.systemdUnit || "sing-box.service"
    )
  });
  const usageMeteringIntervalMs = Math.max(
    1_000,
    Number(options.usageMeteringIntervalMs || 30_000)
  );
  const sampleLocalUsage = () => {
    if (usageMeteringPromise) return usageMeteringPromise;
    if (!store.getHost("local")?.usageMetering.supported) return Promise.resolve(null);
    usageMeteringPromise = (async () => {
      try {
        const result = store.recordUsageSnapshot("local", await usageCollector.collect());
        if (result.quotaExceededUserIds.length) {
          await reconcileUserEntitlements(null, {
            forceCritical: true,
            reason: "usage-quota-enforcement"
          });
        }
        return result;
      } catch (error) {
        store.recordUsageMeteringError("local", error.message);
        console.warn(`[RayLink] Local user usage sample failed: ${error.message}`);
        return null;
      }
    })().finally(() => {
      usageMeteringPromise = null;
    });
    return usageMeteringPromise;
  };
  const runtimeUpdateCheckIntervalMs = Math.max(
    0,
    Number(options.runtimeUpdateCheckIntervalMs ?? 6 * 60 * 60 * 1000)
  );
  const refreshRuntimeUpdate = () => {
    if (typeof installer.checkForUpdates !== "function") return Promise.resolve(null);
    return installer.checkForUpdates().catch((error) => {
      console.warn(`[RayLink] sing-box update check failed: ${error.message}`);
      return null;
    });
  };
  const buildClientConfigForUser = async (userId) => {
    const credential = store.clientCredential(userId);
    if (!credential) throw httpError("USER_NOT_FOUND", "用户不存在", 404);
    const expiresAt = new Date(`${credential.expiresAt}T23:59:59.999Z`);
    const runtime = await runtimeManager.status();
    const allowStagedClientConfigs = options.allowStagedClientConfigs
      ?? process.env.NODE_ENV !== "production";
    const eligibleHosts = store.listClientHosts().filter((host) => {
      const metricsAgeMs = host.telemetry.updatedAt
        ? Date.now() - new Date(host.telemetry.updatedAt).getTime()
        : Number.POSITIVE_INFINITY;
      const connected = host.id === "local"
        ? runtime.state === "running" || allowStagedClientConfigs
        : host.status === "online"
          && host.telemetry.serviceStatus === "running"
          && metricsAgeMs <= 30_000;
      const regionAllowed = credential.nodeScope.includes("all")
        || credential.nodeScope.includes(host.region);
      return connected && regionAllowed;
    }).map((host) => ({
      ...host,
      protocols: host.appliedProtocols
    }));
    if (
      !["active", "warning"].includes(credential.state)
      || credential.portalStatus !== "active"
      || credential.usedGb >= credential.quotaGb
      || expiresAt < new Date()
      || !eligibleHosts.length
    ) {
      throw httpError("ENTITLEMENT_INACTIVE", "账号当前不可使用", 403);
    }
    if (!credential.clientFormats.includes("sing-box")) {
      throw httpError("FORMAT_NOT_ALLOWED", "当前用户未启用 sing-box 配置", 403);
    }
    return buildUserClientConfig({
      credential,
      hosts: eligibleHosts,
      ruleSetBaseUrl: ruleSetCache.available()
        ? new URL("/rule-sets/", currentSubscriptionOrigin()).toString()
        : null
    });
  };
  const reconcileUserEntitlements = async (publisherAdminId, reconcileOptions = {}) => {
    try {
      const result = await runLocalRuntimeOperation(
        "配置同步",
        () => runtimeManager.reconcile(publisherAdminId, reconcileOptions)
      );
      return {
        status: result.changed ? "published" : "current",
        reason: result.reason || null
      };
    } catch (error) {
      console.warn(`[RayLink] User entitlement saved; runtime publication pending: ${error.message}`);
      return {
        status: "pending",
        message: "用户变更已保存，运行配置发布失败，系统将自动重试"
      };
    }
  };
  const authAttempts = new Map();
  const nodeHeartbeatWrites = new Map();
  const nodeHeartbeatMinIntervalMs = Math.max(0, Number(options.nodeHeartbeatMinIntervalMs ?? 5_000));
  const authWindowMs = 10 * 60 * 1000;
  const authAttemptLimit = 8;
  const clientAddress = (request) => {
    if (options.trustProxy) {
      const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
      if (forwarded) return forwarded;
    }
    return request.socket.remoteAddress || "unknown";
  };
  const authKey = (request, kind) => [clientAddress(request), kind].join("|");
  const authAllowed = (key) => {
    const now = Date.now();
    if (authAttempts.size > 10_000) {
      for (const [candidateKey, candidate] of authAttempts) {
        if (candidate.resetAt <= now || authAttempts.size > 9_000) authAttempts.delete(candidateKey);
        if (authAttempts.size <= 9_000) break;
      }
    }
    const entry = authAttempts.get(key);
    if (!entry || entry.resetAt <= now) {
      authAttempts.set(key, { count: 0, resetAt: now + authWindowMs });
      return true;
    }
    return entry.count < authAttemptLimit;
  };
  const recordAuthFailure = (key) => {
    const entry = authAttempts.get(key);
    if (entry) entry.count += 1;
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, currentPublicOrigin());
      const setup = store.setupStatus();
      const subscriptionOrigin = currentSubscriptionOrigin();
      let requestHostname = "";
      try {
        const forwardedHost = options.trustProxy
          ? String(request.headers["x-forwarded-host"] || "").split(",")[0].trim()
          : "";
        requestHostname = new URL(
          `http://${forwardedHost || request.headers.host || ""}`
        ).hostname;
      } catch {
        requestHostname = "";
      }
      const subscriptionOnlyHost = subscriptionOrigin.hostname !== currentPublicOrigin().hostname
        && requestHostname === subscriptionOrigin.hostname;
      if (
        subscriptionOnlyHost
        && !url.pathname.startsWith("/sub/")
        && !url.pathname.startsWith("/rule-sets/")
      ) {
        sendJson(response, 404, {
          error: { code: "NOT_FOUND", message: "接口不存在" }
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/setup/status") {
        sendJson(response, 200, {
          state: setup.state,
          ...(setup.state === "SETUP_PENDING" ? { expiresAt: setup.expiresAt } : {}),
          ...(setup.state === "INITIALIZING" && setup.progress
            ? { progress: setup.progress }
            : {}),
          version: 1
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/setup/preflight") {
        if (setup.state !== "SETUP_PENDING") {
          throw setupStateError(setup.state);
        }
        const attemptKey = authKey(request, "setup");
        if (!authAllowed(attemptKey)) {
          throw httpError("RATE_LIMITED", "初始化令牌尝试过多，请稍后再试", 429);
        }
        const body = await readJson(request);
        if (!store.verifySetupToken(body.token)) {
          recordAuthFailure(attemptKey);
          throw httpError("SETUP_TOKEN_INVALID", "初始化令牌无效或已经过期", 401);
        }
        const input = normalizeSetupInput(body);
        preserveAutomaticRecoveryOrigin(input);
        input.runtime = store.normalizeHostUpdate("local", input.runtime);
        sendJson(response, 200, await preflightSetup(request, input));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/setup/complete") {
        if (setup.state !== "SETUP_PENDING") {
          throw setupStateError(setup.state);
        }
        const attemptKey = authKey(request, "setup");
        if (!authAllowed(attemptKey)) {
          throw httpError("RATE_LIMITED", "初始化令牌尝试过多，请稍后再试", 429);
        }
        const body = await readJson(request);
        if (!store.verifySetupToken(body.token)) {
          recordAuthFailure(attemptKey);
          throw httpError("SETUP_TOKEN_INVALID", "初始化令牌无效或已经过期", 401);
        }
        const input = normalizeSetupInput(body);
        preserveAutomaticRecoveryOrigin(input);
        input.runtime = store.normalizeHostUpdate("local", input.runtime);
        await preflightSetup(request, input);
        store.beginSetupInitialization();
        let accessActivation = null;
        try {
          store.updateSetupProgress({
            stage: "runtime",
            current: 1,
            total: 3,
            message: options.runtimeMode === "systemd"
              ? "正在发布本机 sing-box Runtime"
              : "正在准备本机 sing-box Runtime"
          });
          if (options.runtimeMode === "systemd") {
            await runLocalRuntimeOperation(
              "首次配置发布",
              () => runtimeManager.publish(null)
            );
          }
          store.updateSetupProgress({
            stage: "access",
            current: 2,
            total: 3,
            message: input.certificate.mode === "caddy-auto"
              ? "正在配置 Caddy 并申请 HTTPS 证书"
              : "正在应用访问入口配置"
          });
          if (input.certificate.mode === "caddy-auto") {
            accessActivation = await setupAccessManager.activate(input);
          }
          store.updateSetupProgress({
            stage: "account",
            current: 3,
            total: 3,
            message: "正在创建管理员并完成初始化"
          });
          const admin = store.completeSetup(input);
          accessActivation = null;
          authAttempts.delete(attemptKey);
          const session = store.createAdminSession(admin.id);
          const finalOrigin = currentPublicOrigin();
          const sameOrigin = requestOriginFor(request) === finalOrigin.origin;
          sendJson(response, 201, {
            state: "READY",
            currentAdmin: admin,
            redirectTo: sameOrigin ? "/" : new URL("/", finalOrigin).toString()
          }, sameOrigin ? {
            "set-cookie": sessionCookie(
              SESSION_COOKIE,
              session.secret,
              session.expiresAt,
              finalOrigin.protocol === "https:"
            )
          } : {});
        } catch (error) {
          if (accessActivation?.rollback) {
            try {
              await accessActivation.rollback();
            } catch (rollbackError) {
              console.error(`[RayLink] Caddy rollback failed: ${rollbackError.message}`);
            }
          }
          store.failSetupInitialization();
          throw error;
        }
        return;
      }

      if (setup.state !== "READY") {
        if (request.method === "GET" && ["/", "/index.html"].includes(url.pathname)) {
          response.writeHead(302, { location: "/setup", "cache-control": "no-store" });
          response.end();
          return;
        }
        if (request.method === "GET" && url.pathname === "/setup/") {
          response.writeHead(302, { location: "/setup", "cache-control": "no-store" });
          response.end();
          return;
        }
        if (
          request.method === "GET"
          && [
            "/setup",
            "/setup/",
            "/setup.js",
            "/setup.css",
            "/styles.css",
            "/assets/brand/raylink-mark.svg"
          ].includes(url.pathname)
          && await sendStatic(response, webDir, url.pathname)
        ) return;
        sendJson(response, 423, {
          error: { code: "SETUP_REQUIRED", message: "请先完成 RayLink 首次初始化" }
        });
        return;
      }

      if (request.method === "GET" && ["/setup", "/setup/"].includes(url.pathname)) {
        response.writeHead(302, { location: "/", "cache-control": "no-store" });
        response.end();
        return;
      }

      const ruleSetMatch = url.pathname.match(
        /^\/rule-sets\/(geosite-geolocation-cn\.srs|geoip-cn\.srs)$/
      );
      if (request.method === "GET" && ruleSetMatch) {
        const payload = await ruleSetCache.get(ruleSetMatch[1]);
        if (!payload) {
          sendJson(response, 404, {
            error: { code: "RULE_SET_NOT_READY", message: "完整规则集尚未准备完成" }
          });
          return;
        }
        const etag = `"${createHash("sha256").update(payload).digest("hex")}"`;
        const headers = {
          "cache-control": "public, max-age=3600, must-revalidate",
          "content-type": "application/octet-stream",
          "content-length": payload.length,
          etag,
          "x-content-type-options": "nosniff"
        };
        if (request.headers["if-none-match"] === etag) {
          response.writeHead(304, headers);
          response.end();
          return;
        }
        response.writeHead(200, headers);
        response.end(payload);
        return;
      }

      const subscriptionMatch = url.pathname.match(
        /^\/sub\/([A-Za-z0-9_-]{16,64})\/([A-Za-z0-9_-]{32,128})\/sing-box\.json$/
      );
      if (request.method === "GET" && subscriptionMatch) {
        const subscriptionUser = store.userForSubscription(subscriptionMatch[1], subscriptionMatch[2]);
        if (!subscriptionUser) {
          sendJson(response, 401, {
            error: { code: "SUBSCRIPTION_INVALID", message: "订阅地址无效或已经被重置" }
          });
          return;
        }
        sendSubscriptionJson(
          request,
          response,
          await buildClientConfigForUser(subscriptionUser.id)
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJson(request);
        const attemptKey = authKey(request, "admin");
        if (!authAllowed(attemptKey)) {
          sendJson(response, 429, { error: { code: "RATE_LIMITED", message: "登录尝试过多，请稍后再试" } });
          return;
        }
        const admin = await store.authenticateAdmin(body.username, body.password);
        if (!admin) {
          recordAuthFailure(attemptKey);
          sendJson(response, 401, { error: { code: "INVALID_CREDENTIALS", message: "用户名或密码不正确" } });
          return;
        }
        authAttempts.delete(attemptKey);
        const session = store.createAdminSession(admin.id);
        sendJson(
          response,
          200,
          { currentAdmin: admin },
          { "set-cookie": sessionCookie(SESSION_COOKIE, session.secret, session.expiresAt, currentPublicOrigin().protocol === "https:") }
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/portal/login") {
        const body = await readJson(request);
        const attemptKey = authKey(request, "portal");
        if (!authAllowed(attemptKey)) {
          sendJson(response, 429, { error: { code: "RATE_LIMITED", message: "登录尝试过多，请稍后再试" } });
          return;
        }
        const user = await store.authenticateUser(body.email, body.password);
        if (!user) {
          recordAuthFailure(attemptKey);
          sendJson(response, 401, { error: { code: "INVALID_CREDENTIALS", message: "邮箱或密码不正确" } });
          return;
        }
        authAttempts.delete(attemptKey);
        if (user.portalStatus !== "active") {
          sendJson(response, 403, { error: { code: "ACCOUNT_NOT_ACTIVE", message: "账号尚未完成首次登录激活" } });
          return;
        }
        const profile = store.portalProfile(user.id);
        if (profile.user.state === "disabled") {
          sendJson(response, 403, { error: { code: "ACCOUNT_DISABLED", message: "账号已经停用" } });
          return;
        }
        const session = store.createUserSession(user.id);
        sendJson(
          response,
          200,
          profile,
          { "set-cookie": sessionCookie(PORTAL_SESSION_COOKIE, session.secret, session.expiresAt, currentPublicOrigin().protocol === "https:") }
        );
        return;
      }

      if (url.pathname.startsWith("/api/portal/")) {
        const sessionSecret = parseCookies(request.headers.cookie)[PORTAL_SESSION_COOKIE];
        const sessionUser = store.userForSession(sessionSecret);
        if (!sessionUser) {
          sendJson(response, 401, { error: { code: "UNAUTHENTICATED", message: "请先登录用户中心" } });
          return;
        }
        const profile = store.portalProfile(sessionUser.id);
        if (profile.user.portalStatus !== "active") {
          sendJson(response, 403, { error: { code: "ACCOUNT_NOT_ACTIVE", message: "用户中心权限已被撤销" } });
          return;
        }
        if (profile.user.state === "disabled") {
          sendJson(response, 403, { error: { code: "ACCOUNT_DISABLED", message: "账号已经停用" } });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/portal/me") {
          sendJson(response, 200, profile);
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/portal/subscription/rotate") {
          const subscription = store.rotateUserSubscription(sessionUser.id);
          sendJson(response, 201, {
            subscriptionUrl: new URL(
              `/sub/${subscription.publicId}/${subscription.secret}/sing-box.json`,
              currentSubscriptionOrigin()
            ).toString()
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/portal/config/sing-box") {
          sendJson(
            response,
            200,
            await buildClientConfigForUser(sessionUser.id),
            { "content-disposition": `attachment; filename="raylink-sing-box.json"` }
          );
          return;
        }
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/node/enroll") {
        const body = await readJson(request);
        if (body.encryptionPublicKey) {
          body.encryptionPublicKey = validateNodeEncryptionPublicKey(body.encryptionPublicKey);
        }
        sendJson(response, 201, {
          ...store.enrollNode(body.token, body),
          nextPollSeconds: 10
        });
        return;
      }

      if (url.pathname.startsWith("/api/node/")) {
        const hostId = String(request.headers["x-raylink-host-id"] || "");
        const nodeSecret = bearerToken(request.headers.authorization);
        const node = store.authenticateNode(hostId, nodeSecret);
        if (!node) {
          sendJson(response, 401, {
            error: { code: "NODE_UNAUTHENTICATED", message: "节点身份验证失败" }
          });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/node/heartbeat") {
          const heartbeat = await readJson(request);
          if (heartbeat.encryptionPublicKey) {
            heartbeat.encryptionPublicKey = validateNodeEncryptionPublicKey(
              heartbeat.encryptionPublicKey
            );
          }
          const timestamp = Date.now();
          const lastWriteAt = nodeHeartbeatWrites.get(node.id) || 0;
          if (timestamp - lastWriteAt < nodeHeartbeatMinIntervalMs) {
            sendJson(response, 429, {
              error: { code: "HEARTBEAT_RATE_LIMITED", message: "节点心跳过于频繁" },
              nextPollSeconds: Math.ceil(nodeHeartbeatMinIntervalMs / 1_000)
            }, { "retry-after": String(Math.ceil(nodeHeartbeatMinIntervalMs / 1_000)) });
            return;
          }
          store.heartbeatNode(node.id, heartbeat);
          nodeHeartbeatWrites.set(node.id, timestamp);
          sendJson(response, 200, { nextPollSeconds: 10 });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/node/usage") {
          if (!store.getHost(node.id)?.usageMetering.supported) {
            throw httpError(
              "USAGE_METERING_UNAVAILABLE",
              "该 Runtime 未上报 with_v2ray_api，拒绝接收用户计量数据",
              409
            );
          }
          const usageResult = store.recordUsageSnapshot(
            node.id,
            await readJson(request, 1024 * 1024)
          );
          const runtimeSync = usageResult.quotaExceededUserIds.length
            ? await reconcileUserEntitlements(null, {
              forceCritical: true,
              reason: "usage-quota-enforcement"
            })
            : { status: "current" };
          sendJson(response, 200, { ...usageResult, runtimeSync });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/node/usage/status") {
          const status = await readJson(request);
          if (status.status !== "error") {
            throw httpError("INVALID_USAGE_STATUS", "计量状态只接受 error", 422);
          }
          sendJson(response, 200, {
            usageMetering: store.recordUsageMeteringError(node.id, status.error)
          });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/node/tasks/next") {
          if (node.agentVersion !== REQUIRED_NODE_AGENT_VERSION) {
            sendJson(response, 426, {
              error: {
                code: "NODE_UPGRADE_REQUIRED",
                message: `RayLink Node 必须升级到 ${REQUIRED_NODE_AGENT_VERSION} 后才能接收配置任务`
              },
              requiredVersion: REQUIRED_NODE_AGENT_VERSION
            });
            return;
          }
          const task = store.nextNodeTask(node.id);
          if (!task) {
            response.writeHead(204, { "cache-control": "no-store" });
            response.end();
            return;
          }
          sendJson(response, 200, task);
          return;
        }
        const taskCompletionMatch = url.pathname.match(/^\/api\/node\/tasks\/([^/]+)\/complete$/);
        if (request.method === "POST" && taskCompletionMatch) {
          sendJson(response, 200, store.completeNodeTask(
            node.id,
            decodeURIComponent(taskCompletionMatch[1]),
            await readJson(request)
          ));
          return;
        }
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "节点接口不存在" } });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        if (!requestOriginIsAllowed(request)) {
          sendJson(response, 403, {
            error: { code: "ORIGIN_REJECTED", message: "请求来源不受信任" }
          });
          return;
        }
        const sessionSecret = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        store.revokeAdminSession(sessionSecret);
        sendJson(
          response,
          200,
          { loggedOut: true },
          {
            "set-cookie": clearedSessionCookie(
              SESSION_COOKIE,
              currentPublicOrigin().protocol === "https:"
            )
          }
        );
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        const sessionSecret = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        const admin = store.adminForSession(sessionSecret);
        if (!admin) {
          sendJson(response, 401, { error: { code: "UNAUTHENTICATED", message: "请先登录" } });
          return;
        }

        if (
          ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
          && !requestOriginIsAllowed(request)
        ) {
          sendJson(response, 403, {
            error: { code: "ORIGIN_REJECTED", message: "请求来源不受信任" }
          });
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/bootstrap") {
          const installation = await refreshLocalRuntimeCapabilities();
          const runtime = await runtimeManager.status();
          const bootstrap = store.bootstrap(admin);
          const hosts = bootstrap.hosts.map((host) => {
            const capabilities = host.id === "local"
              ? installation
              : {
                  installed: Boolean(host.runtimeVersion),
                  version: host.runtimeVersion,
                  platform: host.platform || "linux",
                  architecture: host.architecture,
                  tags: host.buildTags
                };
            return {
              ...host,
              protocolCatalog: protocolCatalog.map(
                (protocol) => protocolAvailability(protocol, capabilities)
              )
            };
          });
          sendJson(response, 200, {
            ...bootstrap,
            hosts,
            telemetry: store.telemetryOverview(),
            runtime,
            runtimePreview: runtimeManager.preview(),
            deployments: store.listDeployments(),
            installation,
            runtimeUpdate: typeof installer.releaseStatus === "function"
              ? installer.releaseStatus()
              : null,
            protocolCatalog: protocolCatalog.map((protocol) => protocolAvailability(protocol, installation))
          });
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/runtime/status") {
          sendJson(response, 200, await runtimeManager.status());
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/runtime/installation") {
          sendJson(response, 200, await installer.status());
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/runtime/install") {
          sendJson(
            response,
            200,
            await runLocalRuntimeOperation("安装", () => installer.install())
          );
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/runtime/update") {
          if (typeof installer.checkForUpdates !== "function") {
            throw httpError("UPDATE_CHECK_UNAVAILABLE", "当前 Runtime 不支持在线版本检查", 501);
          }
          sendJson(response, 200, await installer.checkForUpdates());
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/runtime/upgrade") {
          if (
            typeof installer.checkForUpdates !== "function"
            || typeof installer.upgrade !== "function"
          ) {
            throw httpError("RUNTIME_UPGRADE_UNAVAILABLE", "当前 Runtime 不支持在线升级", 501);
          }
          const update = await installer.checkForUpdates();
          if (!update.updateAvailable) {
            throw httpError(
              update.blockedReason ? "RUNTIME_UPGRADE_INCOMPATIBLE" : "RUNTIME_ALREADY_CURRENT",
              update.blockedReason || "当前 sing-box 已是可用的最新稳定版本",
              409
            );
          }
          const upgraded = await runLocalRuntimeOperation(
            "在线升级",
            () => installer.upgrade(update.latestVersion)
          );
          sendJson(response, 200, upgraded);
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/runtime/reality-keypair") {
          sendJson(response, 201, await installer.generateRealityKeypair());
          return;
        }

        const protocolMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/protocols\/([^/]+)$/);
        if (request.method === "PATCH" && protocolMatch) {
          const hostId = decodeURIComponent(protocolMatch[1]);
          const protocolType = decodeURIComponent(protocolMatch[2]);
          const input = await readJson(request);
          const host = store.getHost(hostId);
          if (!host) {
            sendJson(response, 404, { error: { code: "HOST_NOT_FOUND", message: "主机不存在" } });
            return;
          }
          const candidate = store.prepareHostProtocolConfig(hostId, protocolType, input);
          if (candidate.enabled) {
            if (host.kind === "remote" && !host.runtimeVersion) {
              throw httpError(
                "HOST_CAPABILITIES_UNKNOWN",
                "远程主机尚未上报 sing-box 能力，请先完成 RayLink Node 接入",
                409
              );
            }
            const installation = host.id === "local"
              ? await installer.status()
              : host.runtimeVersion
                ? {
                    installed: true,
                    version: host.runtimeVersion,
                    platform: host.platform,
                    architecture: host.architecture,
                    tags: host.buildTags
                  }
                : null;
            const catalog = protocolCatalog.find((entry) => entry.type === protocolType);
            const availability = installation
              ? protocolAvailability(catalog, installation)
              : null;
            if (availability && !availability.available) {
              sendJson(response, 422, {
                error: {
                  code: "PROTOCOL_UNAVAILABLE",
                  message: !availability.versionSupported
                    ? `RayLink 当前协议 schema 支持 sing-box 1.13.x，检测到 ${installation.version || "未知版本"}`
                    : availability.platformSupported
                      ? `当前 sing-box 构建缺少 ${availability.missingTags.join(", ") || "所需能力"}`
                      : `当前平台不支持 ${catalog.name}`
                }
              });
              return;
            }
            if (availability && candidate.tls.mode === "reality" && !availability.realityAvailable) {
              sendJson(response, 422, {
                error: { code: "REALITY_UNAVAILABLE", message: "当前 sing-box 构建缺少 with_utls" }
              });
              return;
            }
            if (availability && candidate.transport.type === "quic" && !availability.quicTransportAvailable) {
              sendJson(response, 422, {
                error: { code: "QUIC_UNAVAILABLE", message: "当前 sing-box 构建缺少 with_quic" }
              });
              return;
            }
          }
          sendJson(response, 200, store.updateHostProtocolConfig(hostId, protocolType, input));
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/deployments") {
          sendJson(response, 200, { deployments: store.listDeployments() });
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/deployments/preview") {
          sendJson(response, 200, runtimeManager.preview());
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/deployments") {
          await refreshLocalRuntimeCapabilities();
          sendJson(
            response,
            201,
            await runLocalRuntimeOperation("配置发布", () => runtimeManager.publish(admin.id))
          );
          return;
        }

        const rollbackMatch = url.pathname.match(/^\/api\/deployments\/([^/]+)\/rollback$/);
        if (request.method === "POST" && rollbackMatch) {
          sendJson(
            response,
            201,
            await runLocalRuntimeOperation(
              "配置回滚",
              () => runtimeManager.rollback(decodeURIComponent(rollbackMatch[1]), admin.id)
            )
          );
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/users") {
          const user = store.createUser(await readJson(request));
          const runtimeSync = await reconcileUserEntitlements(admin.id);
          sendJson(response, runtimeSync.status === "pending" ? 202 : 201, {
            ...user,
            runtimeSync
          });
          return;
        }

        const userSubscriptionMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/subscription\/rotate$/);
        if (request.method === "POST" && userSubscriptionMatch) {
          const subscription = store.rotateUserSubscription(decodeURIComponent(userSubscriptionMatch[1]));
          sendJson(response, 201, {
            subscriptionUrl: new URL(
              `/sub/${subscription.publicId}/${subscription.secret}/sing-box.json`,
              currentSubscriptionOrigin()
            ).toString()
          });
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/hosts") {
          sendJson(response, 201, store.createRemoteHost(await readJson(request)));
          return;
        }

        const enrollmentTokenMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/enrollment-token$/);
        if (request.method === "POST" && enrollmentTokenMatch) {
          sendJson(
            response,
            201,
            store.rotateNodeEnrollmentToken(decodeURIComponent(enrollmentTokenMatch[1]))
          );
          return;
        }

        const runtimeUpgradeMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/runtime-upgrade$/);
        if (request.method === "POST" && runtimeUpgradeMatch) {
          const hostId = decodeURIComponent(runtimeUpgradeMatch[1]);
          const host = store.getHost(hostId);
          if (!host || host.kind !== "remote") {
            throw httpError("REMOTE_HOST_NOT_FOUND", "远程主机不存在", 404);
          }
          if (!host.enrolledAt) {
            throw httpError("NODE_NOT_ENROLLED", "远程主机尚未完成 RayLink Node 接入", 409);
          }
          if (host.agentVersion !== REQUIRED_NODE_AGENT_VERSION) {
            throw httpError(
              "NODE_UPGRADE_REQUIRED",
              `请先将 RayLink Node 升级到 ${REQUIRED_NODE_AGENT_VERSION}`,
              409
            );
          }
          if (typeof installer.checkForUpdates !== "function") {
            throw httpError("UPDATE_CHECK_UNAVAILABLE", "当前 Runtime 不支持在线版本检查", 501);
          }
          const update = await installer.checkForUpdates();
          if (!update.compatible || !update.latestVersion) {
            throw httpError(
              "RUNTIME_UPGRADE_INCOMPATIBLE",
              update.blockedReason || "最新稳定版与当前 RayLink 不兼容",
              409
            );
          }
          const targetVersion = update.approvedVersion || APPROVED_METERED_RUNTIME_VERSION;
          const needsMeteredRebuild = host.runtimeVersion === targetVersion
            && !host.usageMetering.supported;
          if (!versionIsOlder(host.runtimeVersion, targetVersion) && !needsMeteredRebuild) {
            throw httpError("RUNTIME_ALREADY_CURRENT", "该主机已是最新版本", 409);
          }
          const taskId = store.queueNodeTask(host.id, "upgrade-runtime", {
            targetVersion,
            requestedAt: new Date().toISOString()
          }, { maxAttempts: 1 });
          sendJson(response, 202, {
            taskId,
            status: "queued",
            targetVersion
          });
          return;
        }

        const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
        if (request.method === "PATCH" && userMatch) {
          const user = store.updateUser(
            decodeURIComponent(userMatch[1]),
            await readJson(request)
          );
          const runtimeSync = await reconcileUserEntitlements(admin.id);
          sendJson(response, runtimeSync.status === "pending" ? 202 : 200, {
            ...user,
            runtimeSync
          });
          return;
        }

        const hostMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)$/);
        if (request.method === "PATCH" && hostMatch) {
          sendJson(response, 200, store.updateHost(
            decodeURIComponent(hostMatch[1]),
            await readJson(request)
          ));
          return;
        }

        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
        return;
      }

      if (request.method === "GET" && await sendStatic(response, webDir, url.pathname)) return;
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "资源不存在" } });
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        error: {
          code: error.code || (error.statusCode ? "BAD_REQUEST" : "INTERNAL_ERROR"),
          message: error.statusCode ? error.message : "服务器处理请求失败"
        }
      });
    }
  });

  return {
    server,
    store,
    runtimeManager,
    async listen({ host, port }) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await sampleLocalTelemetry();
      await refreshLocalRuntimeCapabilities();
      await sampleLocalUsage();
      runOperationalMaintenance();
      operationalMaintenanceTimer = setInterval(
        runOperationalMaintenance,
        operationalMaintenanceIntervalMs
      );
      operationalMaintenanceTimer.unref?.();
      telemetryTimer = setInterval(sampleLocalTelemetry, telemetryIntervalMs);
      telemetryTimer.unref?.();
      usageMeteringTimer = setInterval(sampleLocalUsage, usageMeteringIntervalMs);
      usageMeteringTimer.unref?.();
      entitlementReconcileTimer = setInterval(() => {
        runLocalRuntimeOperation("配置同步", () => runtimeManager.reconcile()).catch((error) => {
          console.warn(`[RayLink] Entitlement reconciliation failed: ${error.message}`);
        });
      }, entitlementReconcileIntervalMs);
      entitlementReconcileTimer.unref?.();
      ruleSetRefreshTimer = setInterval(refreshRuleSets, 60 * 60 * 1000);
      ruleSetRefreshTimer.unref?.();
      if (runtimeUpdateCheckIntervalMs > 0) {
        refreshRuntimeUpdate();
        runtimeUpdateTimer = setInterval(refreshRuntimeUpdate, runtimeUpdateCheckIntervalMs);
        runtimeUpdateTimer.unref?.();
      }
    },
    async close() {
      if (operationalMaintenanceTimer) {
        clearInterval(operationalMaintenanceTimer);
        operationalMaintenanceTimer = null;
      }
      if (usageMeteringTimer) {
        clearInterval(usageMeteringTimer);
        usageMeteringTimer = null;
      }
      if (runtimeUpdateTimer) {
        clearInterval(runtimeUpdateTimer);
        runtimeUpdateTimer = null;
      }
      if (ruleSetRefreshTimer) {
        clearInterval(ruleSetRefreshTimer);
        ruleSetRefreshTimer = null;
      }
      if (entitlementReconcileTimer) {
        clearInterval(entitlementReconcileTimer);
        entitlementReconcileTimer = null;
      }
      if (telemetryTimer) {
        clearInterval(telemetryTimer);
        telemetryTimer = null;
      }
      if (telemetrySamplePromise) await telemetrySamplePromise;
      if (usageMeteringPromise) await usageMeteringPromise;
      if (server.listening) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      store.close();
    }
  };
}
