# RayLink

RayLink 是一个面向多用户、多 VPS 场景的 sing-box 控制面。它把管理端、用户中心、SQLite 数据库、本机 Runtime 和远程 RayLink Node 发布串成一条可运行链路：

```text
管理员 → 用户权益/主机配置 → SQLite → 配置编译 → sing-box check
      → 本机原子替换 / 远程任务 → Runtime 重启

用户 → 用户中心登录 → 权益校验 → 独立运行凭据 → 多节点 sing-box 客户端配置
```

## 已实现

- 管理员 Cookie 会话登录
- 每个用户独立拥有流量、到期、节点范围和客户端能力
- 用户启停、到期时间、用户中心激活与密码重置
- 登录密码和 sing-box 运行凭据完全分离
- 本机 Runtime 与多台远程 VPS 管理
- 一次性节点接入令牌、节点认证、心跳和运行版本上报
- 节点 CPU、内存、网络速率和 sing-box 服务状态上报
- RayLink Node 一键安装、systemd 自启动和远程配置任务
- 旧版 Node 继续上报心跳但不会领取新任务；升级到 0.4.0 后自动恢复配置与 Runtime 升级任务
- 每 6 小时检查官方 GitHub 最新稳定版，在系统页提示本机和远程主机升级
- Linux 在线升级会备份二进制、用新版本校验当前配置、重启并执行连续健康检查；任一步失败自动恢复旧版本和原服务状态
- 升级前明确提示目标 Runtime 会短暂重启；远程失败、回滚版本和错误原因保留在主机详情
- 只自动升级 RayLink 已验证的 `1.13.x` 稳定版；发现不兼容的新主版本时只提示，不会强制升级
- 每台远程主机按区域独立编译用户配置
- SQLite 持久化
- 读取 `sing-box version` 的版本、平台、架构和 build tags
- macOS Homebrew / Linux 官方脚本一键安装
- sing-box v1.13.12 的 17 种 inbound 能力目录
- Shadowsocks、VMess、VLESS、Trojan、Naive、AnyTLS、Hysteria、TUIC、Hysteria2、SOCKS、HTTP、Mixed 图形化配置
- Reality 密钥生成、证书 TLS、HTTP/WS/QUIC/gRPC/HTTPUpgrade Transport
- ShadowTLS、Direct、TUN、Redirect、TProxy 高级 JSON 配置
- 多协议、多主机用户凭据编译和统一选择器客户端配置
- 过期、停用用户自动排除
- `sing-box check` 校验、SHA-256 快照、发布人审计、`0600` 原子写入、失败恢复和历史版本一键回滚
- dry-run 与 systemd 两种发布模式
- 独立用户中心（`/portal/`）按当前用户权益生成、复制和重置专属订阅地址
- 订阅密钥只保存哈希；重置后旧地址立即失效
- 订阅响应使用私有 `no-cache` + ETag，每次更新都重新验证，内容不变时返回 304
- TUN 系统代理、DNS 劫持、国内地址与域名直连、境外自动代理
- 多协议/多节点 URLTest 自动测速、Selector 手动选择和故障切换
- 固定提交与 SHA-256 的 SagerNet GeoIP/Geosite 规则集由控制面下载、校验并托管
- 官方规则集尚未准备时自动下发内置中国域名/DNS 基线规则，客户端仍可启动
- 用户停用、到期、超额或权益变更后自动重编译；发布失败保留待重试状态并周期重试
- 远程撤权任务使用最高优先级、指数退避和持久重试，主机页显示“撤权待同步”
- 同源 Web 前端和 JSON API

## 当前边界

当前版本已经完成控制面到多台 Runtime 的基础生产链路。以下能力尚未实现：

- 实时流量采集和账单；当数据库中的已用量达到用户额度时，配置发布和下载会排除该用户，但用量仍需外部采集器更新
- 订阅二维码
- TLS 证书与私钥安全分发到远程主机
- 节点分批灰度和维护窗口（单节点在线升级会有一次服务重启；多节点客户端可自动故障切换）
- 完整的 outbound、endpoint、DNS 和路由规则图形化编辑器
- 同一种协议的多个独立 inbound 实例
- Mihomo 订阅转换
- 邮件邀请、忘记密码、双因素认证和细粒度 RBAC

界面中未接通的客户端格式会明确显示“即将支持”，不会生成伪订阅。

## 客户端智能路由

RayLink 生成的是完整 sing-box 客户端配置，不是在控制面里自行转发流量。客户端启动后由
sing-box 内置路由引擎执行以下顺序：

1. TUN 接管系统流量，并嗅探连接协议。
2. DNS 请求由 sing-box 劫持；国内规则使用本地 DNS，其他域名使用代理侧加密 DNS。
3. 私网地址、GeoIP CN 和 Geosite CN 直接连接。
4. 其他流量进入 `raylink-auto`，由 URLTest 在当前用户允许的全部协议和节点间自动选择。
5. 用户仍可在支持 Selector 的客户端中手动固定某个节点。

完整规则集来自 SagerNet 官方 `sing-geoip`、`sing-geosite` 仓库的固定提交，并在写入控制面缓存前
校验 SHA-256。客户端从 RayLink 同源 `/rule-sets/` 端点更新，不直接依赖 GitHub。控制面尚未取得
完整规则时，订阅使用内置 `.cn`、常用中国服务域名和国内 DNS 基线规则，保证首次启动；完整缓存
准备好后，下一次订阅更新自动切换。客户端仍使用 `cache_file` 保存已取得的规则。

两种配置均已通过正式基线 sing-box 1.13.12 和本机 sing-box 1.13.14 的 `sing-box check`。

