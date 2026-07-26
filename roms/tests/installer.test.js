import assert from "node:assert/strict";
import test from "node:test";

import { SingBoxInstaller } from "../server/singbox/installer.js";

test("runtime inspection parses version, platform and build tags", async () => {
  const installer = new SingBoxInstaller({
    binaryPath: "sing-box",
    platform: "darwin",
    runner: async () => ({
      stdout: [
        "sing-box version 1.13.12",
        "",
        "Environment: go1.26.5 darwin/arm64",
        "Tags: with_quic,with_utls,with_acme"
      ].join("\n")
    })
  });

  assert.deepEqual(await installer.status(), {
    installed: true,
    version: "1.13.12",
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
        return { stdout: "sing-box version 1.13.12\nEnvironment: go1.26.5 darwin/arm64\nTags: with_quic" };
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
        return { stdout: "sing-box version 1.13.12\nEnvironment: go1.26.5 linux/amd64\nTags: with_quic" };
      }
      return { stdout: "" };
    }
  });

  assert.equal((await installer.install()).installed, true);
  assert.deepEqual(calls[1], [
    "sh",
    ["-c", "curl -fsSL https://sing-box.app/install.sh | sh -s -- --version 1.13.12"]
  ]);
});

test("one-click installer replaces a mismatched Linux sing-box version", async () => {
  const calls = [];
  let version = "1.12.9";
  const installer = new SingBoxInstaller({
    binaryPath: "sing-box",
    platform: "linux",
    runner: async (file, args) => {
      calls.push([file, args]);
      if (file === "sh") {
        version = "1.13.12";
        return { stdout: "" };
      }
      return {
        stdout: `sing-box version ${version}\nEnvironment: go1.26.5 linux/amd64\nTags: with_quic`
      };
    }
  });

  assert.equal((await installer.install()).version, "1.13.12");
  assert.deepEqual(calls[1], [
    "sh",
    ["-c", "curl -fsSL https://sing-box.app/install.sh | sh -s -- --version 1.13.12"]
  ]);
});

test("one-click installer rejects a concurrent package-manager run", async () => {
  let releaseProbe;
  const probeBlocked = new Promise((resolve) => {
    releaseProbe = resolve;
  });
  let singBoxCalls = 0;
  const installer = new SingBoxInstaller({
    platform: "darwin",
    runner: async (file) => {
      if (file === "sing-box") {
        singBoxCalls += 1;
        if (singBoxCalls === 1) {
          await probeBlocked;
          const error = new Error("missing");
          error.code = "ENOENT";
          throw error;
        }
        return { stdout: "sing-box version 1.13.12\nEnvironment: go1.26.5 darwin/arm64\nTags: with_quic" };
      }
      return { stdout: "" };
    }
  });

  const firstInstall = installer.install();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    installer.install(),
    (error) => error.code === "INSTALLATION_IN_PROGRESS"
  );
  releaseProbe();
  assert.equal((await firstInstall).installed, true);
});
