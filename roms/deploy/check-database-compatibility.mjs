#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RayLinkStore } from "../server/database.js";

function fail(message) {
  process.stderr.write(`RayLink 数据库兼容检查失败：${message}\n`);
  process.exitCode = 1;
}

const sourcePath = process.argv[2] ? resolve(process.argv[2]) : "";
if (!sourcePath) {
  fail("请提供升级前 raylink.db 的完整路径");
} else {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "raylink-db-compat-"));
  const candidatePath = join(temporaryDirectory, basename(sourcePath));
  try {
    await copyFile(sourcePath, candidatePath);
    for (const suffix of ["-wal", "-shm"]) {
      await copyFile(`${sourcePath}${suffix}`, `${candidatePath}${suffix}`).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }

    const compatibilityStore = new RayLinkStore({
      dbPath: candidatePath,
      adminUsername: `compat-${randomUUID()}`,
      adminPassword: `Compatibility-${randomUUID()}`,
      subscriptionEncryptionKey: randomUUID(),
      seedDemoData: false,
      setupRequired: false
    });
    compatibilityStore.close();

    const verified = new DatabaseSync(candidatePath, { readOnly: true });
    try {
      const integrity = String(
        verified.prepare("PRAGMA integrity_check").get().integrity_check || ""
      );
      if (integrity !== "ok") throw new Error(`PRAGMA integrity_check 返回 ${integrity}`);
      const foreignKeyErrors = verified.prepare("PRAGMA foreign_key_check").all();
      if (foreignKeyErrors.length) {
        throw new Error(`发现 ${foreignKeyErrors.length} 个外键约束错误`);
      }
      process.stdout.write(`${JSON.stringify({
        compatible: true,
        integrity,
        foreignKeyErrors: 0
      })}\n`);
    } finally {
      verified.close();
    }
  } catch (error) {
    fail(error.message || "候选版本无法打开数据库副本");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
