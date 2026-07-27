import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CaddySetupAccessManager } from "../server/setup-access.js";

test("Caddy setup activates a domain and can restore the IP entry point", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-caddy-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caddyfilePath = join(directory, "Caddyfile");
  const environmentFilePath = join(directory, "raylink.env");
  const originalCaddyfile = "https://203.0.113.10 {\n  reverse_proxy 127.0.0.1:4173\n}\n";
  const originalEnvironment = [
    "RAYLINK_PUBLIC_ORIGIN=https://203.0.113.10",
    "RAYLINK_PROXY_HOST=203.0.113.10",
    ""
  ].join("\n");
  await writeFile(caddyfilePath, originalCaddyfile);
  await writeFile(environmentFilePath, originalEnvironment);
  const commands = [];
  const verifiedOrigins = [];
  const manager = new CaddySetupAccessManager({
    caddyfilePath,
    environmentFilePath,
    initialOrigin: "https://203.0.113.10",
    certificatePath: "/etc/caddy/raylink/control-plane.crt",
    privateKeyPath: "/etc/caddy/raylink/control-plane.key",
    lookup: async () => [{ address: "203.0.113.10", family: 4 }],
    runCommand: async (command, args) => commands.push([command, ...args]),
    verifyHttps: async (origin) => verifiedOrigins.push(origin)
  });
  const input = {
    access: { canonicalOrigin: "https://panel.example.com" },
    certificate: { mode: "caddy-auto", email: "ops@example.com" }
  };

  assert.deepEqual(await manager.preflight(input), {
    dns: "passed",
    caddy: "passed"
  });
  const activation = await manager.activate(input);

  const activeCaddyfile = await readFile(caddyfilePath, "utf8");
  assert.match(activeCaddyfile, /email ops@example\.com/);
  assert.match(activeCaddyfile, /panel\.example\.com \{/);
  assert.match(activeCaddyfile, /https:\/\/203\.0\.113\.10 \{/);
  assert.match(activeCaddyfile, /tls \/etc\/caddy\/raylink\/control-plane\.crt \/etc\/caddy\/raylink\/control-plane\.key/);
  assert.match(activeCaddyfile, /reverse_proxy 127\.0\.0\.1:4173/);
  assert.doesNotMatch(activeCaddyfile, /\n\s*log\s/);
  assert.equal(
    await readFile(environmentFilePath, "utf8"),
    [
      "RAYLINK_PUBLIC_ORIGIN=https://panel.example.com",
      "RAYLINK_PROXY_HOST=panel.example.com",
      ""
    ].join("\n")
  );
  assert.deepEqual(commands, [
    ["caddy", "version"],
    ["caddy", "adapt", "--config", `${caddyfilePath}.candidate`, "--adapter", "caddyfile"],
    ["caddy", "reload", "--config", caddyfilePath, "--adapter", "caddyfile"]
  ]);
  assert.deepEqual(verifiedOrigins, ["https://panel.example.com"]);

  await activation.rollback();
  assert.equal(await readFile(caddyfilePath, "utf8"), originalCaddyfile);
  assert.equal(await readFile(environmentFilePath, "utf8"), originalEnvironment);
  assert.deepEqual(commands.at(-1), [
    "caddy",
    "reload",
    "--config",
    caddyfilePath,
    "--adapter",
    "caddyfile"
  ]);
});

test("Caddy setup restores both files when the live reload fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-caddy-rollback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caddyfilePath = join(directory, "Caddyfile");
  const environmentFilePath = join(directory, "raylink.env");
  const originalCaddyfile = "https://203.0.113.10 {}\n";
  const originalEnvironment = "RAYLINK_PUBLIC_ORIGIN=https://203.0.113.10\n";
  await writeFile(caddyfilePath, originalCaddyfile);
  await writeFile(environmentFilePath, originalEnvironment);
  let reloads = 0;
  const manager = new CaddySetupAccessManager({
    caddyfilePath,
    environmentFilePath,
    initialOrigin: "https://203.0.113.10",
    certificatePath: "/etc/caddy/raylink/control-plane.crt",
    privateKeyPath: "/etc/caddy/raylink/control-plane.key",
    lookup: async () => [{ address: "203.0.113.10", family: 4 }],
    verifyHttps: async () => {},
    runCommand: async (_command, args) => {
      if (args[0] === "reload" && reloads++ === 0) {
        throw new Error("reload rejected");
      }
    }
  });

  await assert.rejects(
    () => manager.activate({
      access: { canonicalOrigin: "https://panel.example.com" },
      certificate: { mode: "caddy-auto", email: "ops@example.com" }
    }),
    (error) => {
      assert.equal(error.code, "CADDY_ACTIVATION_FAILED");
      return true;
    }
  );
  assert.equal(reloads, 2);
  assert.equal(await readFile(caddyfilePath, "utf8"), originalCaddyfile);
  assert.equal(await readFile(environmentFilePath, "utf8"), originalEnvironment);
});

