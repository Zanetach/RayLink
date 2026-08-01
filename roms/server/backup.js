import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

function backupError(code, message, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function safeBackupFilename(filename) {
  const value = String(filename || "");
  if (!/^raylink-\d{8}T\d{6}-[a-f0-9]{8}\.sqlite$/.test(value)) {
    throw backupError("BACKUP_NOT_FOUND", "备份文件不存在", 404);
  }
  return value;
}

export class BackupManager {
  constructor({ store, backupDir, retentionCount = 14 }) {
    this.store = store;
    this.backupDir = backupDir;
    this.retentionCount = Math.min(365, Math.max(1, Number(retentionCount) || 14));
    this.creating = false;
  }

  async create() {
    if (this.creating) {
      throw backupError("BACKUP_IN_PROGRESS", "已有数据库备份正在执行", 409);
    }
    this.creating = true;
    try {
      await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
      await this.cleanupTemporaryFiles();
    } catch (error) {
      this.creating = false;
      throw error;
    }
    const createdAt = new Date().toISOString();
    const stamp = createdAt.replace(/[-:]/g, "").slice(0, 15);
    const filename = `raylink-${stamp}-${randomUUID().slice(0, 8)}.sqlite`;
    const finalPath = join(this.backupDir, filename);
    const temporaryPath = `${finalPath}.tmp`;
    const manifestPath = `${finalPath}.json`;
    const temporaryManifestPath = `${manifestPath}.tmp`;
    try {
      await backup(this.store.db, temporaryPath);
      const check = new DatabaseSync(temporaryPath, { readOnly: true });
      let integrity;
      try {
        integrity = String(check.prepare("PRAGMA integrity_check").get().integrity_check || "");
      } finally {
        check.close();
      }
      if (integrity !== "ok") {
        throw backupError("BACKUP_INTEGRITY_FAILED", `数据库备份完整性检查失败：${integrity}`);
      }
      const checksum = await sha256(temporaryPath);
      const sizeBytes = (await stat(temporaryPath)).size;
      const manifest = {
        schemaVersion: 1,
        filename,
        createdAt,
        checksum,
        sizeBytes,
        integrity
      };
      await rename(temporaryPath, finalPath);
      await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600
      });
      await rename(temporaryManifestPath, manifestPath);
      await this.prune();
      return manifest;
    } finally {
      this.creating = false;
      await rm(temporaryPath, { force: true }).catch(() => {});
      await rm(`${temporaryPath}-wal`, { force: true }).catch(() => {});
      await rm(`${temporaryPath}-shm`, { force: true }).catch(() => {});
      await rm(temporaryManifestPath, { force: true }).catch(() => {});
    }
  }

  async list() {
    await mkdir(this.backupDir, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.backupDir);
    const backups = [];
    for (const entry of entries.filter((name) => name.endsWith(".sqlite.json"))) {
      try {
        const manifest = JSON.parse(await readFile(join(this.backupDir, entry), "utf8"));
        safeBackupFilename(manifest.filename);
        backups.push(manifest);
      } catch {}
    }
    return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async verify(filename) {
    const safeFilename = safeBackupFilename(filename);
    const path = join(this.backupDir, safeFilename);
    const manifestPath = `${path}.json`;
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      throw backupError("BACKUP_NOT_FOUND", "备份文件不存在", 404);
    }
    const checksum = await sha256(path).catch(() => null);
    let integrity = "unavailable";
    try {
      const check = new DatabaseSync(path, { readOnly: true });
      try {
        integrity = String(check.prepare("PRAGMA integrity_check").get().integrity_check || "");
      } finally {
        check.close();
      }
    } catch {
      integrity = "failed";
    }
    return {
      filename: safeFilename,
      valid: checksum === manifest.checksum && integrity === "ok",
      checksum,
      expectedChecksum: manifest.checksum,
      integrity
    };
  }

  async prune() {
    const backups = await this.list();
    for (const expired of backups.slice(this.retentionCount)) {
      const path = join(this.backupDir, safeBackupFilename(expired.filename));
      await rm(path, { force: true });
      await rm(`${path}.json`, { force: true });
    }
  }

  async cleanupTemporaryFiles() {
    const entries = await readdir(this.backupDir);
    for (const entry of entries.filter((name) => (
      /^raylink-[^.]+\.sqlite\.tmp(?:-(?:wal|shm))?$/.test(name)
    ))) {
      await rm(join(this.backupDir, entry), { force: true });
    }
  }
}
