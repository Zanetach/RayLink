import { resolve } from "node:path";

function positiveInteger(value, fallback, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const host = env.RAYLINK_HOST || "127.0.0.1";
  const port = positiveInteger(env.RAYLINK_PORT, 4173, "RAYLINK_PORT");
  const publicOrigin = env.RAYLINK_PUBLIC_ORIGIN || `http://${host}:${port}`;
  const setupRequired = env.RAYLINK_SETUP_REQUIRED === "true";
  if (env.NODE_ENV === "production" && new URL(publicOrigin).protocol !== "https:") {
    throw new Error("RAYLINK_PUBLIC_ORIGIN must use HTTPS in production");
  }
  if (Boolean(env.RAYLINK_SETUP_TOKEN_HASH) !== Boolean(env.RAYLINK_SETUP_TOKEN_EXPIRES_AT)) {
    throw new Error("RAYLINK_SETUP_TOKEN_HASH and RAYLINK_SETUP_TOKEN_EXPIRES_AT must be set together");
  }
  const runtimeMode = env.RAYLINK_RUNTIME_MODE || "dry-run";
  if (!["dry-run", "systemd"].includes(runtimeMode)) {
    throw new Error("RAYLINK_RUNTIME_MODE must be dry-run or systemd");
  }
  const adminPassword = env.RAYLINK_ADMIN_PASSWORD || "Admin@2026";
  if (env.NODE_ENV === "production" && adminPassword === "Admin@2026") {
    throw new Error("RAYLINK_ADMIN_PASSWORD must be changed in production");
  }

  return {
    host,
    port,
    dataDir: resolve(env.RAYLINK_DATA_DIR || "./data"),
    adminUsername: env.RAYLINK_ADMIN_USERNAME || "admin",
    adminPassword,
    seedDemoData: env.NODE_ENV !== "production",
    trustProxy: env.RAYLINK_TRUST_PROXY === "true",
    publicOrigin,
    proxyHost: env.RAYLINK_PROXY_HOST || new URL(publicOrigin).hostname,
    runtimeMode,
    preferMeteredRuntime: env.RAYLINK_USER_METERING !== "false",
    singBoxBinary: env.SING_BOX_BIN || "sing-box",
    systemdUnit: env.SING_BOX_SYSTEMD_UNIT || "sing-box.service",
    listenPort: positiveInteger(env.RAYLINK_PROXY_PORT, 8388, "RAYLINK_PROXY_PORT"),
    setupRequired,
    setupTokenHash: env.RAYLINK_SETUP_TOKEN_HASH || "",
    setupTokenExpiresAt: env.RAYLINK_SETUP_TOKEN_EXPIRES_AT || ""
  };
}
