#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { createRayLinkApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";

const execFile = promisify(execFileCallback);
const compatibleTlsTypes = new Set(["vmess", "vless", "trojan", "anytls"]);
const config = loadConfig();
if (process.env.NODE_ENV !== "production" || config.runtimeMode !== "systemd") {
  throw new Error("TLS migration requires the production systemd environment");
}
const app = await createRayLinkApp({
  ...config,
  protocolLatencyIntervalMs: 0,
  runtimeUpdateCheckIntervalMs: 0
});

try {
  const profiles = app.store.listHostProtocolConfigs("local");
  const affected = profiles.filter((profile) => (
    profile.enabled
    && compatibleTlsTypes.has(profile.type)
    && profile.tls?.mode === "reality"
  ));
  for (const profile of affected) {
    await execFile("systemctl", ["stop", config.systemdUnit]);
    try {
      await app.protocolActivationManager.enable({
        hostId: "local",
        type: profile.type,
        adminId: null
      });
    } catch (error) {
      await execFile("systemctl", ["start", config.systemdUnit]).catch(() => {});
      throw error;
    }
    process.stdout.write(`已将 ${profile.type} 迁移到 Host 域名证书 TLS\n`);
  }
  if (!affected.length) {
    process.stdout.write("没有需要迁移的 Reality 一键协议\n");
  }
} finally {
  await app.close();
}
