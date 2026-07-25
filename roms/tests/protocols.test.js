import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProtocolClientConfig,
  buildProtocolInbounds,
  defaultProtocolConfigs,
  protocolCatalog
} from "../server/singbox/protocol-catalog.js";

const eligibleUsers = [
  {
    email: "user@example.com",
    runtimeUuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d",
    runtimePassword: "dXNlci1wYXNzd29yZA=="
  }
];

test("source catalog exposes the inbound protocols registered by sing-box 1.13", () => {
  assert.deepEqual(
    protocolCatalog.map((protocol) => protocol.type),
    [
      "shadowsocks",
      "vmess",
      "trojan",
      "naive",
      "shadowtls",
      "vless",
      "anytls",
      "hysteria",
      "tuic",
      "hysteria2",
      "socks",
      "http",
      "mixed",
      "direct",
      "tun",
      "redirect",
      "tproxy"
    ]
  );
});

test("managed protocol profiles compile separate user credentials into server inbounds", () => {
  const profiles = defaultProtocolConfigs(8388).map((profile) => {
    if (profile.type === "shadowsocks") return profile;
    if (profile.type === "vless") {
      return {
        ...profile,
        enabled: true,
        port: 8443,
        tls: { mode: "none" }
      };
    }
    return profile;
  });

  const inbounds = buildProtocolInbounds({
    profiles,
    users: eligibleUsers,
    masterPassword: "c2VydmVyLWtleS0xNg=="
  });

  assert.equal(inbounds.length, 2);
  assert.deepEqual(inbounds[0].users, [{
    name: "user@example.com",
    password: "dXNlci1wYXNzd29yZA=="
  }]);
  assert.deepEqual(inbounds[1].users, [{
    name: "user@example.com",
    uuid: "3365c019-4b70-4dd5-9b3a-48d83a22f24d"
  }]);
});

test("client configuration includes every enabled user-facing protocol", () => {
  const profiles = defaultProtocolConfigs(8388).map((profile) => {
    if (profile.type === "vless") {
      return {
        ...profile,
        enabled: true,
        port: 8443,
        tls: { mode: "none" }
      };
    }
    return profile;
  });
  const config = buildProtocolClientConfig({
    profiles,
    credential: {
      email: eligibleUsers[0].email,
      runtimeUuid: eligibleUsers[0].runtimeUuid,
      runtimePassword: eligibleUsers[0].runtimePassword,
      serverPassword: "c2VydmVyLWtleS0xNg=="
    },
    server: "node.example.com"
  });

  assert.deepEqual(config.outbounds.slice(0, 2).map((outbound) => outbound.type), ["shadowsocks", "vless"]);
  assert.equal(config.route.final, "raylink-auto");
  assert.deepEqual(
    config.outbounds.find((outbound) => outbound.type === "selector").outbounds,
    ["raylink-shadowsocks", "raylink-vless"]
  );
});
