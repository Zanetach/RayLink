# RayLink 正式版：sing-box 1.13.x 官方能力与生产落地边界

调研日期：2026-07-26

目标版本：sing-box 1.13.x

证据范围：仅使用 sing-box 官方文档、SagerNet 官方 GitHub 仓库、官方 Release 与官方安装文档。

## 结论摘要

1. **RayLink 当前固定的 `1.13.14` 不是已发布的官方版本。** 截至调研日，官方最新稳定版是 [`v1.13.12`](https://github.com/SagerNet/sing-box/releases/tag/v1.13.12)。正式版必须将安装版本、协议源码链接和兼容性检查统一固定为 `1.13.12`，否则一键安装会失败。
2. **1.13.12 源码实际注册 17 类 inbound，但只有 13 类适合作为界面中的“对外代理协议”。** `direct`、`tun`、`redirect`、`tproxy` 是本地接入或透明代理能力，不应和 VLESS、Trojan 等服务协议混为一谈。
3. **不能把当前官网导航中出现的所有类型都当成 1.13 能力。** `snell` inbound/outbound、`bridge` outbound、`cloudflared` inbound 是 1.14 新能力，不属于 1.13.12。1.13 已移除 WireGuard outbound，必须使用 WireGuard endpoint。
4. **国内直连、境外代理应在客户端配置中实现。** 推荐用 TUN 捕获系统流量，以 `sniff`、`hijack-dns`、远程 rule-set、`direct` 与代理 selector/urltest 组合实现。只下发一个 VLESS/Trojan 节点链接无法自动获得完整智能路由和 DNS 防泄漏能力。
5. **远程 rule-set 原生支持定时更新和缓存。** 1.13 使用 `download_detour` 指定规则下载链路，`update_interval` 默认 `1d`；启用 `experimental.cache_file.enabled` 后可缓存远程规则。1.14 才引入 `http_client`，不能提前生成到 1.13 配置中。
6. **官方普通安装包没有可直接用于“按用户计量”的 API。** V2Ray API 可以统计指定 inbound、outbound、user 的上下行字节，但默认 build tags 不包含 `with_v2ray_api`，且源码中的计数器仅在内存中。正式版若需要用户流量配额，必须采用自建官方源码构建物，并由 RayLink Node 轮询、持久化增量；不能把 sing-box 当成账单数据库。
7. **节点 CPU、内存、网络和 systemd 服务状态不应依赖 sing-box 协议 API。** 应由 RayLink Node 从操作系统采集并随心跳上报；sing-box API 只作为进程内部连接/流量的补充数据源。

## 1. 版本基线与协议能力

### 1.1 正式版基线

官方 Release 当前稳定版本为 [`v1.13.12`](https://github.com/SagerNet/sing-box/releases/tag/v1.13.12)。RayLink 正式版应：

- 固定安装 `1.13.12`，而不是不存在的 `1.13.14`；
- 所有 schema、字段校验和协议表以 [`v1.13.12` 源码标签](https://github.com/SagerNet/sing-box/tree/v1.13.12)为准；
- 节点注册时上报 `sing-box version` 输出中的版本、平台、架构和 build tags；
- 控制台只允许发布该节点实际 build tags 支持的功能；
- 升级到 1.14 必须作为独立兼容性版本，而不是在 1.13 schema 中混用字段。

### 1.2 1.13.12 inbound

以下清单来自 [`v1.13.12/include/registry.go`](https://github.com/SagerNet/sing-box/blob/v1.13.12/include/registry.go) 的真实注册逻辑。

| 分类 | inbound | RayLink 界面定位 | 主要限制 |
|---|---|---|---|
| 对外代理 | `socks` | 可选协议 | 通常用于受控内网，不建议直接暴露公网 |
| 对外代理 | `http` | 可选协议 | 同上 |
| 对外代理 | `mixed` | 可选协议 | SOCKS/HTTP 混合入口，偏本地或内网用途 |
| 对外代理 | `shadowsocks` | 可选协议 | 支持多用户配置 |
| 对外代理 | `vmess` | 可选协议 | 可用，但正式版应优先提供更现代的推荐模板 |
| 对外代理 | `trojan` | 推荐协议 | 需要正确 TLS 证书与域名配置 |
| 对外代理 | `naive` | 推荐协议 | HTTP/2 基础模式可用；QUIC 模式依赖 `with_quic` |
| 对外代理 | `shadowtls` | 高级协议 | 需要额外握手/下游配置 |
| 对外代理 | `vless` | 推荐协议 | 支持 TLS/Reality/V2Ray transport 等组合 |
| 对外代理 | `anytls` | 推荐协议 | 1.12 起支持；需要 TLS |
| 对外代理 | `hysteria` | 高级协议 | 依赖 `with_quic` |
| 对外代理 | `tuic` | 高级协议 | 依赖 `with_quic` |
| 对外代理 | `hysteria2` | 推荐协议 | 依赖 `with_quic` |
| 系统接入 | `direct` | 不作为用户协议 | 原始目标/转发类入口 |
| 系统接入 | `tun` | 客户端智能路由基础 | gVisor 栈依赖 `with_gvisor`；平台权限不同 |
| 系统接入 | `redirect` | Linux 高级设置 | 防火墙重定向场景 |
| 系统接入 | `tproxy` | Linux 高级设置 | Linux TProxy 场景 |

因此 RayLink 的“协议创建”页面不应简单展示 17 个等价选项。生产界面建议分为：

- **推荐模板**：VLESS + Reality、Trojan + TLS、Hysteria2、AnyTLS、Naive；
- **高级模板**：Shadowsocks、VMess、ShadowTLS、TUIC、Hysteria、SOCKS、HTTP、Mixed；
- **系统接入**：TUN、Redirect、TProxy，只出现在客户端/路由高级设置。

官方 inbound 总览可用于字段导航，但因官网已同步展示 1.14 类型，1.13 判定仍应以固定源码标签为准：[Inbound 文档](https://sing-box.sagernet.org/configuration/inbound/)。

### 1.3 1.13.12 outbound 与 endpoint

[`v1.13.12/include/registry.go`](https://github.com/SagerNet/sing-box/blob/v1.13.12/include/registry.go) 注册的核心 outbound 包括：

- 直连/策略：`direct`、`selector`、`urltest`；
- 上游代理：`socks`、`http`、`shadowsocks`、`vmess`、`trojan`、`naive`、`shadowtls`、`vless`、`anytls`、`hysteria`、`tuic`、`hysteria2`、`tor`、`ssh`；
- 源码仍注册了 `block` 兼容实现，但官方弃用清单要求迁移到 `reject` rule action，RayLink 不应再生成 `block` outbound；
- `dns` outbound 在 1.13 源码解析时直接报错，应使用 `hijack-dns` rule action；
- WireGuard outbound 已移除，应改用 WireGuard endpoint。

1.13 不应出现的 1.14 类型：

- [`snell` inbound](https://sing-box.sagernet.org/configuration/inbound/snell/)：1.14 起；
- [`bridge` outbound](https://sing-box.sagernet.org/configuration/outbound/bridge/)：1.14 起；
- [`cloudflared` inbound](https://sing-box.sagernet.org/configuration/inbound/cloudflared/)：1.14 起。

### 1.4 build tags 与平台限制

官方构建能力说明见 [Build from source](https://sing-box.sagernet.org/installation/build-from-source/)，1.13.12 官方标签文件见：

- [`release/DEFAULT_BUILD_TAGS`](https://github.com/SagerNet/sing-box/blob/v1.13.12/release/DEFAULT_BUILD_TAGS)
- [`release/DEFAULT_BUILD_TAGS_OTHERS`](https://github.com/SagerNet/sing-box/blob/v1.13.12/release/DEFAULT_BUILD_TAGS_OTHERS)
- [`release/DEFAULT_BUILD_TAGS_WINDOWS`](https://github.com/SagerNet/sing-box/blob/v1.13.12/release/DEFAULT_BUILD_TAGS_WINDOWS)

正式版必须识别以下标签：

| build tag | 影响 |
|---|---|
| `with_quic` | Hysteria/TUIC/Hysteria2 inbound/outbound、QUIC/HTTP3 DNS、V2Ray QUIC transport、Naive QUIC |
| `with_gvisor` | TUN 的 gVisor 栈等能力 |
| `with_wireguard` | 1.13 的 WireGuard endpoint，不代表已移除的 WireGuard outbound |
| `with_utls` | 出站 uTLS；官方现已明确“不推荐”将 uTLS 作为抗识别方案 |
| `with_acme` | TLS 证书 ACME 签发 |
| `with_clash_api` | Clash API，亦是控制 selector 的接口 |
| `with_v2ray_api` | V2Ray gRPC 统计 API；**官方默认标签不包含** |
| `with_naive_outbound` | Naive outbound；Linux/Windows 还受架构与 Cronet 库约束 |

Naive outbound 的具体 Linux/Windows/Apple/Android 限制见 [Naive outbound 官方文档](https://sing-box.sagernet.org/configuration/outbound/naive/)。控制台不能只根据版本显示协议，必须同时根据 `platform`、`architecture`、`buildTags` 判断可用性。

Reality 是 TLS 子配置，不是单独 inbound 类型，官方字段见 [TLS Reality Fields](https://sing-box.sagernet.org/configuration/shared/tls/#reality-fields)。界面应呈现为“VLESS + Reality”等组合模板。

## 2. 智能路由的正确落点

### 2.1 服务器与客户端职责

服务器负责：

- 监听 VLESS/Trojan/Hysteria2 等 inbound；
- 认证用户；
- 将收到的连接路由到 `direct`；
- 暴露最小必要端口并维护 TLS/Reality 配置。

客户端订阅配置负责：

- 通过 TUN 捕获系统 TCP/UDP 流量；
- 劫持系统 DNS；
- 识别域名/协议；
- 国内私网和国内网站直连；
- 其他流量走代理；
- 多节点自动测速或人工选择。

官方客户端文档明确指出，普通系统代理主要覆盖 HTTP/TCP，UDP 和不遵守系统代理的应用可能泄漏；TUN 是完整透明代理的合理实现方式：[Client / Virtual Interface](https://sing-box.sagernet.org/manual/proxy/client/#virtual-interface)。

### 2.2 推荐 1.13 路由顺序

RayLink 生成的客户端配置至少应遵守下列规则顺序：

1. `action: sniff`；
2. 对 DNS 协议或 53 端口执行 `action: hijack-dns`；
3. `ip_is_private: true` 走 `direct`；
4. 可选：拒绝应用自行发出的 DoT（TCP 853）、QUIC/DoQ（UDP 443）和 STUN，减少绕过内部 DNS/代理的泄漏面；
5. `geosite-geolocation-cn` 走 `direct`；
6. `geoip-cn` 与非境外域名条件组合后走 `direct`；
7. `route.final` 指向 `selector` 或 `urltest` 代理组。

官方提供了面向中国用户的 TUN 与 traffic bypass 示例，包括 DNS 劫持、私网直连、国内 rule-set 直连以及防 DNS 泄漏规则：[Traffic bypass usage for Chinese users](https://sing-box.sagernet.org/manual/proxy/client/#traffic-bypass-usage-for-chinese-users)。

### 2.3 GeoIP/Geosite 迁移现状

1.13 **不得再使用旧 `route.geoip`、`route.geosite` 数据库字段，也不得在 rule 中使用 `geoip`/`geosite` 匹配项**：

- GeoIP 与 Geosite 在 1.8 被弃用，并于 1.12 移除；
- 替代方案是 `route.rule_set` + 规则中的 `rule_set`；
- 官方迁移命令支持将自定义 GeoIP/Geosite 转为 rule-set。

来源：

- [Deprecated: GeoIP / Geosite](https://sing-box.sagernet.org/deprecated/#geoip)
- [Migration: GeoIP to rule-sets](https://sing-box.sagernet.org/migration/#migrate-geoip-to-rule-sets)
- [Migration: Geosite to rule-sets](https://sing-box.sagernet.org/migration/#migrate-geosite-to-rule-sets)

官方示例使用：

- `https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-geolocation-cn.srs`
- `https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-geolocation-!cn.srs`
- `https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs`

注意：旧 Geosite 被移除的原因之一正是规则维护和准确性问题。RayLink 正式版不能宣传“任意网站 100% 自动准确分流”；应允许管理员添加域名后缀、IP CIDR 和自定义 rule-set 作为覆盖规则。

## 3. DNS 分流与防泄漏

### 3.1 推荐 DNS 架构

客户端配置应包含两个明确的 DNS 上游：

- `dns-local`：面向国内域名，直接访问国内 UDP/DoH 服务；
- `dns-remote`：面向其他域名，使用 DoH/DoT，并通过代理 outbound 连接。

DNS rules：

- `geosite-geolocation-cn` → `dns-local`；
- 其余 → `dns-remote`。

路由 rules 同时劫持 53 端口 DNS，并按需要拒绝客户端应用绕过配置发起的 DoT/DoQ/STUN。这样境外域名不会先泄漏到本地 DNS，再决定是否走代理。

1.12 起 DNS server 已使用对象格式；DoH 的 `type: "https"`、`server`、`server_port`、`path`、TLS 和 Dial Fields 见 [DNS over HTTPS](https://sing-box.sagernet.org/configuration/dns/server/https/)。本地解析器见 [Local DNS server](https://sing-box.sagernet.org/configuration/dns/server/local/)。

### 3.2 远程 rule-set 更新

1.13 的远程 rule-set：

- `type: "remote"`；
- `format: "binary"` 或 `source`；
- `url`；
- `update_interval`，默认 `1d`；
- `download_detour` 指定通过哪个 outbound 下载；
- 启用 `experimental.cache_file.enabled` 后缓存远程规则。

来源：[Rule-set](https://sing-box.sagernet.org/configuration/rule-set/)。

1.14 才新增 `http_client` 和 `initial_path`。因此 RayLink 1.13 配置生成器：

- 可以使用 `download_detour: "proxy"` 获取在本地网络不可达的规则；
- 不得生成 `http_client`、`route.default_http_client` 或 `initial_path`；
- 应保存 rule-set 下载状态与最后更新时间；
- 应支持管理员立即刷新和回退到已缓存规则。

生产推论：为避免首次启动依赖 GitHub Raw，RayLink 可以由控制面托管经过版本固定与校验的 `.srs` 文件，再由客户端订阅指向 RayLink HTTPS 地址；这属于 RayLink 的交付能力，不是 sing-box 内建规则源。

## 4. selector 与 URLTest

客户端多节点能力可直接使用：

- [`selector`](https://sing-box.sagernet.org/configuration/outbound/selector/)：人工选择 outbound，只有 Clash API 能控制；支持默认项和切换时中断已有连接；
- [`urltest`](https://sing-box.sagernet.org/configuration/outbound/urltest/)：自动测试一组 outbound；默认测速 URL 为 `https://www.gstatic.com/generate_204`，默认间隔 `3m`、容差 `50ms`、闲置超时 `30m`。

推荐订阅结构：

- 每个“节点 × 协议”生成唯一 outbound；
- `urltest` 组合健康节点，形成“自动选择”；
- `selector` 包含“自动选择”和所有手动节点；
- `route.final` 指向 selector；
- Clash API 仅监听本机，并设置 secret；官方文档明确要求监听 `0.0.0.0` 时必须设置 secret：[Clash API](https://sing-box.sagernet.org/configuration/experimental/clash-api/)。

这些能力属于客户端配置。服务端不能用一个 selector 自动替换不同 inbound 的监听和证书配置。

## 5. 安装、校验与 systemd

官方支持三种 Linux 安装方式：

- APT/DNF 官方仓库；
- 官方脚本：`curl -fsSL https://sing-box.app/install.sh | sh`；
- 固定版本：`curl -fsSL https://sing-box.app/install.sh | sh -s -- --version <version>`。

来源：[Package Manager / Manual Installation](https://sing-box.sagernet.org/installation/package-manager/#manual-installation)。

RayLink 正式安装流程应是：

1. 检测 Linux、架构、systemd、端口与权限；
2. 用官方脚本固定安装 `1.13.12`；
3. 运行 `sing-box version`，核对版本、平台、架构和 build tags；
4. 生成配置到临时文件；
5. 执行 `sing-box check -c <临时文件>`；
6. 校验成功后原子替换正式配置；
7. `systemctl restart sing-box`；
8. 检查 systemd active 状态、监听端口和最近日志；
9. 失败时恢复上一版本配置并重启；
10. 将版本、配置 checksum、服务状态和错误摘要上报控制面。

官方配置校验命令见 [Configuration / Check](https://sing-box.sagernet.org/configuration/#check)。官方包通常已带 systemd 服务，启停和日志命令见 [Service Management](https://sing-box.sagernet.org/installation/package-manager/#service-management)。

RayLink 不应在未经 `sing-box check` 的情况下直接覆盖配置；也不应同时维护两个互相竞争的 `sing-box.service`。

## 6. 运行指标与用户流量统计

### 6.1 节点运行指标

总览页面需要的节点 CPU、内存、网络与服务状态，应由 RayLink Node 上报：

- CPU：总使用率、负载、核心数；
- 内存：已用/总量；
- 网络：累计 RX/TX、采样区间速率；
- 服务：RayLink Node、sing-box 的 active/sub 状态、PID、启动时间、重启次数；
- sing-box：版本、build tags、配置 checksum、监听端口、最后发布版本；
- 心跳：最后上报时间、延迟、连续失败次数。

这是操作系统可观测性，不是 sing-box 1.13 官方配置 API 的职责。

### 6.2 官方按用户统计能力

[`experimental.v2ray_api`](https://sing-box.sagernet.org/configuration/experimental/v2ray-api/) 可配置：

- `stats.inbounds`；
- `stats.outbounds`；
- `stats.users`。

但存在三个关键生产边界：

1. 官方文档明确写明 V2Ray API **默认不包含**，需要 `with_v2ray_api`；
2. 1.13.12 官方默认 build tag 文件不含 `with_v2ray_api`；
3. [`v1.13.12/experimental/v2rayapi/stats.go`](https://github.com/SagerNet/sing-box/blob/v1.13.12/experimental/v2rayapi/stats.go) 使用进程内原子计数器，提供 GetStats/QueryStats 和 reset；进程重启后不构成持久账本。

因此正式版有两种可行路线：

- **基础正式版**：使用官方二进制；展示节点级网络趋势，不承诺准确的按用户流量配额；
- **计量正式版**：从官方 `v1.13.12` 源码构建包含 `with_v2ray_api` 的 RayLink 固定二进制，V2Ray API 只监听 `127.0.0.1`；RayLink Node 周期性读取并把增量持久化到控制面数据库。

即使采用第二种路线，RayLink 仍需处理：

- sing-box 重启与计数器归零；
- 节点离线期间的数据采样；
- 同一用户跨节点汇总；
- 重复采集幂等；
- 统计值与订阅配额的事务性扣减；
- 达到配额后重新编译并发布用户授权。

sing-box 官方没有提供完整的用户、订阅、到期、配额、账单和历史数据库 API，这些都必须由 RayLink 实现。

## 7. 1.13 已移除或禁止生成的配置

正式 schema 必须明确拒绝：

| 旧配置 | 1.13 状态 | 替代 |
|---|---|---|
| `route.geoip`、rule `geoip`/`source_geoip` | 1.12 已移除 | `rule_set` |
| `route.geosite`、rule `geosite` | 1.12 已移除 | `rule_set` |
| `outbound.type: "dns"` | 1.13 已移除 | `action: "hijack-dns"` |
| `outbound.type: "block"` | 官方弃用清单标注 1.13 移除 | `action: "reject"` |
| inbound 的 `sniff`、`sniff_override_destination`、`sniff_timeout`、`domain_strategy` 等旧字段 | 1.13 已移除 | route `sniff` / `resolve` actions |
| direct outbound 的 `override_address`、`override_port` | 1.13 已移除 | route / route-options action |
| WireGuard outbound | 1.13 已移除 | WireGuard endpoint |
| TUN `gso` | 1.13 已移除 | 不生成 |
| TUN `inet4_address`、`inet6_address` 等分离字段 | 1.12 已移除 | 合并后的 `address`、`route_address`、`route_exclude_address` |
| `rule_set_ipcidr_match_source` | 1.11 已移除 | `rule_set_ip_cidr_match_source` |
| ECH `pq_signature_schemes_enabled`、`dynamic_record_sizing_disabled` | 1.13 已移除 | 不生成 |

完整官方依据：[Deprecated Feature List](https://sing-box.sagernet.org/deprecated/) 与 [Migration](https://sing-box.sagernet.org/migration/)。

## 8. RayLink 正式版验收门槛

在宣称“可正式发布”之前，应至少通过：

1. 一键安装在 Ubuntu/Debian 两个干净 VPS 镜像上成功，并确认实际安装 `1.13.12`；
2. 安装后能上报真实版本、build tags、CPU、内存、网络和 systemd 状态；
3. 每种界面可创建协议均由真实 `sing-box check` 验证；
4. 至少完成 VLESS + Reality、Trojan + TLS、Hysteria2 三条端到端连接；
5. 用户创建、禁用、到期后，服务端授权与订阅配置同步生效；
6. 客户端 TUN 能完成国内直连、境外代理、DNS 劫持和私网直连；
7. OpenAI、Google、X/Twitter、Facebook、YouTube 只能作为发布前连通性探测目标，不能写成永久可用承诺；结果受节点 IP 信誉、目标服务地区政策、网络封锁和账户条件影响；
8. remote rule-set 首次下载、缓存、更新失败和回退均有可观察状态；
9. selector 手动切换和 urltest 自动选择可用；
10. 配置发布失败能自动回滚，sing-box 服务不会因错误配置长期退出；
11. 若启用按用户流量统计，验证重启、跨节点、重复采集与配额封禁的准确性；
12. 管理 API、Clash API、V2Ray API 均不得无认证暴露公网。

## 9. 对 RayLink 当前设计的直接建议

- 立即将 `1.13.14` 全部改为官方存在的 `1.13.12`。
- 协议目录从“静态全支持”改为“版本基线 + 节点 build tags/platform 动态可用”。
- 将协议页分为推荐模板、高级协议、系统接入三层，避免让管理员直接面对 sing-box 全部字段。
- 订阅生成器必须生成完整客户端配置，而不只是节点链接；智能路由和 DNS 策略是客户端配置的一部分。
- 节点总览指标由 RayLink Node 采集；sing-box V2Ray API 仅用于可选的按用户字节统计。
- 若正式版承诺用户流量配额，应切换为受控自建 `with_v2ray_api` 构建物，并建立持久化采集链路。
- 正式发布前必须执行上述端到端验收，不能仅以界面可操作和 `sing-box check` 通过作为“VPN 可用”的充分条件。
