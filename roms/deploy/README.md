# RayLink 单机生产部署

以下示例面向 Debian/Ubuntu + systemd。路径约定：

- 应用：`/opt/raylink`
- 数据：`/var/lib/raylink`
- 环境：`/etc/raylink/raylink.env`
- 受管配置：`/var/lib/raylink/sing-box/config.json`

## 1. 准备

安装 Node.js 22.5+ 和官方 sing-box 稳定版，然后创建目录：

```bash
install -d -m 700 /var/lib/raylink
install -d -m 700 /etc/raylink
```

将项目复制到 `/opt/raylink`，并根据 `raylink.env.example` 创建 `/etc/raylink/raylink.env`。

## 2. 安装服务

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

## 3. 反向代理

只代理 `127.0.0.1:4173`，并启用 HTTPS。`RAYLINK_PUBLIC_ORIGIN` 必须与浏览器实际访问的源完全一致，例如：

```text
RAYLINK_PUBLIC_ORIGIN=https://panel.example.com
```

不要通过公网直接暴露 4173。

## 4. 检查

```bash
systemctl status raylink
systemctl status sing-box-raylink
journalctl -u raylink -n 100 --no-pager
journalctl -u sing-box-raylink -n 100 --no-pager
```

配置发布失败时，RayLink 会保留上一份活动配置；首次发布失败则不会留下未启动的活动文件。
