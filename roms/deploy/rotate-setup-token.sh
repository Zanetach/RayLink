#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'RayLink 初始化令牌更新失败：%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "请以 root 运行"
env_file=/etc/raylink/raylink.env
node_binary=/opt/raylink-nodejs/bin/node
[ -f "$env_file" ] || fail "未找到 $env_file"
[ -x "$node_binary" ] || fail "未找到 RayLink Node.js Runtime"
grep -q '^RAYLINK_SETUP_REQUIRED=true$' "$env_file" \
  || fail "该实例未处于首次初始化模式"
setup_state="$(
  curl -fsS http://127.0.0.1:4173/api/setup/status \
  | "$node_binary" -e '
      const { readFileSync } = require("node:fs");
      process.stdout.write(String(JSON.parse(readFileSync(0, "utf8")).state || ""));
    '
)" || fail "无法读取本机 RayLink 初始化状态"
[ "$setup_state" = "SETUP_PENDING" ] \
  || fail "只有等待初始化的实例可以轮换令牌，当前状态：$setup_state"

setup_token="$(openssl rand -hex 24)"
setup_token_hash="$(
  printf '%s' "$setup_token" | "$node_binary" -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    process.stdout.write(createHash("sha256").update(readFileSync(0)).digest("base64url"));
  '
)"
setup_expires_at="$(
  "$node_binary" -e '
    process.stdout.write(new Date(Date.now() + 30 * 60 * 1000).toISOString());
  '
)"
public_origin="$(sed -n 's/^RAYLINK_PUBLIC_ORIGIN=//p' "$env_file" | head -n 1)"
printf '%s' "$public_origin" | grep -Eq '^https://[^[:space:]]+$' \
  || fail "RAYLINK_PUBLIC_ORIGIN 不是有效的 HTTPS 地址"

temporary_env="$(mktemp /etc/raylink/raylink.env.XXXXXX)"
trap 'rm -f "$temporary_env"' EXIT
awk \
  -v token_hash="$setup_token_hash" \
  -v expires_at="$setup_expires_at" '
    /^RAYLINK_SETUP_TOKEN_HASH=/ {
      print "RAYLINK_SETUP_TOKEN_HASH=" token_hash
      token_written = 1
      next
    }
    /^RAYLINK_SETUP_TOKEN_EXPIRES_AT=/ {
      print "RAYLINK_SETUP_TOKEN_EXPIRES_AT=" expires_at
      expiry_written = 1
      next
    }
    { print }
    END {
      if (!token_written) print "RAYLINK_SETUP_TOKEN_HASH=" token_hash
      if (!expiry_written) print "RAYLINK_SETUP_TOKEN_EXPIRES_AT=" expires_at
    }
  ' "$env_file" > "$temporary_env"
chmod 0600 "$temporary_env"
mv "$temporary_env" "$env_file"
trap - EXIT
systemctl restart raylink

printf '新的初始化地址（令牌 30 分钟有效）：\n'
printf '%s/setup#token=%s\n' "$public_origin" "$setup_token"
