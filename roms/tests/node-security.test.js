import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  generateNodeEncryptionKeypair,
  openNodeSecret,
  sealNodeSecret
} from "../server/node-secrets.js";
import { RemoteTlsAssetPackager } from "../server/tls-assets.js";
import { NodeRuntimeAdapter } from "../web/node/raylink-node.mjs";

const execFile = promisify(execFileCallback);

test("control plane seals TLS material so only the enrolled RayLink Node can open it", () => {
  const node = generateNodeEncryptionKeypair();
  const otherNode = generateNodeEncryptionKeypair();
  const secret = {
    assets: [{
      name: "raylink-trojan",
      certificatePem: "test-certificate",
      privateKeyPem: "test-private-key"
    }]
  };

  const envelope = sealNodeSecret(node.publicKey, secret);

  assert.equal(JSON.stringify(envelope).includes("test-private-key"), false);
  assert.deepEqual(openNodeSecret(node.privateKey, envelope), secret);
  assert.throws(() => openNodeSecret(otherNode.privateKey, envelope));
});

test("remote TLS packager validates a certificate pair, rewrites paths and never emits plaintext", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certificatePath = join(directory, "certificate.pem");
  const keyPath = join(directory, "private-key.pem");
  await execFile("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-subj",
    "/CN=node.example.com",
    "-days",
    "1"
  ]);
  const node = generateNodeEncryptionKeypair();
  const packager = new RemoteTlsAssetPackager({ remoteDataDir: "/managed/runtime" });
  const prepared = await packager.prepare({
    inbounds: [{
      type: "trojan",
      tag: "raylink-trojan",
      tls: {
        enabled: true,
        certificate_path: certificatePath,
        key_path: keyPath
      }
    }]
  }, node.publicKey);

  assert.equal(
    prepared.config.inbounds[0].tls.certificate_path,
    `/managed/runtime/tls/releases/${openedFingerprint(prepared)}/raylink-trojan.certificate.pem`
  );
  assert.equal(
    prepared.config.inbounds[0].tls.key_path,
    `/managed/runtime/tls/releases/${openedFingerprint(prepared)}/raylink-trojan.private-key.pem`
  );
  assert.equal(JSON.stringify(prepared.sealedTlsBundle).includes("PRIVATE KEY"), false);
  const opened = openNodeSecret(node.privateKey, prepared.sealedTlsBundle);
  assert.match(opened.assets[0].certificatePem, /BEGIN CERTIFICATE/);
  assert.match(opened.assets[0].privateKeyPem, /BEGIN PRIVATE KEY/);
});

test("RayLink Node atomically installs a sealed TLS bundle with private-key permissions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-node-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceCertificate = join(directory, "source-certificate.pem");
  const sourceKey = join(directory, "source-private-key.pem");
  await execFile("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    sourceKey,
    "-out",
    sourceCertificate,
    "-subj",
    "/CN=node.example.com",
    "-days",
    "1"
  ]);
  const runtimeDirectory = join(directory, "runtime");
  const node = generateNodeEncryptionKeypair();
  const packager = new RemoteTlsAssetPackager({ remoteDataDir: runtimeDirectory });
  const prepared = await packager.prepare({
    inbounds: [{
      type: "trojan",
      tag: "raylink-trojan",
      tls: {
        enabled: true,
        certificate_path: sourceCertificate,
        key_path: sourceKey
      }
    }]
  }, node.publicKey);
  const adapter = new NodeRuntimeAdapter({
    dataDir: runtimeDirectory,
    runtimeMode: "dry-run",
    commandRunner: async (_command, args) => ({
      stdout: args[0] === "version" ? "sing-box version 1.13.14" : ""
    })
  });

  const result = await adapter.publish({
    version: "deployment-1",
    checksum: "checksum-1",
    configText: JSON.stringify(prepared.config),
    sealedTlsBundle: prepared.sealedTlsBundle
  }, node.privateKey);

  const keyPath = prepared.config.inbounds[0].tls.key_path;
  assert.equal(result.tlsAssetsInstalled, 1);
  assert.match(await readFile(keyPath, "utf8"), /BEGIN PRIVATE KEY/);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);

  const certificatePath = prepared.config.inbounds[0].tls.certificate_path;
  const secondCertificate = join(directory, "second-certificate.pem");
  const secondKey = join(directory, "second-private-key.pem");
  await execFile("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", secondKey, "-out", secondCertificate,
    "-subj", "/CN=node-2.example.com", "-days", "1"
  ]);
  const secondPrepared = await packager.prepare({
    inbounds: [{
      type: "trojan",
      tag: "raylink-trojan",
      tls: {
        enabled: true,
        certificate_path: secondCertificate,
        key_path: secondKey
      }
    }]
  }, node.publicKey);
  const rejectingAdapter = new NodeRuntimeAdapter({
    dataDir: runtimeDirectory,
    runtimeMode: "dry-run",
    commandRunner: async (_command, args) => {
      if (args[0] === "check") throw new Error("candidate rejected");
      return { stdout: "sing-box version 1.13.14" };
    }
  });
  await assert.rejects(
    rejectingAdapter.publish({
      version: "deployment-2",
      checksum: "checksum-2",
      configText: JSON.stringify(secondPrepared.config),
      sealedTlsBundle: secondPrepared.sealedTlsBundle
    }, node.privateKey),
    /candidate rejected/
  );
  assert.match(await readFile(certificatePath, "utf8"), /BEGIN CERTIFICATE/);
  assert.match(await readFile(keyPath, "utf8"), /BEGIN PRIVATE KEY/);
  await assert.rejects(
    readFile(secondPrepared.config.inbounds[0].tls.certificate_path),
    { code: "ENOENT" }
  );

  const staleRelease = join(runtimeDirectory, "tls", "releases", "stale-release");
  await mkdir(staleRelease, { recursive: true });
  await writeFile(join(staleRelease, "old.private-key.pem"), "obsolete-private-key");
  await adapter.publish({
    version: "deployment-3",
    checksum: "checksum-3",
    configText: JSON.stringify(secondPrepared.config),
    sealedTlsBundle: secondPrepared.sealedTlsBundle
  }, node.privateKey);
  await access(certificatePath);
  await access(secondPrepared.config.inbounds[0].tls.certificate_path);
  await assert.rejects(access(staleRelease), { code: "ENOENT" });
});

function openedFingerprint(prepared) {
  return prepared.tlsAssets[0].fingerprint256.toLowerCase().replace(/[^a-f0-9]/g, "");
}
