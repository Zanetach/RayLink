import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../server/config.js";

test("production control plane requires an HTTPS public origin", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "http://panel.example.com",
      RAYLINK_ADMIN_PASSWORD: "a-production-password"
    }),
    /must use HTTPS/
  );
  assert.equal(
    loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "https://panel.example.com",
      RAYLINK_ADMIN_PASSWORD: "a-production-password"
    }).publicOrigin,
    "https://panel.example.com"
  );
});

test("production first-run mode still requires HTTPS and a hashed expiring token", () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      RAYLINK_PUBLIC_ORIGIN: "http://203.0.113.10:4173",
      RAYLINK_ADMIN_PASSWORD: "a-production-password",
      RAYLINK_SETUP_REQUIRED: "true",
      RAYLINK_SETUP_TOKEN_HASH: "hashed-token",
      RAYLINK_SETUP_TOKEN_EXPIRES_AT: "2026-07-27T00:00:00.000Z"
    }),
    /must use HTTPS/
  );
  const uninitialized = loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://203.0.113.10",
    RAYLINK_ADMIN_PASSWORD: "a-production-password",
    RAYLINK_SETUP_REQUIRED: "true"
  });
  assert.equal(uninitialized.setupRequired, true);
  assert.equal(uninitialized.setupTokenHash, "");
  assert.throws(() => loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "https://203.0.113.10",
    RAYLINK_ADMIN_PASSWORD: "a-production-password",
    RAYLINK_SETUP_REQUIRED: "true",
    RAYLINK_SETUP_TOKEN_HASH: "hash-without-expiry"
  }), /must be set together/);
});
