import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../server/config.js";

const productionSecrets = {
  RAYLINK_ADMIN_PASSWORD: "a-production-password",
  RAYLINK_SUBSCRIPTION_ENCRYPTION_KEY: "a-production-subscription-key"
};

test("production control plane requires an HTTPS public origin", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "http://panel.example.com",
      ...productionSecrets
    }),
    /must use HTTPS/
  );
  assert.equal(
    loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
      ...productionSecrets
    }).publicOrigin,
    "https://panel.example.com"
  );
});

test("subscription origin is independent from the control-plane and Host addresses", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
    RAYLINK_SUBSCRIPTION_ORIGIN: "https://sub.example.com",
    RAYLINK_PROXY_HOST: "node.example.com",
    ...productionSecrets
  });

  assert.equal(config.publicOrigin, "https://panel.example.com");
  assert.equal(config.subscriptionOrigin, "https://sub.example.com");
  assert.equal(config.proxyHost, "node.example.com");
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
      RAYLINK_SUBSCRIPTION_ORIGIN: "http://sub.example.com",
      ...productionSecrets
    }),
    /RAYLINK_SUBSCRIPTION_ORIGIN must use HTTPS/
  );
});

test("subscription bearer encryption requires a dedicated production key", () => {
  const dedicated = loadConfig({
    RAYLINK_ADMIN_PASSWORD: "admin-password",
    RAYLINK_SUBSCRIPTION_ENCRYPTION_KEY: "subscription-encryption-key"
  });
  assert.equal(
    dedicated.subscriptionEncryptionKey,
    "subscription-encryption-key"
  );

  const upgraded = loadConfig({
    RAYLINK_ADMIN_PASSWORD: "stable-bootstrap-password"
  });
  assert.equal(
    upgraded.subscriptionEncryptionKey,
    "stable-bootstrap-password"
  );
  assert.throws(() => loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
    RAYLINK_ADMIN_PASSWORD: "a-production-password"
  }), /RAYLINK_SUBSCRIPTION_ENCRYPTION_KEY must be set/);
});

test("protocol probe endpoint is configurable and must use HTTPS in production", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
    ...productionSecrets,
    RAYLINK_PROTOCOL_PROBE_URL: "https://probe.example.com/generate_204"
  });
  assert.equal(
    config.protocolProbeUrl,
    "https://probe.example.com/generate_204"
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
      ...productionSecrets,
      RAYLINK_PROTOCOL_PROBE_URL: "http://probe.example.com/"
    }),
    /RAYLINK_PROTOCOL_PROBE_URL must use HTTPS/
  );
});

test("production first-run mode still requires HTTPS and a hashed expiring token", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "http://203.0.113.10:4173",
      ...productionSecrets,
      RAYLINK_SETUP_REQUIRED: "true",
      RAYLINK_SETUP_TOKEN_HASH: "hashed-token",
      RAYLINK_SETUP_TOKEN_EXPIRES_AT: "2026-07-27T00:00:00.000Z"
    }),
    /must use HTTPS/
  );
  const uninitialized = loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://203.0.113.10",
    ...productionSecrets,
    RAYLINK_SETUP_REQUIRED: "true"
  });
  assert.equal(uninitialized.setupRequired, true);
  assert.equal(uninitialized.setupTokenHash, "");
  assert.throws(() => loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://203.0.113.10",
    ...productionSecrets,
    RAYLINK_SETUP_REQUIRED: "true",
    RAYLINK_SETUP_TOKEN_HASH: "hash-without-expiry"
  }), /must be set together/);
});

test("first-run configuration exposes the managed Caddy access paths", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://203.0.113.10",
    ...productionSecrets,
    RAYLINK_SETUP_REQUIRED: "true",
    RAYLINK_CADDY_BIN: "/usr/bin/caddy",
    RAYLINK_CADDYFILE: "/etc/caddy/Caddyfile",
    RAYLINK_ENV_FILE: "/etc/raylink/raylink.env",
    RAYLINK_BBR_CONFIG: "/var/lib/raylink/managed/99-raylink-bbr.conf",
    RAYLINK_CONTROL_CERT: "/etc/caddy/raylink/control-plane.crt",
    RAYLINK_CONTROL_KEY: "/etc/caddy/raylink/control-plane.key"
  });

  assert.deepEqual({
    caddyBinary: config.caddyBinary,
    caddyfilePath: config.caddyfilePath,
    environmentFilePath: config.environmentFilePath,
    bbrConfigPath: config.bbrConfigPath,
    controlPlaneCertificatePath: config.controlPlaneCertificatePath,
    controlPlanePrivateKeyPath: config.controlPlanePrivateKeyPath
  }, {
    caddyBinary: "/usr/bin/caddy",
    caddyfilePath: "/etc/caddy/Caddyfile",
    environmentFilePath: "/etc/raylink/raylink.env",
    bbrConfigPath: "/var/lib/raylink/managed/99-raylink-bbr.conf",
    controlPlaneCertificatePath: "/etc/caddy/raylink/control-plane.crt",
    controlPlanePrivateKeyPath: "/etc/caddy/raylink/control-plane.key"
  });
});
