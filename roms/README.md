# RayLink 应用源码

RayLink 的产品介绍、架构、界面截图、一键安装和完整使用说明位于
[仓库首页 README](../README.md)。

本目录是可运行的 Node.js 应用根目录：

```text
server/   控制面 API、SQLite、配置编译、节点任务与流量计量
web/      管理控制台、首次初始化、用户中心与 RayLink Node
deploy/   一键安装、systemd、Nginx 与发布包脚本
tests/    API、协议、发布、节点安全与计量测试
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
RAYLINK_PROXY_HOST='node.example.com' \
SING_BOX_BIN='/usr/local/bin/raylink-sing-box' \
npm start
```

## 验证

```bash
npm run check
```

生产安装与发布包构建见 [deploy/README.md](deploy/README.md)。
