import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { BackupManager } from "../server/backup.js";
import { RayLinkStore } from "../server/database.js";

test("online SQLite backup is checksummed, integrity checked and retention bounded", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "raylink-backup-"));
  const store = new RayLinkStore({
    dbPath: join(directory, "raylink.db"),
    adminUsername: "admin",
    adminPassword: "Admin@2026"
  });
  const manager = new BackupManager({
    store,
    backupDir: join(directory, "backups"),
    retentionCount: 2
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const first = await manager.create();
  await writeFile(
    join(directory, "backups", "raylink-20000101T000000-orphaned.sqlite.tmp-wal"),
    "orphaned"
  );
  await writeFile(
    join(directory, "backups", "raylink-20000101T000000-orphaned.sqlite.tmp-shm"),
    "orphaned"
  );
  store.createUser({
    name: "Backup User",
    email: "backup-user@example.com",
    password: "Portal@2026",
    quotaGb: 10,
    nodeScope: ["all"],
    state: "active",
    portalStatus: "active",
    expiresAt: "2030-12-31"
  });
  await manager.create();
  const latest = await manager.create();

  assert.match(latest.checksum, /^[a-f0-9]{64}$/);
  assert.equal(latest.integrity, "ok");
  assert.equal((await manager.list()).length, 2);
  assert.equal((await manager.verify(latest.filename)).valid, true);
  const manifest = JSON.parse(
    await readFile(join(directory, "backups", `${latest.filename}.json`), "utf8")
  );
  assert.equal(manifest.checksum, latest.checksum);
  assert.deepEqual(
    (await readdir(join(directory, "backups")))
      .filter((filename) => filename.includes(".tmp"))
      .sort(),
    []
  );

  const restored = new DatabaseSync(join(directory, "backups", latest.filename), {
    readOnly: true
  });
  t.after(() => restored.close());
  assert.equal(
    restored.prepare("SELECT COUNT(*) AS count FROM users WHERE email = ?")
      .get("backup-user@example.com").count,
    1
  );
  assert.ok(!(await manager.list()).some((backup) => backup.filename === first.filename));
});
