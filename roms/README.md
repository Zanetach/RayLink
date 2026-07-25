# RayLink

RayLink 是一个面向单台服务器、多用户场景的 sing-box 控制面。它把管理端、用户中心、SQLite 数据库和 sing-box Runtime 发布串成一条可运行链路：

```text
管理员 → 用户/方案/主机配置 → SQLite → 配置编译 → sing-box check
      → 原子替换 → Runtime 重启

用户 → 用户中心登录 → 权益校验 → 独立运行凭据 → sing-box 客户端配置
```

## 已实现

- 管理员 Cookie 会话登录
- 用户与订阅方案分离建模，一个用户只能分配一个方案
- 用户启停、到期时间、用户中心激活与密码重置
- 登录密码和 sing-box 运行凭据完全分离
- 单机 Runtime 公网地址配置
- SQLite 持久化
- Shadowsocks 2022 多用户配置编译
- 过期、停用用户自动排除
- `sing-box check` 校验、SHA-256 快照、发布人审计、`0600` 原子写入、失败恢复和历史版本一键回滚
- dry-run 与 systemd 两种发布模式
- 独立用户中心（`/portal/`）按当前方案生成专属 sing-box 客户端 JSON
- 同源 Web 前端和 JSON API

## 当前边界

这是完整的单机纵向闭环，不是多节点商业面板。以下能力尚未实现：

- 实时流量采集和账单；当数据库中的已用量达到方案额度时，配置发布和下载会排除该用户，但用量仍需外部采集器更新
- 设备指纹与设备数强制限制
- 多 Runtime 节点编排和灰度发布
- VLESS/Reality、Hysteria2 等额外协议
- Mihomo 订阅转换
- 邮件邀请、忘记密码、双因素认证和细粒度 RBAC

界面中未接通的客户端格式会明确显示“即将支持”，不会生成伪订阅。

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

## 生产部署

生产环境建议：

1. RayLink 仅监听 `127.0.0.1`。
2. 使用 Caddy 或 Nginx 提供 HTTPS。
3. 设置强随机管理员密码。
4. 将 `RAYLINK_DATA_DIR` 放在受限目录并纳入加密备份。
5. 先以 `dry-run` 发布并确认 `validation: sing-box`。
6. 再切换到 `systemd`，确保 sing-box 服务读取 RayLink 生成的配置路径。
7. 防火墙只开放 HTTPS 管理入口和实际代理端口。

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
- 用户只会收到自己的运行凭据。
- Runtime 完整配置包含所有有效用户凭据，必须限制文件读取权限并保护备份。

领域定义见 [CONTEXT.md](CONTEXT.md)，架构决策见 [docs/adr/0001-single-host-control-plane.md](docs/adr/0001-single-host-control-plane.md)。
