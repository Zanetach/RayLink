import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { RayLinkStore } from "./database.js";
import { buildUserClientConfig } from "./singbox/client-config.js";
import { SingBoxInstaller } from "./singbox/installer.js";
import { LocalSingBoxAdapter } from "./singbox/local-adapter.js";
import {
  normalizeProtocolConfig,
  protocolAvailability,
  protocolCatalog
} from "./singbox/protocol-catalog.js";
import { RuntimeManager } from "./singbox/runtime-manager.js";

const SESSION_COOKIE = "raylink_session";
const PORTAL_SESSION_COOKIE = "raylink_portal_session";
const defaultWebDir = fileURLToPath(new URL("../web", import.meta.url));

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").flatMap((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 0) return [];
    return [[entry.slice(0, separator).trim(), decodeURIComponent(entry.slice(separator + 1).trim())]];
  }));
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

async function sendStatic(response, webDir, pathname) {
  const relativePath = pathname === "/"
    ? "index.html"
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
      "cache-control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=300",
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

export async function createRayLinkApp(options) {
  const dbPath = options.dbPath || join(options.dataDir, "raylink.db");
  const publicOrigin = new URL(options.publicOrigin);
  const proxyHost = options.proxyHost || publicOrigin.hostname;
  const listenPort = options.listenPort || 8388;
  const store = new RayLinkStore({
    dbPath,
    adminUsername: options.adminUsername,
    adminPassword: options.adminPassword,
    initialHostAddress: proxyHost,
    initialListenPort: listenPort,
    seedDemoData: options.seedDemoData
  });
  const webDir = resolve(options.webDir || defaultWebDir);
  const runtimeAdapter = options.runtimeAdapter || new LocalSingBoxAdapter({
    dataDir: options.dataDir,
    binaryPath: options.singBoxBinary || "sing-box",
    mode: options.runtimeMode || "dry-run",
    systemdUnit: options.systemdUnit || "sing-box.service"
  });
  const runtimeManager = new RuntimeManager({
    store,
    adapter: runtimeAdapter,
    listenPort
  });
  const installer = options.installer || new SingBoxInstaller({
    binaryPath: options.singBoxBinary || "sing-box"
  });
  const authAttempts = new Map();
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
      const url = new URL(request.url, publicOrigin);

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
          { "set-cookie": sessionCookie(SESSION_COOKIE, session.secret, session.expiresAt, publicOrigin.protocol === "https:") }
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
          { "set-cookie": sessionCookie(PORTAL_SESSION_COOKIE, session.secret, session.expiresAt, publicOrigin.protocol === "https:") }
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
        if (request.method === "GET" && url.pathname === "/api/portal/config/sing-box") {
          const credential = store.clientCredential(sessionUser.id);
          const runtimeHost = store.getHost("local");
          const expiresAt = new Date(`${credential.expiresAt}T23:59:59.999Z`);
          const regionAllowed = credential.nodeScope.includes("all")
            || credential.nodeScope.includes(credential.hostRegion);
          if (
            !["active", "warning"].includes(credential.state)
            || credential.portalStatus !== "active"
            || credential.usedGb >= credential.quotaGb
            || expiresAt < new Date()
            || !regionAllowed
          ) {
            sendJson(response, 403, { error: { code: "ENTITLEMENT_INACTIVE", message: "账号当前不可使用" } });
            return;
          }
          if (!credential.clientFormats.includes("sing-box")) {
            sendJson(response, 403, { error: { code: "FORMAT_NOT_ALLOWED", message: "当前方案未启用 sing-box 配置" } });
            return;
          }
          sendJson(
            response,
            200,
            buildUserClientConfig({
              credential,
              server: runtimeHost?.address || proxyHost,
              port: listenPort,
              protocols: store.listProtocolConfigs()
            }),
            { "content-disposition": `attachment; filename="raylink-sing-box.json"` }
          );
          return;
        }
        sendJson(response, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        const sessionSecret = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        const admin = store.adminForSession(sessionSecret);
        if (!admin) {
          sendJson(response, 401, { error: { code: "UNAUTHENTICATED", message: "请先登录" } });
          return;
        }

        if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
          const requestOrigin = request.headers.origin;
          if (requestOrigin && requestOrigin !== publicOrigin.origin) {
            sendJson(response, 403, { error: { code: "ORIGIN_REJECTED", message: "请求来源不受信任" } });
            return;
          }
        }

        if (request.method === "GET" && url.pathname === "/api/bootstrap") {
          const installation = await installer.status();
          sendJson(response, 200, {
            ...store.bootstrap(admin),
            runtime: await runtimeManager.status(),
            runtimePreview: runtimeManager.preview(),
            deployments: store.listDeployments(),
            installation,
            protocols: store.listProtocolConfigs(),
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
          sendJson(response, 200, await installer.install());
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/runtime/reality-keypair") {
          sendJson(response, 201, await installer.generateRealityKeypair());
          return;
        }

        const protocolMatch = url.pathname.match(/^\/api\/runtime\/protocols\/([^/]+)$/);
        if (request.method === "PATCH" && protocolMatch) {
          const protocolType = decodeURIComponent(protocolMatch[1]);
          const input = await readJson(request);
          const current = store.listProtocolConfigs().find((profile) => profile.type === protocolType);
          if (!current) {
            sendJson(response, 404, { error: { code: "PROTOCOL_NOT_FOUND", message: "协议不存在" } });
            return;
          }
          const candidate = normalizeProtocolConfig({
            ...current,
            ...input,
            type: protocolType,
            tls: { ...current.tls, ...(input.tls || {}) },
            transport: { ...current.transport, ...(input.transport || {}) },
            options: input.options === undefined ? current.options : input.options
          });
          if (candidate.enabled) {
            const installation = await installer.status();
            const catalog = protocolCatalog.find((entry) => entry.type === protocolType);
            const availability = protocolAvailability(catalog, installation);
            if (!availability.available) {
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
            if (candidate.tls.mode === "reality" && !availability.realityAvailable) {
              sendJson(response, 422, {
                error: { code: "REALITY_UNAVAILABLE", message: "当前 sing-box 构建缺少 with_utls" }
              });
              return;
            }
            if (candidate.transport.type === "quic" && !availability.quicTransportAvailable) {
              sendJson(response, 422, {
                error: { code: "QUIC_UNAVAILABLE", message: "当前 sing-box 构建缺少 with_quic" }
              });
              return;
            }
          }
          sendJson(response, 200, store.updateProtocolConfig(protocolType, input));
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
          sendJson(response, 201, await runtimeManager.publish(admin.id));
          return;
        }

        const rollbackMatch = url.pathname.match(/^\/api\/deployments\/([^/]+)\/rollback$/);
        if (request.method === "POST" && rollbackMatch) {
          sendJson(
            response,
            201,
            await runtimeManager.rollback(decodeURIComponent(rollbackMatch[1]), admin.id)
          );
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/plans") {
          sendJson(response, 201, store.createPlan(await readJson(request)));
          return;
        }

        const planMatch = url.pathname.match(/^\/api\/plans\/([^/]+)$/);
        if (request.method === "PATCH" && planMatch) {
          sendJson(
            response,
            200,
            store.updatePlan(decodeURIComponent(planMatch[1]), await readJson(request))
          );
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/users") {
          sendJson(response, 201, store.createUser(await readJson(request)));
          return;
        }

        const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
        if (request.method === "PATCH" && userMatch) {
          sendJson(response, 200, store.updateUser(decodeURIComponent(userMatch[1]), await readJson(request)));
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
    },
    async close() {
      if (server.listening) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      store.close();
    }
  };
}
