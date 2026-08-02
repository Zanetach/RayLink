import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";

const PASSWORD_KEY_LENGTH = 64;
const scryptAsync = promisify(scrypt);

export function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, PASSWORD_KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(24).toString("base64url"));

export async function verifyPassword(password, storedHash) {
  const [algorithm, saltValue, hashValue] = String(storedHash).split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64url");
  const actual = await scryptAsync(String(password ?? ""), Buffer.from(saltValue, "base64url"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createSessionSecret() {
  return randomBytes(32).toString("base64url");
}

export function hashSessionSecret(secret) {
  return createHash("sha256").update(secret).digest("base64url");
}

function subscriptionEncryptionKey(keyMaterial) {
  return createHash("sha256")
    .update(`raylink-subscription-v1:${String(keyMaterial || "")}`)
    .digest();
}

function decodeCanonicalBase64Url(value, expectedLength = null) {
  const encoded = String(value || "");
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("订阅地址密文格式无效");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (
    decoded.toString("base64url") !== encoded
    || (expectedLength !== null && decoded.length !== expectedLength)
  ) {
    throw new Error("订阅地址密文格式无效");
  }
  return decoded;
}

export function protectSubscriptionSecret(secret, keyMaterial, publicId) {
  if (!keyMaterial) throw new Error("订阅地址加密密钥未配置");
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    subscriptionEncryptionKey(keyMaterial),
    iv,
    { authTagLength: 16 }
  );
  cipher.setAAD(Buffer.from(String(publicId)));
  const ciphertext = Buffer.concat([
    cipher.update(String(secret), "utf8"),
    cipher.final()
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

export function revealSubscriptionSecret(envelope, keyMaterial, publicId) {
  if (!keyMaterial) throw new Error("订阅地址加密密钥未配置");
  const [version, ivValue, tagValue, ciphertextValue] = String(envelope || "").split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error("订阅地址密文格式无效");
  }
  const iv = decodeCanonicalBase64Url(ivValue, 12);
  const tag = decodeCanonicalBase64Url(tagValue, 16);
  const ciphertext = decodeCanonicalBase64Url(ciphertextValue);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    subscriptionEncryptionKey(keyMaterial),
    iv,
    { authTagLength: 16 }
  );
  decipher.setAAD(Buffer.from(String(publicId)));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]).toString("utf8");
}

export function createRuntimePassword(byteLength = 24) {
  return randomBytes(byteLength).toString("base64url");
}

export function createShadowsocksKey() {
  return randomBytes(16).toString("base64");
}
