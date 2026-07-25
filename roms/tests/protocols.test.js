import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProtocolClientConfig,
  buildProtocolInbounds,
  defaultProtocolConfigs,
  normalizeProtocolConfig,
  protocolAvailability,
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

test("Hysteria client inherits the managed bandwidth values required by sing-box", () => {
  const profiles = defaultProtocolConfigs().map((profile) => ({
    ...profile,
    enabled: profile.type === "hysteria",
    tls: profile.type === "hysteria"
      ? { ...profile.tls, mode: "certificate", serverName: "node.example.com" }
      : profile.tls,
    options: profile.type === "hysteria"
      ? { up_mbps: 50, down_mbps: 100 }
      : profile.options
  }));
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
  const hysteria = config.outbounds.find((outbound) => outbound.type === "hysteria");

  assert.equal(hysteria.up_mbps, 50);
  assert.equal(hysteria.down_mbps, 100);
});

test("protocol availability is gated by schema version, platform and client build tags", () => {
  const naive = protocolCatalog.find((protocol) => protocol.type === "naive");
  const redirect = protocolCatalog.find((protocol) => protocol.type === "redirect");
  const base = {
    installed: true,
    version: "1.13.14",
    platform: "linux",
    tags: []
  };

  assert.equal(protocolAvailability(naive, base).available, false);
  assert.deepEqual(protocolAvailability(naive, base).missingTags, ["with_naive_outbound"]);
  assert.equal(protocolAvailability(naive, { ...base, version: "1.12.0" }).versionSupported, false);
  assert.equal(protocolAvailability(redirect, { ...base, platform: "win32" }).platformSupported, false);
});

test("transport schema emits service_name for gRPC and no path for QUIC", () => {
  const profiles = defaultProtocolConfigs().map((profile) => {
    if (profile.type === "vmess") {
      return {
        ...profile,
        enabled: true,
        transport: { type: "grpc", path: "/ignored", serviceName: "raylink" }
      };
    }
    if (profile.type === "vless") {
      return {
        ...profile,
        enabled: true,
        transport: { type: "quic", path: "/ignored", serviceName: "" }
      };
    }
    return { ...profile, enabled: false };
  });
  const [vmess, vless] = buildProtocolInbounds({
    profiles,
    users: eligibleUsers,
    masterPassword: "c2VydmVyLWtleS0xNg=="
  });

  assert.deepEqual(vmess.transport, { type: "grpc", service_name: "raylink" });
  assert.deepEqual(vless.transport, { type: "quic" });
});

test("advanced JSON cannot override fields managed by RayLink", () => {
  assert.throws(
    () => normalizeProtocolConfig({
      ...defaultProtocolConfigs()[0],
      options: { tls: { enabled: true } }
    }),
    (error) => error.code === "PROTOCOL_OPTION_RESERVED"
  );
});

test("QUIC transport cannot be enabled without TLS", () => {
  const vless = defaultProtocolConfigs().find((profile) => profile.type === "vless");
  assert.throws(
    () => normalizeProtocolConfig({
      ...vless,
      enabled: true,
      transport: { type: "quic", path: "", serviceName: "" }
    }),
    (error) => error.code === "TRANSPORT_TLS_REQUIRED"
  );
});
