#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'RayLink 数据库恢复失败：%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "请使用 root 执行"
[ "$#" -eq 1 ] || fail "用法：restore-database.sh /path/to/raylink-*.sqlite"

backup_path="$1"
manifest_path="${backup_path}.json"
database_path="${RAYLINK_DATABASE_PATH:-/var/lib/raylink/raylink.db}"
service_unit="${RAYLINK_SERVICE_UNIT:-raylink.service}"
service_user="${RAYLINK_SERVICE_USER:-root}"
service_group="${RAYLINK_SERVICE_GROUP:-root}"
recovery_root="${RAYLINK_RESTORE_RECOVERY_ROOT:-/var/backups/raylink}"

[ -f "$backup_path" ] || fail "找不到备份文件：$backup_path"
[ -f "$manifest_path" ] || fail "找不到备份清单：$manifest_path"
command -v node >/dev/null 2>&1 || fail "需要 Node.js 22.5+"
command -v sha256sum >/dev/null 2>&1 || fail "需要 sha256sum"
command -v systemctl >/dev/null 2>&1 || fail "需要 systemd"

expected_checksum="$(
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
    if (!/^[a-f0-9]{64}$/.test(String(manifest.checksum || ""))) process.exit(2);
    process.stdout.write(manifest.checksum);
  ' "$manifest_path"
)" || fail "备份清单格式无效"
actual_checksum="$(sha256sum "$backup_path" | awk 'NR == 1 { print $1 }')"
[ "$actual_checksum" = "$expected_checksum" ] || fail "SHA-256 校验失败"

integrity="$(
  node --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.argv[1], { readOnly: true });
    try {
      process.stdout.write(String(database.prepare("PRAGMA integrity_check").get().integrity_check));
    } finally {
      database.close();
    }
  ' "$backup_path"
)" || fail "无法读取备份数据库"
[ "$integrity" = "ok" ] || fail "SQLite 完整性检查失败：$integrity"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
recovery_directory="$recovery_root/restore-$timestamp"
install -d -m 0700 "$recovery_directory"
install -d -m 0750 "$(dirname -- "$database_path")"

restore_completed=false
service_was_active=false
database_existed=false
if [ -f "$database_path" ]; then
  database_existed=true
fi
if systemctl is-active --quiet "$service_unit"; then
  service_was_active=true
fi

rollback() {
  status=$?
  if [ "$restore_completed" = false ]; then
    systemctl stop "$service_unit" >/dev/null 2>&1 || true
    if [ -f "$recovery_directory/raylink.db" ]; then
      install -m 0600 "$recovery_directory/raylink.db" "$database_path"
    elif [ "$database_existed" = false ]; then
      rm -f "$database_path"
    fi
    if [ -f "$recovery_directory/raylink.db-wal" ]; then
      install -m 0600 "$recovery_directory/raylink.db-wal" "${database_path}-wal"
    fi
    if [ -f "$recovery_directory/raylink.db-shm" ]; then
      install -m 0600 "$recovery_directory/raylink.db-shm" "${database_path}-shm"
    fi
    if [ "$database_existed" = false ]; then
      rm -f "${database_path}-wal" "${database_path}-shm"
    fi
    rm -f "${database_path}.restore"
    chown -R "$service_user:$service_group" "$(dirname -- "$database_path")"
    if [ "$service_was_active" = true ]; then
      systemctl start "$service_unit" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap rollback EXIT

systemctl stop "$service_unit"
for suffix in "" "-wal" "-shm"; do
  source_path="${database_path}${suffix}"
  if [ -f "$source_path" ]; then
    install -m 0600 "$source_path" "$recovery_directory/raylink.db${suffix}"
  fi
done

temporary_database="${database_path}.restore"
install -m 0600 "$backup_path" "$temporary_database"
chown "$service_user:$service_group" "$temporary_database"
mv -f "$temporary_database" "$database_path"
rm -f "${database_path}-wal" "${database_path}-shm"

systemctl start "$service_unit"
systemctl is-active --quiet "$service_unit" || fail "服务恢复后未进入 active"

restore_completed=true
trap - EXIT
printf 'RayLink 数据库恢复完成：%s\n' "$database_path"
printf '恢复前数据库保存在：%s\n' "$recovery_directory"
