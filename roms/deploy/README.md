# RayLink 单机生产部署

以下示例面向 Debian/Ubuntu + systemd。路径约定：

- 应用：`/opt/raylink`
- 数据：`/var/lib/raylink`
- 环境：`/etc/raylink/raylink.env`
- 受管配置：`/var/lib/raylink/sing-box/config.json`

## 推荐：一键安装与首次初始化

v0.2.6 Release 当前支持 AMD64（x86_64）。服务器需要预先具备 `curl`。
使用 root 登录时，直接复制执行这一条命令：

```bash
bash -o pipefail -c 'curl -fsSL https://github.com/Zanetach/RayLink/releases/download/v0.2.6/install.sh | bash'
```

普通用户登录时，把管道中的 `bash` 改为 `sudo bash`：

```bash
bash -o pipefail -c 'curl -fsSL https://github.com/Zanetach/RayLink/releases/download/v0.2.6/install.sh | sudo bash'
```

脚本检测 CPU 架构和公网 IP，自动补齐 Debian/Ubuntu 上缺少的归档校验工具，
下载固定版本发布包和 `.sha256`，校验通过后才会解压并执行控制面安装器。
云主机若有 NAT、多块网卡，建议显式提供实际访问地址：

```bash
bash -o pipefail -c 'curl -fsSL https://github.com/Zanetach/RayLink/releases/download/v0.2.6/install.sh | bash -s -- --public-ip 203.0.113.10'
```

安装指定版本：

```bash
bash -o pipefail -c 'curl -fsSL https://github.com/Zanetach/RayLink/releases/download/v0.2.6/install.sh | bash -s -- --version 0.2.6'
```

只验证下载、校验和解压，不修改系统：

```bash
bash -o pipefail -c 'curl -fsSL https://github.com/Zanetach/RayLink/releases/download/v0.2.6/install.sh | bash -s -- --dry-run'
```

一键安装会完成：

- 从 Node.js 官方源安装并校验 Node.js 22；
- 优先校验并安装发布包内预编译的 sing-box 1.13.14 计量版；
- 开发源码包未携带预编译 Runtime 时，才回退到本机编译；
- 从 Caddy 官方 APT 仓库安装 Caddy，并配置 systemd 自启动；
- 安装 RayLink 和 sing-box systemd 服务；
- 为服务器 IP 生成带 SAN 的首次访问证书；
- 输出仅显示一次的 `https://服务器IP/setup#token=...` 初始化地址。

已经下载发布包时，也可以在发布包根目录直接执行底层安装器：

```bash
sudo env RAYLINK_PUBLIC_IP=203.0.113.10 bash deploy/install-control-plane.sh
```

浏览器首次访问 IP 证书会提示证书由本机签发。继续前应核对安装器输出的
SHA-256 证书指纹。初始化令牌只以哈希形式写入服务器，默认 30 分钟后失效；
初始化成功后立即作废。

### 发布时预编译 Runtime

正式发布包应同时包含 `linux-amd64` 和 `linux-arm64` 两个 Runtime，避免每台 VPS
重复下载 Go 模块和编译。分别在对应架构的可信 Linux 构建机执行：

```bash
sudo bash deploy/build-runtime-artifact.sh 1.13.14
```

默认产物写入 `web/node/runtime/`。将两台构建机生成的二进制及 `.sha256`
文件合并到发布包的该目录；控制台首机安装和后续 RayLink Node 接入都会按 VPS
架构选择同一份产物，验证 SHA-256、sing-box 版本及完整审批 build tags 后直接
安装。仓库源码不提交大型二进制，正式发布流水线负责生成并装配这些产物。

也可以指定自定义目录；相对路径会先转换为绝对路径，避免构建器拒绝：

```bash
sudo bash deploy/build-runtime-artifact.sh 1.13.14 ./release-runtime
```

第三个参数可以指定目标架构，例如在 ARM64 构建机上交叉构建 AMD64：

```bash
sudo bash deploy/build-runtime-artifact.sh 1.13.14 ./release-runtime amd64
```

交叉构建阶段会验证目标 ELF 架构；发布前还必须在 AMD64 Linux 用户空间执行
`raylink-sing-box-1.13.14-linux-amd64 version`，确认版本和完整审批 build tags。
原生架构构建会在脚本内部直接完成这项执行校验。

产物准备完成后构建正式安装包。v0.2.6 默认装配 AMD64 Runtime：

```bash
bash deploy/package-release.sh 0.2.6
```

也可以显式指定本次发布需要装配的架构：

```bash
RAYLINK_RELEASE_ARCHES=amd64 bash deploy/package-release.sh 0.2.6
```

发布包只包含 `package.json`、`server/`、`web/` 和 `deploy/`，不会打包本地
`data/`、测试数据库或开发输出，并会同时生成发布包 `.sha256`。

若令牌过期，在服务器上执行以下命令可安全轮换令牌。新明文令牌仍只显示一次，
服务器只保存其哈希：

```bash
bash /opt/raylink/deploy/rotate-setup-token.sh
```

首次初始化包含五步：

1. 验证一次性安装令牌；
2. 选择域名或 IP 访问入口；域名模式分别填写控制台域名和订阅域名，由 Caddy
   检查 DNS、自动申请证书并配置续期；
