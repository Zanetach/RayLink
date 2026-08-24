# RayLink 应用源码

RayLink 的产品介绍、架构、界面截图、一键安装和完整使用说明位于
[仓库首页 README](../README.md)。

仓库根目录就是可运行的 Node.js 应用根目录：

```text
server/   控制面 API、SQLite、配置编译、RayLink Node 任务与流量计量
web/      管理控制台、首次初始化、用户中心与 RayLink Node
deploy/   一键安装、systemd、Caddy 与发布包脚本
tests/    API、协议、Deployment、RayLink Node 安全与计量测试
docs/     协议研究、架构决策和生产落地资料
```

## 本地运行

要求 Node.js 22.5+：

```bash
npm start
```

默认访问 [http://127.0.0.1:4173](http://127.0.0.1:4173)。本机开发凭据为
`admin / Admin@2026`；生产模式会拒绝使用该默认密码。

项目不加载 `.env` 文件。需要直接传入环境变量，或使用 systemd
`EnvironmentFile`：

```bash
RAYLINK_ADMIN_PASSWORD='replace-with-a-long-random-secret' \
RAYLINK_DATA_DIR='/var/lib/raylink' \
RAYLINK_PUBLIC_ORIGIN='https://panel.example.com' \
RAYLINK_SUBSCRIPTION_ORIGIN='https://sub.example.com' \
RAYLINK_PROXY_HOST='node.example.com' \
SING_BOX_BIN='/usr/local/bin/raylink-sing-box' \
npm start
```

## 验证

基础代码回归：

```bash
npm run check
```

自动化生产前检查需要 PATH 中有 sing-box 1.13.14 与 OpenSSL：

```bash
npm run check:production
```

该命令不替代干净 VPS、真实客户端和长时间故障验收。

生产安装与发布包构建见 [deploy/README.md](../deploy/README.md)。

## 通用订阅

用户订阅使用一个稳定地址，并按客户端自动返回兼容配置：

- Clash/Mihomo：完整 YAML，包含智能选择、TCP/UDP 分组、故障回退、CN 直连和 DNS。
- Loon：直接使用无参数、无扩展名的通用地址，自动识别为原生节点订阅，并过滤客户端
  不支持的 TUIC 与旧 Hysteria 节点。
- Egern：节点订阅 YAML，或带智能策略、规则和 DNS 的完整 Profile。
- sing-box：完整 JSON，保留 TUN、规则集与多 Host selector/urltest。

可使用 `?format=mihomo`、`?format=loon`、`?format=egern`、
`?format=egern-profile` 和 `?format=singbox` 显式选择格式。浏览器打开通用地址时会显示
安全的客户端选择页。Loon 节点订阅不修改客户端已有的策略组、规则和 DNS 配置。

## 统一路由与健康模型

`server/routing/policy.js` 是路由策略的唯一事实来源。Mihomo、Egern 和
sing-box 仅负责把同一套策略导出成不同语法，统一包含 AI 网站代理、TCP 稳定、
UDP 高速、故障回退、手动选择和国内直连。

协议健康每轮采样 5 次，以 P50 展示连接耗时、P95 展示尾部耗时、MAD 展示抖动；
至少 4 次成功才判定本轮可用，连续 3 轮失败才判定超时。Hysteria 2 和 TUIC
还需要最近至少 3 轮、窗口成功率不低于 95%，才会进入默认智能组。

## 权限、备份与告警

控制面内置四种管理员角色：

- Owner：全部权限与管理员管理；
- Operator：用户、Runtime、主机、协议和发布；
- Support：用户与订阅服务；
- Auditor：只读与审计查询。

所有成功的管理写操作都会进入审计日志。数据库使用 SQLite Online Backup API
创建一致性快照，并自动执行 SHA-256 与 `PRAGMA integrity_check`。默认每天备份，
保留 14 份；可在“系统 → 版本与备份”立即执行。

运行告警覆盖节点离线、Deployment Target 失败或长期等待、协议连续失败、真实流量
计量中断、内存或磁盘过高、远程节点 TLS 证书临期和备份过期。服务首次启动会尽快
生成第一份在线备份，之后按计划执行。设置 `RAYLINK_ALERT_WEBHOOK_URL` 后，告警打开
与恢复会以可去重的事件 ID 推送到 HTTPS Webhook。

数据库恢复必须在服务停止后执行。脚本会先验证清单、SHA-256 和 SQLite 完整性，
保留当前数据库作为恢复点，并在服务无法恢复时自动回滚：

```bash
sudo deploy/restore-database.sh /var/lib/raylink/backups/raylink-YYYYMMDDTHHMMSS-xxxxxxxx.sqlite
```

正式发布流水线会在原生 Linux AMD64/ARM64 Runner 上构建计量版 sing-box Runtime，
每个架构生成独立安装包、SHA-256、机器可读 Manifest 和 SPDX 2.3 SBOM，并使用
GitHub Build Provenance 对发布资产提供可验证的来源证明。升级时，候选版本会先在
数据库副本上验证迁移与完整性，再切换正在运行的控制面。

完整生产门槛和分阶段计划见
[生产化统一规划](production-readiness-plan.md)。
