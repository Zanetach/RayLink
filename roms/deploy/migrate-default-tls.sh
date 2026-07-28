#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  printf '请使用 root 运行 TLS 迁移\n' >&2
  exit 1
fi

environment_file="/etc/raylink/raylink.env"
node_binary="/opt/raylink-nodejs/bin/node"
script_directory="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -r "$environment_file" ]]; then
  printf '未找到 RayLink 生产环境文件：%s\n' "$environment_file" >&2
  exit 1
fi
if [[ ! -x "$node_binary" ]]; then
  printf '未找到 RayLink 内置 Node.js：%s\n' "$node_binary" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$environment_file"
set +a

if [[ "${NODE_ENV:-}" != "production" || "${RAYLINK_RUNTIME_MODE:-}" != "systemd" ]]; then
  printf '拒绝迁移：当前不是 RayLink production/systemd 环境\n' >&2
  exit 1
fi

restart_control_plane() {
  systemctl start raylink.service
}

systemctl stop raylink.service
trap restart_control_plane EXIT
"$node_binary" "$script_directory/migrate-default-tls.mjs"
systemctl start raylink.service
trap - EXIT
