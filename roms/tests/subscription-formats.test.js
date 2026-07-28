import assert from "node:assert/strict";
import test from "node:test";

import { buildSubscriptionArtifact } from "../server/subscriptions/formats.js";

const singBoxConfig = {
  outbounds: [
    {
      type: "vless",
      tag: "raylink-tokyo-vless",
      server: "node.example.com",
      server_port: 443,
      uuid: "11111111-1111-4111-8111-111111111111",
      tls: {
        enabled: true,
        server_name: "www.microsoft.com",
        reality: {
          enabled: true,
          public_key: "public-key",
          short_id: "a1b2c3d4"
        }
      }
    },
    {
      type: "hysteria2",
      tag: "raylink-tokyo-hysteria2",
      server: "node.example.com",
      server_port: 8448,
      password: "hysteria-password",
      tls: {
        enabled: true,
        server_name: "node.example.com"
      }
    },
    {
      type: "urltest",
      tag: "raylink-smart",
      outbounds: ["raylink-tokyo-vless"]
    },
    {
      type: "urltest",
      tag: "raylink-tcp",
      outbounds: ["raylink-tokyo-vless"]
    },
    {
      type: "urltest",
      tag: "raylink-udp",
      outbounds: ["raylink-tokyo-hysteria2"]
    },
    {
      type: "selector",
      tag: "raylink-auto",
      outbounds: ["raylink-smart", "raylink-tcp", "raylink-udp"]
    },
    { type: "direct", tag: "direct" }
  ]
};

test("Mihomo subscription contains compatible nodes, smart groups, routing and DNS", () => {
  const artifact = buildSubscriptionArtifact({
    format: "mihomo",
    singBoxConfig
  });

  assert.equal(artifact.contentType, "application/yaml; charset=utf-8");
  assert.equal(artifact.filename, "raylink-mihomo.yaml");
  assert.match(artifact.body, /^mixed-port: 7890/m);
  assert.match(artifact.body, /type: "vless"/);
  assert.match(artifact.body, /reality-opts:/);
  assert.match(artifact.body, /name: "RayLink 智能"/);
  assert.match(artifact.body, /name: "TCP 稳定"/);
  assert.match(artifact.body, /name: "UDP 高速"/);
  assert.match(artifact.body, /name: "AI 网站代理"/);
  assert.match(
    artifact.body,
    /name: "AI 网站代理"[\s\S]*?proxies:[\s\S]*?- "RayLink 智能"/
  );
  assert.match(artifact.body, /DOMAIN-SUFFIX,openai\.com,AI 网站代理/);
  assert.match(artifact.body, /DOMAIN-SUFFIX,chatgpt\.com,AI 网站代理/);
  assert.match(artifact.body, /GEOIP,CN,DIRECT/);
  assert.match(artifact.body, /MATCH,RayLink 代理/);
  assert.match(artifact.body, /nameserver-policy:/);
  assert.match(
    artifact.body,
    /"geosite:cn":[\s\S]*?- "https:\/\/223\.5\.5\.5\/dns-query"/
  );
  assert.match(
    artifact.body,
    /nameserver:[\s\S]*?- "https:\/\/1\.1\.1\.1\/dns-query#RayLink 代理"/
  );
});

test("Egern node subscription uses its native proxy schema and excludes unsupported protocols", () => {
  const artifact = buildSubscriptionArtifact({
    format: "egern",
    singBoxConfig: {
      ...singBoxConfig,
      outbounds: [
        {
          type: "naive",
          tag: "raylink-tokyo-naive",
          server: "node.example.com",
          server_port: 7443,
          username: "user@example.com",
          password: "password",
          tls: { enabled: true, server_name: "node.example.com" }
        },
        ...singBoxConfig.outbounds
      ]
    }
  });

  assert.equal(artifact.contentType, "application/yaml; charset=utf-8");
  assert.equal(artifact.filename, "raylink-egern.yaml");
  assert.match(artifact.body, /^proxies:/m);
  assert.match(artifact.body, /- vless:/);
  assert.match(artifact.body, /user_id: "11111111-1111-4111-8111-111111111111"/);
  assert.match(artifact.body, /reality:/);
  assert.match(artifact.body, /- hysteria2:/);
  assert.doesNotMatch(artifact.body, /naive/);
  assert.doesNotMatch(artifact.body, /policy_groups:/);
});

