# RayLink 单机生产部署

以下示例面向 Debian/Ubuntu + systemd。路径约定：

- 应用：`/opt/raylink`
- 数据：`/var/lib/raylink`
- 环境：`/etc/raylink/raylink.env`
- 受管配置：`/var/lib/raylink/sing-box/config.json`

## 推荐：一键安装与首次初始化

在正式发布包根目录执行：

```bash
bash deploy/install-control-plane.sh
```

云主机若有 NAT、多块网卡或只显示私网地址，必须显式提供实际访问地址：

```bash
RAYLINK_PUBLIC_IP=203.0.113.10 bash deploy/install-control-plane.sh
```

安装器不会把自动检测到的私网地址误当作公网入口；局域网部署使用私网 IP 时也应显式设置。

从远程发布包安装时必须同时提供发布包地址和 SHA-256，安装器不会执行第三方动态脚本：

```bash
RAYLINK_PACKAGE_URL=https://download.example.com/raylink-0.1.0.tar.gz \
RAYLINK_PACKAGE_SHA256=<发布页提供的校验值> \
bash install-control-plane.sh
```

安装器会完成：

- 从 Node.js 官方源安装并校验 Node.js 22；
- 优先校验并安装发布包内预编译的 sing-box 1.13.14 计量版；
- 开发源码包未携带预编译 Runtime 时，才回退到本机编译；
- 安装 RayLink、systemd 和 Nginx；
- 为服务器 IP 生成带 SAN 的首次访问证书；
- 输出仅显示一次的 `https://服务器IP/setup#token=...` 初始化地址。

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

产物准备完成后构建正式安装包。默认要求 AMD64 和 ARM64 都齐全：

```bash
bash deploy/package-release.sh 0.1.0
```

若当前交付目标全部是 AMD/x86 VPS，可以只装配 AMD64：

```bash
RAYLINK_RELEASE_ARCHES=amd64 bash deploy/package-release.sh 0.1.0
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
2. 选择域名或 IP 主访问入口，并配置已有 HTTPS/反向代理；
3. 创建正式管理员；
4. 设置本机 Runtime 名称、地址和区域；
5. 检查并进入控制台。

没有域名时可以长期使用 IP HTTPS；浏览器需要信任安装器生成的本机 CA/证书。
正式对外服务更推荐配置域名和受信任证书，再将“主访问地址”切换为该域名。

## 手动安装

安装 Node.js 22.5+ 和审批版本的 sing-box，然后创建目录：

```bash
install -d -m 700 /var/lib/raylink
install -d -m 700 /etc/raylink
```

将项目复制到 `/opt/raylink`，并根据 `raylink.env.example` 创建 `/etc/raylink/raylink.env`。

```bash
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

RayLink 的 systemd 模式会重启 `sing-box-raylink.service`。示例为了让配置写入、读取和服务重启权限一致，以 root 运行两项服务；因此 RayLink 必须只监听回环地址，并置于 HTTPS 反向代理后方。若要使用非 root 账号，应另外配置严格的 polkit 权限和共享文件组。

## 反向代理

只代理 `127.0.0.1:4173`，并启用 HTTPS。`RAYLINK_PUBLIC_ORIGIN` 必须与浏览器实际访问的源完全一致，例如：

```text
RAYLINK_PUBLIC_ORIGIN=https://panel.example.com
```

生产 Nginx 配置应从 [nginx.conf.example](nginx.conf.example) 开始。该示例明确关闭
`/sub/` 路径的 access log，因为 URL 中包含可直接取得用户配置的订阅密钥。不要使用会记录完整 URI
的全局访问日志覆盖这条规则；部署后用测试订阅请求检查访问日志中不存在 `/sub/`。

不要通过公网直接暴露 4173。

## 检查

```bash
systemctl status raylink
systemctl status sing-box-raylink
journalctl -u raylink -n 100 --no-pager
journalctl -u sing-box-raylink -n 100 --no-pager
```

配置发布失败时，RayLink 会保留上一份活动配置；首次发布失败则不会留下未启动的活动文件。
