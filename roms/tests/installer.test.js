import assert from "node:assert/strict";
import test from "node:test";

import { SingBoxInstaller } from "../server/singbox/installer.js";

test("runtime inspection parses version, platform and build tags", async () => {
  const installer = new SingBoxInstaller({
    binaryPath: "sing-box",
    platform: "darwin",
    runner: async () => ({
      stdout: [
        "sing-box version 1.13.14",
        "",
        "Environment: go1.26.5 darwin/arm64",
        "Tags: with_quic,with_utls,with_acme"
      ].join("\n")
    })
  });

  assert.deepEqual(await installer.status(), {
    installed: true,
    version: "1.13.14",
    platform: "darwin",
    architecture: "arm64",
    tags: ["with_quic", "with_utls", "with_acme"],
    binaryPath: "sing-box"
  });
});

test("one-click installer uses the fixed official package command for macOS", async () => {
  const calls = [];
  const installer = new SingBoxInstaller({
    binaryPath: "sing-box",
    platform: "darwin",
    runner: async (file, args) => {
      calls.push([file, args]);
      if (file === "sing-box" && calls.length === 1) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      if (file === "sing-box") {
        return { stdout: "sing-box version 1.13.14\nEnvironment: go1.26.5 darwin/arm64\nTags: with_quic" };
      }
      return { stdout: "" };
    }
  });

  const result = await installer.install();
  assert.equal(result.installed, true);
  assert.deepEqual(calls[1], ["brew", ["install", "sing-box"]]);
});

test("one-click installer uses the official sing-box installer on Linux", async () => {
  const calls = [];
  const installer = new SingBoxInstaller({
    binaryPath: "sing-box",
    platform: "linux",
    runner: async (file, args) => {
      calls.push([file, args]);
      if (file === "sing-box" && calls.length === 1) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      if (file === "sing-box") {
        return { stdout: "sing-box version 1.13.14\nEnvironment: go1.26.5 linux/amd64\nTags: with_quic" };
      }
      return { stdout: "" };
    }
  });

  assert.equal((await installer.install()).installed, true);
  assert.deepEqual(calls[1], [
    "sh",
    ["-c", "curl -fsSL https://sing-box.app/install.sh | sh"]
  ]);
});