用户订阅地址包含访问密钥，应当按密码保管。服务端只保存密钥哈希，因此地址仅在生成或重置时
显示；遗失后需要重置，旧客户端中的地址会立即失效。

## 本地运行

要求 Node.js 22.5+。安装 sing-box 后可执行真实语法校验；macOS 可使用官方 Homebrew 方式：

```bash
brew install sing-box
cp .env.example .env
npm start
```

默认打开 [http://127.0.0.1:4173](http://127.0.0.1:4173)。开发账号：

```text
用户名：admin
密码：Admin@2026
```

默认密码仅用于本机开发。`NODE_ENV=production` 时，RayLink 会拒绝使用该密码启动。

本项目不依赖 dotenv。启动时直接导出环境变量，或由 systemd 的 `EnvironmentFile` 注入：

```bash
RAYLINK_ADMIN_PASSWORD='replace-with-a-long-random-secret' \
RAYLINK_PROXY_HOST='node.example.com' \
SING_BOX_BIN='/opt/homebrew/bin/sing-box' \
npm start
```

## 验证

```bash
npm run check
sing-box check -c data/sing-box/config.json
```

测试覆盖管理 API、用户中心、配置编译、部署记录、真实发布适配器和失败回滚。

源码协议矩阵、build tag 和平台限制见
[docs/sing-box-protocol-support.md](docs/sing-box-protocol-support.md)。

## 生产部署

生产环境建议：

1. RayLink 仅监听 `127.0.0.1`。
2. 使用 Caddy 或 Nginx 提供 HTTPS。
3. 设置强随机管理员密码。
4. 将 `RAYLINK_DATA_DIR` 放在受限目录并纳入加密备份。
5. 先以 `dry-run` 发布并确认 `validation: sing-box`。
6. 再切换到 `systemd`，确保 sing-box 服务读取 RayLink 生成的配置路径。
7. 防火墙只开放 HTTPS 管理入口和实际代理端口。

添加第二台 VPS：

1. 打开“系统 → 主机 → 添加主机”。
2. 填写公网地址与区域，生成一次性安装命令。
3. 在 Linux VPS 上执行该命令。安装器会校验并安装 Node.js 22、安装 sing-box 1.13.12，并启动 `raylink-node.service`。
4. 等待主机状态变为“在线”，然后在配置工作台执行一次发布。

接入前若命令丢失，可在该主机详情中重新生成；旧令牌会立即失效。节点注册成功后不能通过此入口替换节点身份。
升级控制面后，如果已有主机显示“Node 待升级”，可打开主机详情复制升级命令；升级完成并重新上报服务遥测前，
该节点不会进入正式用户配置。

远程 VPS 必须能通过 HTTPS 访问 `RAYLINK_PUBLIC_ORIGIN`。节点凭据保存在
`/etc/raylink-node/node.json`（`0600`），受管 sing-box 配置位于
`/var/lib/raylink-node/sing-box/config.json`。

“一键安装”会在 macOS 上执行固定的 `brew install sing-box`，在 Linux 上通过
sing-box 官方 `https://sing-box.app/install.sh` 安装固定的 1.13.12。生产服务账户必须拥有对应的包管理权限；
安装命令由后端白名单固定，不接受浏览器提交任意 shell。
当前协议 schema 与 sing-box 1.13.x 绑定；检测到其他版本时会禁用协议保存，避免静默生成
不兼容配置。

可直接参考 [deploy/README.md](deploy/README.md) 和示例 systemd 单元。

## 关键环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `RAYLINK_HOST` | `127.0.0.1` | 控制面监听地址 |
| `RAYLINK_PORT` | `4173` | 控制面端口 |
| `RAYLINK_PUBLIC_ORIGIN` | 根据监听地址生成 | Cookie 与同源校验基准 |
| `RAYLINK_TRUST_PROXY` | `false` | 仅在受信任反向代理覆盖 `X-Forwarded-For` 时设为 `true` |
| `RAYLINK_ADMIN_USERNAME` | `admin` | 管理员用户名 |
| `RAYLINK_ADMIN_PASSWORD` | 仅开发默认值 | 生产必须修改 |
| `RAYLINK_DATA_DIR` | `./data` | SQLite 和 Runtime 配置目录 |
| `RAYLINK_PROXY_HOST` | Public Origin 主机名 | 初始对外代理域名 |
| `RAYLINK_PROXY_PORT` | `8388` | Shadowsocks 2022 端口 |
| `RAYLINK_RUNTIME_MODE` | `dry-run` | `dry-run` 或 `systemd` |
| `SING_BOX_BIN` | `sing-box` | sing-box 可执行文件 |
| `SING_BOX_SYSTEMD_UNIT` | `sing-box.service` | 被重启的 systemd 单元 |

## 数据与安全

- 管理员密码和用户中心密码使用 scrypt 哈希。
- 会话只保存哈希，浏览器 Cookie 为 `HttpOnly`、`SameSite=Strict`。
- 管理 API 不返回密码哈希或运行凭据。
- 远程节点接入令牌仅可使用一次；注册后只保存节点密钥的哈希。
- RayLink Node 发布前执行 `sing-box check`，原子替换失败时恢复上一份配置。
- 用户只会收到自己的运行凭据。
- 订阅密钥是 256 位随机值，服务端只保存 SHA-256 哈希；订阅响应禁止缓存并设置 `Referrer-Policy: no-referrer`。
- 反向代理访问日志应屏蔽 `/sub/` 路径中的密钥，或完全关闭该路径的 URI 日志。
- Runtime 完整配置包含所有有效用户凭据，必须限制文件读取权限并保护备份。

领域定义见 [CONTEXT.md](CONTEXT.md)，架构决策见 [docs/adr/](docs/adr/)。
