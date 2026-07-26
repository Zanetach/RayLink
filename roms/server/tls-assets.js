import {
  createPrivateKey,
  createPublicKey,
  X509Certificate
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { sealNodeSecret } from "./node-secrets.js";

function safeAssetName(value) {
  return String(value || "runtime")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "runtime";
}

function certificateMatchesPrivateKey(certificatePem, privateKeyPem) {
  const certificate = new X509Certificate(certificatePem);
  const privateKey = createPrivateKey(privateKeyPem);
  const certificatePublic = certificate.publicKey.export({ type: "spki", format: "der" });
  const privatePublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (!certificatePublic.equals(privatePublic)) {
    const error = new Error("TLS 证书与私钥不匹配");
    error.code = "TLS_KEY_MISMATCH";
    error.statusCode = 422;
    throw error;
  }
  return certificate;
}

export class RemoteTlsAssetPackager {
  constructor(options = {}) {
    this.readFile = options.readFile || readFile;
    this.remoteDataDir = options.remoteDataDir || "/var/lib/raylink-node/sing-box";
  }

  async prepare(config, nodePublicKey) {
    const remoteConfig = structuredClone(config);
    const assets = [];
    for (const inbound of remoteConfig.inbounds || []) {
      const certificatePath = inbound.tls?.certificate_path;
      const keyPath = inbound.tls?.key_path;
      if (!certificatePath && !keyPath) continue;
      if (!certificatePath || !keyPath) {
        const error = new Error(`${inbound.tag || inbound.type} 的 TLS 证书路径不完整`);
        error.code = "TLS_ASSET_INCOMPLETE";
        error.statusCode = 422;
        throw error;
      }
      if (!nodePublicKey) {
        const error = new Error("远程主机尚未上报资产加密公钥，请先升级 RayLink Node");
        error.code = "NODE_ENCRYPTION_KEY_REQUIRED";
        error.statusCode = 409;
        throw error;
      }
      const [certificatePem, privateKeyPem] = await Promise.all([
        this.readFile(certificatePath, "utf8"),
        this.readFile(keyPath, "utf8")
      ]).catch(() => {
        const error = new Error(`${inbound.tag || inbound.type} 的 TLS 证书或私钥无法读取`);
        error.code = "TLS_ASSET_UNREADABLE";
        error.statusCode = 422;
        throw error;
      });
      if (Buffer.byteLength(certificatePem) > 1024 * 1024 || Buffer.byteLength(privateKeyPem) > 1024 * 1024) {
        const error = new Error(`${inbound.tag || inbound.type} 的 TLS 资产超过 1 MiB 限制`);
        error.code = "TLS_ASSET_TOO_LARGE";
        error.statusCode = 422;
        throw error;
      }
      const certificate = certificateMatchesPrivateKey(certificatePem, privateKeyPem);
      const validFrom = new Date(certificate.validFrom);
      const validTo = new Date(certificate.validTo);
      if (validFrom > new Date() || validTo <= new Date()) {
        const error = new Error(`${inbound.tag || inbound.type} 的 TLS 证书不在有效期内`);
        error.code = "TLS_CERTIFICATE_INVALID_DATE";
        error.statusCode = 422;
        throw error;
      }
      const assetName = safeAssetName(inbound.tag || inbound.type);
      const releaseId = certificate.fingerprint256.toLowerCase().replace(/[^a-f0-9]/g, "");
      const targetDirectory = join(this.remoteDataDir, "tls", "releases", releaseId);
      const targetCertificatePath = join(targetDirectory, `${assetName}.certificate.pem`);
      const targetKeyPath = join(targetDirectory, `${assetName}.private-key.pem`);
      inbound.tls.certificate_path = targetCertificatePath;
      inbound.tls.key_path = targetKeyPath;
      assets.push({
        name: assetName,
        certificatePem,
        privateKeyPem,
        targetCertificatePath,
        targetKeyPath,
        fingerprint256: certificate.fingerprint256,
        validTo: certificate.validTo
      });
    }
    if (!assets.length) {
      return { config: remoteConfig, sealedTlsBundle: null, tlsAssets: [] };
    }
    return {
      config: remoteConfig,
      sealedTlsBundle: sealNodeSecret(nodePublicKey, { assets }),
      tlsAssets: assets.map(({ name, fingerprint256, validTo }) => ({
        name,
        fingerprint256,
        validTo
      }))
    };
  }
}