test("Caddy setup rejects DNS records that do not point to the initial server", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-caddy-dns-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new CaddySetupAccessManager({
    caddyfilePath: join(directory, "Caddyfile"),
    environmentFilePath: join(directory, "raylink.env"),
    initialOrigin: "https://203.0.113.10",
    certificatePath: "/etc/caddy/raylink/control-plane.crt",
    privateKeyPath: "/etc/caddy/raylink/control-plane.key",
    lookup: async () => [{ address: "198.51.100.8", family: 4 }],
    runCommand: async () => {}
  });

  await assert.rejects(
    () => manager.preflight({
      access: { canonicalOrigin: "https://panel.example.com" },
      certificate: { mode: "caddy-auto", email: "ops@example.com" }
    }),
    (error) => {
      assert.equal(error.code, "DOMAIN_DNS_MISMATCH");
      assert.match(error.message, /198\.51\.100\.8/);
      assert.match(error.message, /203\.0\.113\.10/);
      return true;
    }
  );
});

test("Caddy setup restores both files when the second atomic replacement fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-caddy-partial-write-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caddyfilePath = join(directory, "Caddyfile");
  const environmentFilePath = join(directory, "raylink.env");
  const originalCaddyfile = "https://203.0.113.10 {}\n";
  const originalEnvironment = "RAYLINK_PUBLIC_ORIGIN=https://203.0.113.10\n";
  await writeFile(caddyfilePath, originalCaddyfile);
  await writeFile(environmentFilePath, originalEnvironment);
  let replacementCount = 0;
  const manager = new CaddySetupAccessManager({
    caddyfilePath,
    environmentFilePath,
    initialOrigin: "https://203.0.113.10",
    certificatePath: "/etc/caddy/raylink/control-plane.crt",
    privateKeyPath: "/etc/caddy/raylink/control-plane.key",
    lookup: async () => [{ address: "203.0.113.10", family: 4 }],
    runCommand: async () => {},
    verifyHttps: async () => {},
    replaceFile: async (source, destination) => {
      replacementCount += 1;
      if (replacementCount === 2) throw new Error("environment rename failed");
      const { rename } = await import("node:fs/promises");
      await rename(source, destination);
    }
  });

  await assert.rejects(
    () => manager.activate({
      access: { canonicalOrigin: "https://panel.example.com" },
      certificate: { mode: "caddy-auto", email: "ops@example.com" }
    }),
    (error) => {
      assert.equal(error.code, "CADDY_FILES_ACTIVATION_FAILED");
      return true;
    }
  );
  assert.equal(await readFile(caddyfilePath, "utf8"), originalCaddyfile);
  assert.equal(await readFile(environmentFilePath, "utf8"), originalEnvironment);
});

test("Caddy setup restores the IP entry point when trusted HTTPS is unavailable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-caddy-https-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const caddyfilePath = join(directory, "Caddyfile");
  const environmentFilePath = join(directory, "raylink.env");
  const originalCaddyfile = "https://203.0.113.10 {}\n";
  const originalEnvironment = "RAYLINK_PUBLIC_ORIGIN=https://203.0.113.10\n";
  await writeFile(caddyfilePath, originalCaddyfile);
  await writeFile(environmentFilePath, originalEnvironment);
  let reloads = 0;
  const manager = new CaddySetupAccessManager({
    caddyfilePath,
    environmentFilePath,
    initialOrigin: "https://203.0.113.10",
    certificatePath: "/etc/caddy/raylink/control-plane.crt",
    privateKeyPath: "/etc/caddy/raylink/control-plane.key",
    lookup: async () => [{ address: "203.0.113.10", family: 4 }],
    runCommand: async (_command, args) => {
      if (args[0] === "reload") reloads += 1;
    },
    verifyHttps: async () => {
      throw new Error("certificate not trusted");
    }
  });

  await assert.rejects(
    () => manager.activate({
      access: { canonicalOrigin: "https://panel.example.com" },
      certificate: { mode: "caddy-auto", email: "ops@example.com" }
    }),
    (error) => {
      assert.equal(error.code, "DOMAIN_HTTPS_NOT_READY");
      return true;
    }
  );
  assert.equal(reloads, 2);
  assert.equal(await readFile(caddyfilePath, "utf8"), originalCaddyfile);
  assert.equal(await readFile(environmentFilePath, "utf8"), originalEnvironment);
});
