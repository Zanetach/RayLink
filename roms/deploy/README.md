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

从远程发布包安装时必须同时提供发布包地址和 SHA-256，安装器不会执行第三方动态脚本：

```bash
RAYLINK_PACKAGE_URL=https://download.example.com/raylink-0.1.0.tar.gz \
RAYLINK_PACKAGE_SHA256=<发布页提供的校验值> \
bash install-control-plane.sh
```

安装器会完成：

- 从 Node.js 官方源安装并校验 Node.js 22；
- 构建审批版本的 sing-box 1.13.14 计量版；
- 安装 RayLink、systemd 和 Nginx；
- 为服务器 IP 生成带 SAN 的首次访问证书；
- 输出仅显示一次的 `https://服务器IP/setup#token=...` 初始化地址。

浏览器首次访问 IP 证书会提示证书由本机签发。继续前应核对安装器输出的
SHA-256 证书指纹。初始化令牌只以哈希形式写入服务器，默认 30 分钟后失效；
初始化成功后立即作废。

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
