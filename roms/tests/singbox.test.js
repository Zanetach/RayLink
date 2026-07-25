import assert from "node:assert/strict";
import test from "node:test";

import { buildSingBoxConfig } from "../server/singbox/config.js";

test("sing-box config contains one credential per eligible user", () => {
  const config = buildSingBoxConfig({
    host: { id: "local", region: "tokyo" },
    masterPassword: "MDEyMzQ1Njc4OWFiY2RlZg==",
    users: [
      {
        email: "active@example.cn",
        state: "active",
        expiresAt: "2027-01-31",
        runtimePassword: "YWJjZGVmZ2hpamtsbW5vcA==",
        nodeScope: ["tokyo"]
      },
      {
        email: "all-nodes@example.cn",
        state: "warning",
        expiresAt: "2027-02-28",
        runtimePassword: "cXdlcnR5dWlvcGFzZGZnaA==",
        nodeScope: ["all"]
      },
      {
        email: "disabled@example.cn",
        state: "disabled",
        expiresAt: "2027-02-28",
        runtimePassword: "emFzZGZnaGprbHF3ZXJ0eQ==",
        nodeScope: ["tokyo"]
      },
      {
        email: "expired@example.cn",
        state: "active",
        expiresAt: "2025-01-01",
        runtimePassword: "eHVpY2h1c2h1aWJhaWppYQ==",
        nodeScope: ["tokyo"]
      }
    ]
  }, {
    now: new Date("2026-07-26T00:00:00.000Z"),
    listenPort: 8388
  });

  assert.deepEqual(config.inbounds, [{
    type: "shadowsocks",
    tag: "managed-shadowsocks",
    listen: "::",
    listen_port: 8388,
    network: "tcp",
    method: "2022-blake3-aes-128-gcm",
    password: "MDEyMzQ1Njc4OWFiY2RlZg==",
    users: [
      { name: "active@example.cn", password: "YWJjZGVmZ2hpamtsbW5vcA==" },
      { name: "all-nodes@example.cn", password: "cXdlcnR5dWlvcGFzZGZnaA==" }
    ]
  }]);
  assert.equal(config.outbounds[0].type, "direct");
});
