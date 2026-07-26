#!/usr/bin/env bash
set -euo pipefail

RAYLINK_SERVER="${RAYLINK_SERVER:-}"
RAYLINK_ENROLL_TOKEN="${RAYLINK_ENROLL_TOKEN:-}"
RAYLINK_NODE_ROOT="${RAYLINK_NODE_ROOT:-/opt/raylink-node}"
RAYLINK_NODE_VERSION="${RAYLINK_NODE_VERSION:-22}"
SING_BOX_VERSION="${SING_BOX_VERSION:-1.13.12}"

fail() {
  printf 'RayLink Node 安装失败：%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "请通过 sudo 运行安装命令"
[ "$(uname -s)" = "Linux" ] || fail "当前一键安装仅支持 Linux VPS"
[ -n "$RAYLINK_SERVER" ] || fail "缺少 RAYLINK_SERVER"
[ -n "$RAYLINK_ENROLL_TOKEN" ] || fail "缺少 RAYLINK_ENROLL_TOKEN"
printf '%s' "$RAYLINK_SERVER" | grep -Eq '^https?://[A-Za-z0-9._:-]+$' || fail "RAYLINK_SERVER 必须是控制面的 HTTP(S) 根地址"
printf '%s' "$RAYLINK_ENROLL_TOKEN" | grep -Eq '^[A-Za-z0-9_-]{20,256}$' || fail "接入令牌格式无效"
command -v curl >/dev/null 2>&1 || fail "需要 curl"
command -v tar >/dev/null 2>&1 || fail "需要 tar"
command -v systemctl >/dev/null 2>&1 || fail "需要 systemd"

if systemctl list-unit-files sing-box.service >/dev/null 2>&1 \
  && systemctl is-active --quiet sing-box.service; then
  fail "检测到现有 sing-box.service 正在运行；为避免业务中断，请先迁移或停止现有服务后重试"
fi

machine_arch="$(uname -m)"
case "$machine_arch" in
  x86_64|amd64) node_arch="x64" ;;
  aarch64|arm64) node_arch="arm64" ;;
  *) fail "暂不支持 CPU 架构：$machine_arch" ;;
esac

install -d -m 0755 "$RAYLINK_NODE_ROOT"
install -d -m 0700 /etc/raylink-node
install -d -m 0750 /var/lib/raylink-node/sing-box

if [ ! -x "$RAYLINK_NODE_ROOT/node/bin/node" ]; then
  node_dist_url="https://nodejs.org/dist/latest-v${RAYLINK_NODE_VERSION}.x"
  node_archive="$(curl -fsSL "$node_dist_url/SHASUMS256.txt" | awk -v arch="$node_arch" '$2 ~ ("linux-" arch "\\.tar\\.xz$") { print $2; exit }')"
  [ -n "$node_archive" ] || fail "无法解析 Node.js v${RAYLINK_NODE_VERSION} 安装包"
  work_dir="$(mktemp -d)"
  trap 'rm -rf "$work_dir"' EXIT
  curl -fsSL "$node_dist_url/$node_archive" -o "$work_dir/$node_archive"
  curl -fsSL "$node_dist_url/SHASUMS256.txt" -o "$work_dir/SHASUMS256.txt"
  (
    cd "$work_dir"
    grep "  $node_archive\$" SHASUMS256.txt | sha256sum -c -
  )
  rm -rf "$RAYLINK_NODE_ROOT/node"
  mkdir -p "$RAYLINK_NODE_ROOT/node"
  tar -xJf "$work_dir/$node_archive" -C "$RAYLINK_NODE_ROOT/node" --strip-components=1
fi

curl -fsSL "$RAYLINK_SERVER/node/raylink-node.mjs" -o "$RAYLINK_NODE_ROOT/raylink-node.mjs"
chmod 0755 "$RAYLINK_NODE_ROOT/raylink-node.mjs"

installed_sing_box_version=""
if command -v sing-box >/dev/null 2>&1; then
  installed_sing_box_version="$(sing-box version 2>/dev/null | awk 'NR == 1 { print $3 }')"
fi
case "$installed_sing_box_version" in
  1.13.*) ;;
  *) curl -fsSL https://sing-box.app/install.sh | sh -s -- --version "$SING_BOX_VERSION" ;;
esac
sing_box_bin="$(command -v sing-box)"
actual_sing_box_version="$("$sing_box_bin" version 2>/dev/null | awk 'NR == 1 { print $3 }')"
case "$actual_sing_box_version" in
  1.13.*) ;;
  *) fail "sing-box 版本不兼容：要求 1.13.x，实际 ${actual_sing_box_version:-未知}" ;;
esac

# The official package can enable its own runtime unit. RayLink owns the
# configuration lifecycle, so keep exactly one sing-box service active.
if systemctl list-unit-files sing-box.service >/dev/null 2>&1; then
  if systemctl is-active --quiet sing-box.service; then
    fail "官方安装过程启动了 sing-box.service；为避免服务冲突，已停止后续接管，请检查现有配置"
  fi
  systemctl disable sing-box.service >/dev/null 2>&1 || true
fi

{
  printf 'RAYLINK_SERVER=%s\n' "$RAYLINK_SERVER"
  printf 'RAYLINK_ENROLL_TOKEN=%s\n' "$RAYLINK_ENROLL_TOKEN"
  printf 'RAYLINK_NODE_STATE=/etc/raylink-node/node.json\n'
  printf 'RAYLINK_NODE_DATA=/var/lib/raylink-node/sing-box\n'
  printf 'RAYLINK_RUNTIME_MODE=systemd\n'
  printf 'SING_BOX_BIN=%s\n' "$sing_box_bin"
  printf 'SING_BOX_SYSTEMD_UNIT=raylink-sing-box.service\n'
} > /etc/raylink-node/node.env
chmod 0600 /etc/raylink-node/node.env

cat > /etc/systemd/system/raylink-sing-box.service <<EOF
[Unit]
Description=RayLink managed sing-box runtime
After=network-online.target
Wants=network-online.target
ConditionPathExists=/var/lib/raylink-node/sing-box/config.json

[Service]
Type=simple
ExecStart=$sing_box_bin run -c /var/lib/raylink-node/sing-box/config.json
Restart=on-failure
RestartSec=3
LimitNOFILE=1048576
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/raylink-node/sing-box

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/raylink-node.service <<EOF
[Unit]
Description=RayLink Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/raylink-node/node.env
ExecStart=$RAYLINK_NODE_ROOT/node/bin/node $RAYLINK_NODE_ROOT/raylink-node.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/etc/raylink-node /var/lib/raylink-node

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable raylink-sing-box.service
systemctl enable --now raylink-node.service

printf '\nRayLink Node 已安装并启动。\n'
printf '节点状态：systemctl status raylink-node --no-pager\n'
printf '节点日志：journalctl -u raylink-node -f\n'
