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

test("production first-run mode accepts a temporary HTTP origin with a hashed expiring token", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    RAYLINK_PUBLIC_ORIGIN: "http://203.0.113.10:4173",
    RAYLINK_ADMIN_PASSWORD: "a-production-password",
    RAYLINK_SETUP_REQUIRED: "true",
    RAYLINK_SETUP_TOKEN_HASH: "hashed-token",
    RAYLINK_SETUP_TOKEN_EXPIRES_AT: "2026-07-27T00:00:00.000Z"
  });
  assert.equal(config.setupRequired, true);
  assert.equal(config.setupTokenHash, "hashed-token");
});
