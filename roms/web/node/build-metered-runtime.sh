#!/usr/bin/env bash
set -euo pipefail

SING_BOX_VERSION="${1:-}"
OUTPUT_PATH="${2:-/usr/local/bin/raylink-sing-box}"
script_directory="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ "$script_directory" = "/opt/raylink-node" ]; then
  default_build_root=/opt/raylink-node
else
  default_build_root=/var/lib/raylink/toolchains
fi
RAYLINK_NODE_ROOT="${RAYLINK_NODE_ROOT:-$default_build_root}"
GO_VERSION="${GO_VERSION:-1.24.7}"
SING_BOX_BUILD_TAGS="${SING_BOX_BUILD_TAGS:-with_gvisor,with_quic,with_dhcp,with_wireguard,with_utls,with_acme,with_clash_api,with_tailscale,with_ccm,with_ocm,with_naive_outbound,with_v2ray_api,with_purego,badlinkname,tfogo_checklinkname0}"
SING_BOX_LDFLAGS="${SING_BOX_LDFLAGS:--X internal/godebug.defaultGODEBUG=multipathtcp=0 -checklinkname=0}"

fail() {
  printf 'RayLink 计量版 Runtime 构建失败：%s\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || fail "必须以 root 运行"
printf '%s' "$SING_BOX_VERSION" | grep -Eq '^1\.13\.[0-9]+$' || fail "只允许构建 sing-box 1.13.x"
case "$SING_BOX_VERSION" in
  1.13.14) expected_module_sum='h1:p9/eqwilCgzyR/DpKM8hq7ppvzPIq1QMLgZWT3Cbg10=' ;;
  *) fail "该版本尚未进入 RayLink 审批清单，缺少源码模块校验值" ;;
esac
printf '%s' "$OUTPUT_PATH" | grep -Eq '^/[A-Za-z0-9_./-]+$' || fail "输出路径无效"
command -v curl >/dev/null 2>&1 || fail "需要 curl"
command -v tar >/dev/null 2>&1 || fail "需要 tar"
command -v sha256sum >/dev/null 2>&1 || fail "需要 sha256sum"

case "$(uname -m)" in
  x86_64|amd64) go_arch="amd64" ;;
  aarch64|arm64) go_arch="arm64" ;;
  *) fail "不支持的 CPU 架构：$(uname -m)" ;;
esac

go_root="$RAYLINK_NODE_ROOT/go"
go_binary="$go_root/bin/go"
if [ ! -x "$go_binary" ] || ! "$go_binary" version | grep -q "go${GO_VERSION}"; then
  archive="go${GO_VERSION}.linux-${go_arch}.tar.gz"
  download_dir="$(mktemp -d)"
  trap 'rm -rf "$download_dir"' EXIT
  curl -fsSL "https://go.dev/dl/${archive}" -o "$download_dir/$archive"
  curl -fsSL "https://go.dev/dl/${archive}.sha256" -o "$download_dir/$archive.sha256"
  expected_sha256="$(tr -d '[:space:]' < "$download_dir/$archive.sha256")"
  printf '%s  %s\n' "$expected_sha256" "$download_dir/$archive" | sha256sum -c -
  rm -rf "$go_root"
  install -d -m 0755 "$go_root"
  tar -xzf "$download_dir/$archive" -C "$go_root" --strip-components=1
fi

build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir" "${download_dir:-}"' EXIT
install -d -m 0700 "$RAYLINK_NODE_ROOT/gopath" "$RAYLINK_NODE_ROOT/gocache"
module_metadata="$(
  GOPATH="$RAYLINK_NODE_ROOT/gopath" \
  GOCACHE="$RAYLINK_NODE_ROOT/gocache" \
  GOSUMDB=sum.golang.org \
  "$go_binary" mod download -json "github.com/sagernet/sing-box@v${SING_BOX_VERSION}"
)"
actual_module_sum="$(printf '%s\n' "$module_metadata" | sed -n 's/^[[:space:]]*"Sum": "\\([^"]*\\)",[[:space:]]*$/\\1/p')"
[ "$actual_module_sum" = "$expected_module_sum" ] \
  || fail "sing-box 源码模块校验失败"
GOBIN="$build_dir" \
GOPATH="$RAYLINK_NODE_ROOT/gopath" \
GOCACHE="$RAYLINK_NODE_ROOT/gocache" \
GOSUMDB=sum.golang.org \
CGO_ENABLED=0 "$go_binary" install \
  -trimpath \
  -tags "$SING_BOX_BUILD_TAGS" \
  -ldflags "$SING_BOX_LDFLAGS" \
  "github.com/sagernet/sing-box/cmd/sing-box@v${SING_BOX_VERSION}"

candidate="${OUTPUT_PATH}.candidate"
install -m 0755 "$build_dir/sing-box" "$candidate"
"$candidate" version | grep -q "sing-box version ${SING_BOX_VERSION}" \
  || fail "构建版本校验失败"
"$candidate" version | grep -q "with_v2ray_api" \
  || fail "构建结果缺少 with_v2ray_api"
mv -f "$candidate" "$OUTPUT_PATH"
printf 'RayLink 计量版 sing-box %s 已安装到 %s\n' "$SING_BOX_VERSION" "$OUTPUT_PATH"