3. 创建正式管理员；
4. 设置本机 Runtime 名称、节点连接地址和区域；
5. 检查并进入控制台。

提交最后一步后，RayLink 会先检测 Linux 内核的拥塞控制能力，再自动加载
`tcp_bbr`、启用 `net.core.default_qdisc=fq` 和
`net.ipv4.tcp_congestion_control=bbr`。配置会持久化到
`/var/lib/raylink/managed/99-raylink-bbr.conf`，并通过
`/etc/sysctl.d/99-raylink-bbr.conf` 在重启后继续生效。初始化界面会实时显示
BBR 配置进度；内核不支持或配置验证失败时，初始化保持可重试状态并给出明确错误。

没有域名时可以长期使用 IP HTTPS；浏览器需要信任安装器生成的本机证书。使用域名时
必须先把 A/AAAA 记录直接解析到该 VPS（初始化时关闭 CDN 代理），并开放 TCP 80/443。
Caddy 切换域名后仍保留 IP HTTPS 入口用于恢复。

## 手动安装

安装 Node.js 22.5+ 和审批版本的 sing-box，然后创建目录：

```bash
install -d -m 710 -o root -g caddy /var/lib/raylink
install -d -m 750 -o root -g caddy /var/lib/raylink/managed
install -d -m 700 /etc/raylink
```

将项目复制到 `/opt/raylink`，根据 `raylink.env.example` 创建
`/var/lib/raylink/managed/raylink.env`，将初始 Caddyfile 放到同一目录，并建立兼容链接：

```bash
ln -sfn /var/lib/raylink/managed/raylink.env /etc/raylink/raylink.env
ln -sfn /var/lib/raylink/managed/Caddyfile /etc/caddy/Caddyfile
cp deploy/raylink.service /etc/systemd/system/raylink.service
cp deploy/sing-box-raylink.service /etc/systemd/system/sing-box-raylink.service
systemctl daemon-reload
systemctl enable --now raylink
```

先保持 `RAYLINK_RUNTIME_MODE=dry-run`。在控制台完成主机配置并发布一次，然后执行：

```bash
sing-box check -c /var/lib/raylink/sing-box/config.json
```

确认通过后：

```bash
systemctl enable --now sing-box-raylink
sed -i 's/RAYLINK_RUNTIME_MODE=dry-run/RAYLINK_RUNTIME_MODE=systemd/' /etc/raylink/raylink.env
systemctl restart raylink
```

RayLink 的 systemd 模式会重启 `sing-box-raylink.service`。示例为了让配置写入、读取、
服务重启和首次 Caddy 配置切换权限一致，以 root 运行 RayLink；服务只监听回环地址，
外部 HTTPS 由 Caddy 提供。若要使用非 root 账号，应另外配置严格的 polkit、文件组和
Caddy 管理权限。

`RAYLINK_PROTOCOL_PROBE_URL` 用于 Hysteria、TUIC 和 Hysteria2 的协议级验收，
默认是 `https://www.gstatic.com/generate_204`。节点会用刚发布的真实协议配置访问
该 HTTPS 地址，成功后才报告“公网可用”；自定义地址必须稳定返回并使用受信任证书。

## Caddy 与域名初始化

安装阶段 Caddy 使用 IP 证书代理 `127.0.0.1:4173`。在首次初始化界面选择域名后，
RayLink 会：

1. 检查控制台域名和订阅域名的 A/AAAA 是否直接指向当前 VPS；
2. 校验候选 Caddyfile；
3. 为控制台和订阅域名分别建立站点并等待自动签发证书；
4. 分别持久化 `RAYLINK_PUBLIC_ORIGIN`、`RAYLINK_SUBSCRIPTION_ORIGIN` 和 Host 节点地址；
5. 从本机使用两个域名的 SNI 验证证书链和 HTTPS 确实可用；
6. 保留 IP HTTPS 站点作为恢复入口；
7. 任一步失败时恢复原 Caddyfile 和环境文件。

订阅域名只转发 `/sub/*` 和 `/rule-sets/*`，其他路径统一返回 404；Host 节点地址
用于生成 sing-box 客户端连接配置，不参与控制台或订阅 HTTP 路由。

一键安装把受管 Caddyfile 和环境文件存放在 `/var/lib/raylink/managed/`，并从
`/etc/caddy/Caddyfile`、`/etc/raylink/raylink.env` 建立兼容链接。这样控制面不需要
写入整个 `/etc/caddy` 或 `/etc/raylink` 目录。

生成的 Caddyfile 默认不开启访问日志，避免包含配置 URL 密钥的 `/sub/` 地址落盘。
若自行增加日志，必须对 `/sub/` 路径禁用或脱敏。Caddy 的自动 HTTPS 需要公网 TCP
80/443；证书申请和续期由 Caddy 管理。

不要通过公网直接暴露 4173。

## 检查

```bash
systemctl status raylink
systemctl status sing-box-raylink
systemctl status caddy
journalctl -u raylink -n 100 --no-pager
journalctl -u sing-box-raylink -n 100 --no-pager
journalctl -u caddy -n 100 --no-pager
```

配置发布失败时，RayLink 会保留上一份活动配置；首次发布失败则不会留下未启动的活动文件。
