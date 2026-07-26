import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const managedRuleSets = [
  {
    filename: "geosite-geolocation-cn.srs",
    url: "https://raw.githubusercontent.com/SagerNet/sing-geosite/a9958574d2c9c8c1f01b726ef9930e0244b10b23/geosite-geolocation-cn.srs",
    sha256: "342f2173df2c2ec3a31a3e6aa0c5eb11dae6db82a4a1fff923f631b17e26f92a"
  },
  {
    filename: "geoip-cn.srs",
    url: "https://raw.githubusercontent.com/SagerNet/sing-geoip/5605651c12ed5b2fcf3b5de580c041eb9d8d938e/geoip-cn.srs",
    sha256: "bc1a9eb66f9c6a0fe9fc5300cf5b5e885e0f9eadd7213b085b767a95d6af3d2a"
  }
];

function validRuleSet(payload, source) {
  if (payload.length <= 32 || payload.subarray(0, 3).toString("ascii") !== "SRS") return false;
  return createHash("sha256").update(payload).digest("hex") === source.sha256;
}

export class ManagedRuleSetCache {
  constructor({
    dataDir,
    fetchImpl = globalThis.fetch,
    refreshMs = 24 * 60 * 60 * 1000,
    requestTimeoutMs = 10_000
  }) {
    this.cacheDir = join(dataDir, "rule-sets");
    this.fetchImpl = fetchImpl;
    this.refreshMs = refreshMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.cachedFiles = new Set();
    this.preparing = null;
  }

  available() {
    return managedRuleSets.every(({ filename }) => this.cachedFiles.has(filename));
  }

  async prepare() {
    if (this.preparing) return this.preparing;
    this.preparing = this.refresh().finally(() => {
      this.preparing = null;
    });
    return this.preparing;
  }

  async refresh() {
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    await Promise.all(managedRuleSets.map(async (source) => {
      const target = join(this.cacheDir, source.filename);
      let existing = null;
      try {
        existing = await stat(target);
        const payload = await readFile(target);
        if (validRuleSet(payload, source)) {
          this.cachedFiles.add(source.filename);
        } else {
          await unlink(target);
          existing = null;
          this.cachedFiles.delete(source.filename);
        }
      } catch {
        existing = null;
        this.cachedFiles.delete(source.filename);
      }
      if (existing && Date.now() - existing.mtimeMs < this.refreshMs) return;
      try {
        const response = await this.fetchImpl(source.url, {
          signal: AbortSignal.timeout(this.requestTimeoutMs),
          headers: { "user-agent": "RayLink rule-set cache" }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = Buffer.from(await response.arrayBuffer());
        if (!validRuleSet(payload, source)) throw new Error("rule-set format or checksum mismatch");
        const temporary = `${target}.${randomUUID()}.tmp`;
        await writeFile(temporary, payload, { mode: 0o600 });
        await rename(temporary, target);
        this.cachedFiles.add(source.filename);
      } catch (error) {
        if (!existing) this.cachedFiles.delete(source.filename);
        console.warn(`[RayLink] Rule-set refresh failed for ${source.filename}: ${error.message}`);
      }
    }));
  }

  async get(filename) {
    if (!managedRuleSets.some((source) => source.filename === filename)) return null;
    if (!this.cachedFiles.has(filename)) return null;
    try {
      return await readFile(join(this.cacheDir, filename));
    } catch {
      this.cachedFiles.delete(filename);
      return null;
    }
  }
}
