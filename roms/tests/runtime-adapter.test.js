import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalSingBoxAdapter } from "../server/singbox/local-adapter.js";

test("local adapter validates before atomically replacing the active config", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-"));
  const fakeBinary = join(dataDir, "fake-sing-box");
  await writeFile(fakeBinary, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("sing-box version 1.13.12");
  process.exit(0);
}
if (args[0] !== "check" || args[1] !== "-c") process.exit(2);
const config = JSON.parse(fs.readFileSync(args[2], "utf8"));
if (config.reject) {
  console.error("invalid config");
  process.exit(1);
}
console.log("configuration is valid");
`);
  await chmod(fakeBinary, 0o755);

  const adapter = new LocalSingBoxAdapter({
    dataDir,
    binaryPath: fakeBinary,
    mode: "dry-run"
  });
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const first = await adapter.publish({
    version: "v1",
    checksum: "first",
    configText: "{\"inbounds\":[]}\n"
  });
  assert.equal(first.mode, "dry-run");
  assert.equal(first.runtimeVersion, "1.13.12");

  const activePath = join(dataDir, "sing-box", "config.json");
  assert.equal(await readFile(activePath, "utf8"), "{\"inbounds\":[]}\n");

  await assert.rejects(
    () => adapter.publish({
      version: "v2",
      checksum: "second",
      configText: "{\"reject\":true}\n"
    }),
    /invalid config/
  );
  assert.equal(await readFile(activePath, "utf8"), "{\"inbounds\":[]}\n");
});

test("first systemd publish failure does not leave an unstarted config active", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-failed-first-"));
  const fakeBinary = join(dataDir, "fake-sing-box");
  await writeFile(fakeBinary, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("sing-box version 1.13.12");
  process.exit(0);
}
process.exit(args[0] === "check" ? 0 : 2);
`);
  await chmod(fakeBinary, 0o755);
  const adapter = new LocalSingBoxAdapter({
    dataDir,
    binaryPath: fakeBinary,
    mode: "systemd"
  });
  adapter.restartSystemd = async () => {
    throw new Error("restart failed");
  };
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  await assert.rejects(
    () => adapter.publish({
      version: "v1",
      checksum: "first",
      configText: "{\"inbounds\":[]}\n"
    }),
    /restart failed/
  );
  await assert.rejects(() => readFile(join(dataDir, "sing-box", "config.json"), "utf8"), /ENOENT/);
});

test("version probe failure after activation does not fail the deployment", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "raylink-runtime-version-probe-"));
  const fakeBinary = join(dataDir, "fake-sing-box");
  await writeFile(fakeBinary, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "version") process.exit(1);
process.exit(args[0] === "check" ? 0 : 2);
`);
  await chmod(fakeBinary, 0o755);
  const adapter = new LocalSingBoxAdapter({
    dataDir,
    binaryPath: fakeBinary,
    mode: "dry-run"
  });
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const result = await adapter.publish({
    version: "v1",
    checksum: "first",
    configText: "{\"inbounds\":[]}\n"
  });
  assert.equal(result.runtimeVersion, null);
  assert.equal(
    await readFile(join(dataDir, "sing-box", "config.json"), "utf8"),
    "{\"inbounds\":[]}\n"
  );
});
