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
