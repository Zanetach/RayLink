import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
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

export function createRuntimePassword(byteLength = 24) {
  return randomBytes(byteLength).toString("base64url");
}

export function createShadowsocksKey() {
  return randomBytes(16).toString("base64");
}
