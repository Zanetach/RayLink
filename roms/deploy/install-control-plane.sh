#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'RayLink 安装失败：%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "请以 root 运行"
[ "$(uname -s)" = "Linux" ] || fail "当前一键安装仅支持 Linux"
command -v systemctl >/dev/null 2>&1 || fail "当前系统未使用 systemd"

install_root=/opt/raylink
data_root=/var/lib/raylink
config_root=/etc/raylink
node_root=/opt/raylink-nodejs
node_version="${RAYLINK_NODE_VERSION:-22.23.1}"
package_url="${RAYLINK_PACKAGE_URL:-}"
package_sha256="${RAYLINK_PACKAGE_SHA256:-}"
source_root="${RAYLINK_SOURCE_DIR:-}"
temporary_root="$(mktemp -d)"
trap 'rm -rf "$temporary_root"' EXIT

if [ -e "$install_root/package.json" ]; then
  fail "$install_root 已存在；升级请使用控制台在线升级，不要覆盖安装"
fi

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl nginx openssl tar xz-utils
else
  fail "当前版本仅自动安装 Debian/Ubuntu 依赖"
fi

case "$(uname -m)" in
  x86_64|amd64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) fail "不支持的 CPU 架构：$(uname -m)" ;;
esac

node_archive="node-v${node_version}-linux-${node_arch}.tar.xz"
curl -fsSL "https://nodejs.org/download/release/v${node_version}/SHASUMS256.txt" \
  -o "$temporary_root/SHASUMS256.txt"
curl -fsSL "https://nodejs.org/download/release/v${node_version}/${node_archive}" \
  -o "$temporary_root/$node_archive"
grep "  ${node_archive}\$" "$temporary_root/SHASUMS256.txt" \
  | (cd "$temporary_root" && sha256sum -c -)
install -d -m 0755 "$node_root"
tar -xJf "$temporary_root/$node_archive" -C "$node_root" --strip-components=1
"$node_root/bin/node" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 5)) process.exit(1);
' || fail "Node.js 版本必须不低于 22.5"

if [ -z "$source_root" ]; then
  script_directory="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
  if [ -n "$script_directory" ] && [ -f "$script_directory/../package.json" ]; then
    source_root="$(CDPATH= cd -- "$script_directory/.." && pwd)"
  elif [ -n "$package_url" ]; then
    [ -n "$package_sha256" ] || fail "远程安装必须设置 RAYLINK_PACKAGE_SHA256"
    curl -fsSL "$package_url" -o "$temporary_root/raylink.tar.gz"
    printf '%s  %s\n' "$package_sha256" "$temporary_root/raylink.tar.gz" | sha256sum -c -
    install -d -m 0755 "$temporary_root/package"
    tar -xzf "$temporary_root/raylink.tar.gz" -C "$temporary_root/package" --strip-components=1
    source_root="$temporary_root/package"
  else
    fail "请从发布包运行脚本，或设置 RAYLINK_PACKAGE_URL 与 RAYLINK_PACKAGE_SHA256"
  fi
fi

[ -f "$source_root/package.json" ] || fail "安装源缺少 package.json"
[ -f "$source_root/server/index.js" ] || fail "安装源缺少控制面程序"
[ -f "$source_root/web/node/build-metered-runtime.sh" ] || fail "安装源缺少 sing-box 构建器"

install -d -m 0755 "$install_root"
cp -a "$source_root/package.json" "$source_root/server" "$source_root/web" "$source_root/deploy" "$install_root/"
install -d -m 0700 "$data_root" "$config_root" "$config_root/tls"

"$install_root/web/node/build-metered-runtime.sh" \
  1.13.14 \
  /usr/local/bin/raylink-sing-box

public_ip="${RAYLINK_PUBLIC_IP:-}"
if [ -z "$public_ip" ]; then
  public_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
[ -n "$public_ip" ] || fail "无法检测服务器 IP，请设置 RAYLINK_PUBLIC_IP"
printf '%s' "$public_ip" | grep -Eq '^[0-9a-fA-F:.]+$' || fail "RAYLINK_PUBLIC_IP 格式不正确"

openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 825 \
  -subj "/CN=${public_ip}" \
  -addext "subjectAltName=IP:${public_ip}" \
  -keyout "$config_root/tls/control-plane.key" \
  -out "$config_root/tls/control-plane.crt"
chmod 0600 "$config_root/tls/control-plane.key"

setup_token="$(openssl rand -hex 24)"
setup_token_hash="$(
  printf '%s' "$setup_token" | "$node_root/bin/node" -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    process.stdout.write(createHash("sha256").update(readFileSync(0)).digest("base64url"));
  '
)"
setup_expires_at="$(
  "$node_root/bin/node" -e '
    process.stdout.write(new Date(Date.now() + 30 * 60 * 1000).toISOString());
  '
)"
bootstrap_password="$(openssl rand -base64 36 | tr -d '\n')"

umask 077
{
  printf '%s\n' \
    'NODE_ENV=production' \
    'RAYLINK_HOST=127.0.0.1' \
    'RAYLINK_PORT=4173' \
    "RAYLINK_PUBLIC_ORIGIN=https://${public_ip}" \
    'RAYLINK_TRUST_PROXY=true' \
    'RAYLINK_ADMIN_USERNAME=bootstrap-admin' \
    "RAYLINK_ADMIN_PASSWORD=${bootstrap_password}" \
    "RAYLINK_DATA_DIR=${data_root}" \
    "RAYLINK_PROXY_HOST=${public_ip}" \
    'RAYLINK_PROXY_PORT=8388' \
    'RAYLINK_RUNTIME_MODE=systemd' \
    'RAYLINK_USER_METERING=true' \
    'RAYLINK_SETUP_REQUIRED=true' \
    "RAYLINK_SETUP_TOKEN_HASH=${setup_token_hash}" \
    "RAYLINK_SETUP_TOKEN_EXPIRES_AT=${setup_expires_at}" \
    'SING_BOX_BIN=/usr/local/bin/raylink-sing-box' \
    'SING_BOX_SYSTEMD_UNIT=sing-box-raylink.service'
} > "$config_root/raylink.env"

cp "$install_root/deploy/raylink.service" /etc/systemd/system/raylink.service
cp "$install_root/deploy/sing-box-raylink.service" /etc/systemd/system/sing-box-raylink.service
cp "$install_root/deploy/nginx-first-run.conf.example" /etc/nginx/conf.d/raylink.conf
nginx -t
systemctl daemon-reload
systemctl enable --now nginx
systemctl enable --now raylink

printf '\nRayLink 已安装。\n'
printf '首次初始化地址（令牌 30 分钟有效）：\n'
printf 'https://%s/setup#token=%s\n\n' "$public_ip" "$setup_token"
printf '首次使用 IP 证书时浏览器会提示自签名证书；核对证书指纹后继续：\n'
openssl x509 -in "$config_root/tls/control-plane.crt" -noout -fingerprint -sha256