test("Egern profile adds smart TCP UDP manual policies, routing and encrypted DNS", () => {
  const artifact = buildSubscriptionArtifact({
    format: "egern-profile",
    singBoxConfig
  });

  assert.equal(artifact.filename, "raylink-egern-profile.yaml");
  assert.match(artifact.body, /^policy_groups:/m);
  assert.match(artifact.body, /- smart:/);
  assert.match(artifact.body, /name: "RayLink 智能"/);
  assert.match(artifact.body, /"\\(\\?i\\)VLESS\\|TROJAN\\|ANYTLS\\|VMESS": 0\.85/);
  assert.match(artifact.body, /name: "TCP 稳定"/);
  assert.match(artifact.body, /name: "UDP 高速"/);
  assert.match(
    artifact.body,
    /- fallback:[\s\S]*?name: "故障回退"[\s\S]*?policies:[\s\S]*?- "UDP 高速"[\s\S]*?- "TCP 稳定"/
  );
  assert.match(artifact.body, /- conditional:/);
  assert.match(artifact.body, /name: "网络环境"/);
  assert.match(
    artifact.body,
    /cellular:[\s\S]*?match: "\*"[\s\S]*?policy: "TCP 稳定"/
  );
  assert.match(
    artifact.body,
    /ssid:[\s\S]*?match: "\*"[\s\S]*?policy: "故障回退"/
  );
  assert.match(artifact.body, /default_policy: "RayLink 智能"/);
  assert.match(artifact.body, /- select:/);
  assert.match(artifact.body, /name: "手动选择"/);
  assert.match(artifact.body, /^rules:/m);
  assert.match(artifact.body, /match: "openai.com"/);
  assert.match(artifact.body, /policy: "网络环境"/);
  assert.match(artifact.body, /match: "cn"/);
  assert.match(artifact.body, /policy: "DIRECT"/);
  assert.match(artifact.body, /default:[\s\S]*?policy: "网络环境"/);
  assert.match(artifact.body, /^dns:/m);
  assert.ok(artifact.body.includes("https://1.1.1.1/dns-query"));
});

test("Mihomo and Egern exporters cover every shared RayLink public protocol", () => {
  const sharedConfig = {
    outbounds: [
      {
        type: "shadowsocks",
        tag: "shared-ss",
        server: "node.example.com",
        server_port: 8388,
        method: "2022-blake3-aes-128-gcm",
        password: "c2hhcmVkLWtleS0xNg=="
      },
      {
        type: "vmess",
        tag: "shared-vmess",
        server: "node.example.com",
        server_port: 8443,
        uuid: "22222222-2222-4222-8222-222222222222",
        security: "auto"
      },
      {
        type: "trojan",
        tag: "shared-trojan",
        server: "node.example.com",
        server_port: 9443,
        password: "trojan-password",
        tls: { enabled: true, server_name: "node.example.com" }
      },
      {
        type: "anytls",
        tag: "shared-anytls",
        server: "node.example.com",
        server_port: 8445,
        password: "anytls-password",
        tls: { enabled: true, server_name: "node.example.com" }
      },
      {
        type: "tuic",
        tag: "shared-tuic",
        server: "node.example.com",
        server_port: 8447,
        uuid: "33333333-3333-4333-8333-333333333333",
        password: "tuic-password",
        tls: { enabled: true, server_name: "node.example.com" }
      },
      {
        type: "hysteria",
        tag: "mihomo-only-hysteria",
        server: "node.example.com",
        server_port: 8446,
        auth_str: "hysteria-auth",
        tls: { enabled: true, server_name: "node.example.com" }
      }
    ]
  };

  const mihomo = buildSubscriptionArtifact({
    format: "mihomo",
    singBoxConfig: sharedConfig
  }).body;
  for (const type of ["ss", "vmess", "trojan", "anytls", "tuic", "hysteria"]) {
    assert.match(mihomo, new RegExp(`type: "${type}"`));
  }

  const egern = buildSubscriptionArtifact({
    format: "egern",
    singBoxConfig: sharedConfig
  }).body;
  for (const type of ["shadowsocks", "vmess", "trojan", "anytls", "tuic"]) {
    assert.match(egern, new RegExp(`- ${type}:`));
  }
  assert.doesNotMatch(egern, /hysteria:/);
});
