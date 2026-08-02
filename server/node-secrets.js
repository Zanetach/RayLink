import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes
} from "node:crypto";

const ENVELOPE_ALGORITHM = "x25519-hkdf-sha256-aes-256-gcm";
const ENVELOPE_CONTEXT = Buffer.from("raylink-node-secret-v1", "utf8");

function decode(value, field) {
  try {
    const decoded = Buffer.from(String(value || ""), "base64");
    if (!decoded.length) throw new Error();
    return decoded;
  } catch {
    throw new Error(`密封资产字段 ${field} 无效`);
  }
}

export function generateNodeEncryptionKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

export function validateNodeEncryptionPublicKey(publicKeyPem) {
  try {
    const key = createPublicKey(String(publicKeyPem || ""));
    if (key.asymmetricKeyType !== "x25519") throw new Error();
    return key.export({ type: "spki", format: "pem" }).toString();
  } catch {
    const error = new Error("节点加密公钥必须是有效的 X25519 公钥");
    error.code = "INVALID_NODE_ENCRYPTION_KEY";
    error.statusCode = 422;
    throw error;
  }
}

export function sealNodeSecret(publicKeyPem, value) {
  const recipient = createPublicKey(validateNodeEncryptionPublicKey(publicKeyPem));
  const ephemeral = generateKeyPairSync("x25519");
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipient
  });
  const key = Buffer.from(hkdfSync("sha256", shared, salt, ENVELOPE_CONTEXT, 32));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    algorithm: ENVELOPE_ALGORITHM,
    ephemeralPublicKey: ephemeral.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64")
  };
}

export function openNodeSecret(privateKeyPem, envelope) {
  if (envelope?.algorithm !== ENVELOPE_ALGORITHM) {
    throw new Error("节点密封资产算法不受支持");
  }
  const privateKey = createPrivateKey(String(privateKeyPem || ""));
  if (privateKey.asymmetricKeyType !== "x25519") {
    throw new Error("节点加密私钥必须使用 X25519");
  }
  const ephemeralPublicKey = createPublicKey({
    key: decode(envelope.ephemeralPublicKey, "ephemeralPublicKey"),
    type: "spki",
    format: "der"
  });
  const salt = decode(envelope.salt, "salt");
  const iv = decode(envelope.iv, "iv");
  const authTag = decode(envelope.authTag, "authTag");
  const ciphertext = decode(envelope.ciphertext, "ciphertext");
  const shared = diffieHellman({ privateKey, publicKey: ephemeralPublicKey });
  const key = Buffer.from(hkdfSync("sha256", shared, salt, ENVELOPE_CONTEXT, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}
