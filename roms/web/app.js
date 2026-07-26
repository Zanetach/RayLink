const users = [];

const clientCatalog = {
  "mihomo": { name: "Mihomo", platforms: "macOS / Windows / Android", action: "一键导入" },
  "sing-box": { name: "sing-box", platforms: "iOS / Android / Desktop", action: "一键导入" },
  "download": { name: "其他客户端", platforms: "下载兼容配置文件", action: "下载配置" }
};

const accountSummary = { totalUsers: 0 };

const estimatedTrafficShape = {
  download: [1.4, 1.1, 0.9, 0.8, 1.7, 3.2, 4.9, 6.6, 5.4, 7.1, 8.4, 7.6, 6.3],
  upload: [0.3, 0.3, 0.2, 0.2, 0.5, 0.9, 1.4, 1.9, 1.6, 2.1, 2.4, 2.2, 1.8]
};

const controlPlane = {
  currentAdmin: null,
  hosts: [],
  runtime: null,
  runtimePreview: null,
  installation: null,
  protocols: [],
  protocolCatalog: [],
  deployments: [],
  portalProfile: null
};

const scopeLabels = {
  all: "全部节点",
  tokyo: "东京",
  singapore: "新加坡",
  frankfurt: "法兰克福",
  losangeles: "洛杉矶"
};

const stateLabels = {
  active: { label: "启用", className: "good" },
  warning: { label: "临近配额", className: "warning" },
  disabled: { label: "已停用", className: "neutral" }
};

const hostDetails = {
  "东京核心": { region: "日本 · 东京", ip: "103.45.17.82", os: "Ubuntu 24.04", cpu: 34, memory: 48, protocols: "VLESS + Reality", port: "443", sync: "8 秒前" },
  "新加坡边缘": { region: "新加坡", ip: "18.141.202.73", os: "Debian 12", cpu: 51, memory: 63, protocols: "Hysteria2 + TUIC", port: "8443 / UDP", sync: "11 秒前" },
  "法兰克福": { region: "德国 · 法兰克福", ip: "3.71.186.44", os: "Ubuntu 24.04", cpu: 27, memory: 39, protocols: "VLESS + Trojan", port: "443 / 9443", sync: "9 秒前" },
  "洛杉矶入口": { region: "美国 · 洛杉矶", ip: "34.216.88.109", os: "Debian 12", cpu: 76, memory: 71, protocols: "VLESS + Reality", port: "443", sync: "16 秒前" }
};

const elements = {
  authScreen: document.querySelector("#admin-auth"),
  authForm: document.querySelector("#admin-login-form"),
  authError: document.querySelector("#admin-auth-error"),
  appShell: document.querySelector("#app-shell"),
  rail: document.querySelector("#rail"),
  menuToggle: document.querySelector("#menu-toggle"),
  indicator: document.querySelector(".nav-indicator"),
  userBody: document.querySelector("#user-table-body"),
  userCount: document.querySelector("#user-result-count"),
  userSearch: document.querySelector("#user-search"),
  hostBody: document.querySelector("#host-table-body"),
  drawer: document.querySelector("#detail-drawer"),
  drawerTitle: document.querySelector("#drawer-title"),
  drawerEyebrow: document.querySelector("#drawer-eyebrow"),
  drawerContent: document.querySelector("#drawer-content"),
  drawerClose: document.querySelector("#drawer-close"),
  drawerCancel: document.querySelector("#drawer-cancel"),
  drawerSave: document.querySelector("#drawer-save"),
  drawerScrim: document.querySelector("#drawer-scrim"),
  toast: document.querySelector("#toast"),
  toastTitle: document.querySelector("#toast-title"),
  toastMessage: document.querySelector("#toast-message")
};

let activeUserFilter = "all";
let toastTimer;
let lastFocusedElement;
let publishInProgress = false;
let currentPortalUserEmail = "";

function icon(name) {
  return `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(body?.error?.message || `请求失败（${response.status}）`);
    error.code = body?.error?.code;
    error.status = response.status;
    throw error;
  }
  return body;
}

function scopeToLabel(scope) {
  if (scope.includes("all")) return "全部节点";
  return scope.map((region) => scopeLabels[region] || region).join(" + ");
}

function labelToScope(label) {
  if (label === "全部节点") return ["all"];
  return label.split(" + ").map((name) => Object.entries(scopeLabels).find(([, value]) => value === name)?.[0] || name);
}

function applyBootstrap(data) {
  users.splice(0, users.length, ...data.users.map((user) => ({
    id: user.id,
    name: user.name,
    initials: user.initials,
    email: user.email,
    portalStatus: user.portalStatus,
    state: user.state,
    used: user.usedGb,
    quota: user.quotaGb,
    nodeScope: user.nodeScope,
    clients: user.clientFormats,
    expires: user.expiresAt
  })));
  accountSummary.totalUsers = users.length;
  controlPlane.currentAdmin = data.currentAdmin;
  controlPlane.hosts = data.hosts;
  controlPlane.runtime = data.runtime;
  controlPlane.runtimePreview = data.runtimePreview;
  controlPlane.installation = data.installation;
  controlPlane.protocols = data.protocols;
  controlPlane.protocolCatalog = data.protocolCatalog;
  controlPlane.deployments = data.deployments;
  const rollbackButton = document.querySelector("#rollback-config");
  const rollbackTarget = data.deployments.find((deployment) => deployment.status === "superseded");
  if (rollbackButton) {
    rollbackButton.disabled = !rollbackTarget;
    rollbackButton.dataset.deploymentId = rollbackTarget?.id || "";
    rollbackButton.title = rollbackTarget ? `回滚到 ${rollbackTarget.version}` : "没有可回滚的历史版本";
  }
  const profileButton = document.querySelector(".profile-button");
  if (profileButton) {
    profileButton.querySelector(".avatar").textContent = data.currentAdmin.username.slice(0, 2).toUpperCase();
    profileButton.querySelector("strong").textContent = data.currentAdmin.username;
    profileButton.querySelector("small").textContent = "管理员";
  }
  renderUsers();
  renderRuntime();
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");
  applyBootstrap(data);
  return data;
}

function renderRuntime() {
  const runtime = controlPlane.runtime;
  if (!runtime) return;
  const railStatus = document.querySelector(".rail-status");
  const activeDeployment = controlPlane.deployments.find((deployment) => deployment.status === "active");
  const deploymentVersion = activeDeployment?.version || "尚未发布";
  const healthy = ["running", "staged"].includes(runtime.state);
  railStatus.querySelector("strong").textContent = healthy ? "Runtime 已就绪" : "Runtime 待配置";
  railStatus.querySelector("small").textContent = runtime.runtimeVersion
    ? `sing-box ${runtime.runtimeVersion}`
    : `${runtime.mode} · ${runtime.state}`;
  document.querySelectorAll(".release-version").forEach((element) => {
    element.textContent = deploymentVersion;
  });
  const listenPort = document.querySelector("#managed-listen-port");
  if (listenPort && controlPlane.runtimePreview) listenPort.textContent = controlPlane.runtimePreview.listenPort;
  renderHosts();
  renderProtocols();
  renderConfigPreview();
  renderDashboard();
  renderOperations();
  renderDiagnostics();
  renderSystem();
}

function renderDashboard() {
  const runtime = controlPlane.runtime || { state: "not-configured", mode: "dry-run" };
  const host = controlPlane.hosts[0];
  const latestAttempt = controlPlane.deployments[0];
  const activeDeployment = controlPlane.deployments.find((deployment) => deployment.status === "active");
  const ready = ["running", "staged"].includes(runtime.state);
  const activeUsers = users.filter((user) => ["active", "warning"].includes(user.state)).length;
  const setText = (selector, value) => {
    const element = document.querySelector(selector);
    if (element) element.textContent = value;
  };
  setText("#dashboard-runtime-heading", ready ? "sing-box Runtime 已就绪" : "Runtime 等待首次发布");
  setText("#dashboard-runtime-copy", ready
    ? `${host?.name || "本机 Runtime"} 正在使用 ${runtime.runtimeVersion ? `sing-box ${runtime.runtimeVersion}` : runtime.mode}。`
    : "完成主机配置后，在“配置发布”中生成并校验第一份受管配置。");
  const runtimeCount = document.querySelector("#dashboard-runtime-count");
  if (runtimeCount) runtimeCount.innerHTML = `${ready ? 1 : 0}<small>/ 1</small>`;
  setText("#dashboard-runtime-mode", `${runtime.mode} · ${runtime.state}`);
  setText("#dashboard-eligible-users", activeDeployment?.eligibleUsers ?? controlPlane.runtimePreview?.eligibleUsers ?? 0);
  setText("#dashboard-user-count", users.length);
  setText("#dashboard-active-users", `${activeUsers} 个账号启用`);
  setText("#dashboard-deployment-count", controlPlane.deployments.length);
  setText("#dashboard-latest-version", activeDeployment?.version || "尚未发布");
  setText("#dashboard-host-name", host?.name || "本机 Runtime");
  setText("#dashboard-host-address", host?.address || "尚未配置");
  setText("#dashboard-host-region", host?.region || "—");
  setText("#dashboard-host-status", ready ? "已就绪" : "待配置");
  document.querySelector("#dashboard-host-pulse")?.classList.toggle("warning", !ready);
  setText("#dashboard-deployment-version", activeDeployment?.version || "尚未发布");
  const deploymentStatus = document.querySelector("#dashboard-deployment-status");
  if (deploymentStatus) {
    deploymentStatus.className = `status-badge ${activeDeployment ? "good" : "neutral"}`;
    deploymentStatus.innerHTML = `<i></i>${activeDeployment ? "已生效" : "无记录"}`;
  }
  setText("#dashboard-deployment-users", activeDeployment?.eligibleUsers || 0);
  setText("#dashboard-deployment-time", activeDeployment?.publishedAt
    ? `${activeDeployment.publisherUsername || "管理员"} · ${new Date(activeDeployment.publishedAt).toLocaleString("zh-CN")}`
    : "—");
  setText("#dashboard-deployment-validation", latestAttempt?.status === "failed"
    ? `最近一次尝试失败：${latestAttempt.error}`
    : runtime.runtimeVersion ? `sing-box ${runtime.runtimeVersion}` : runtime.mode);
  renderNetworkTrend({ activeUsers, ready });
  const policyStatus = activeDeployment ? `策略 ${activeDeployment.version} 已生效` : "尚未发布账号策略";
  const policyMeta = activeDeployment?.publishedAt
    ? `${activeDeployment.publisherUsername || "管理员"} · ${new Date(activeDeployment.publishedAt).toLocaleString("zh-CN")}`
    : "修改后需要重新发布配置";
  setText("#user-policy-status", policyStatus);
  setText("#user-policy-meta", policyMeta);
}

function renderNetworkTrend({ activeUsers, ready }) {
  const downloadLine = document.querySelector("#dashboard-download-line");
  const uploadLine = document.querySelector("#dashboard-upload-line");
  const downloadArea = document.querySelector("#dashboard-download-area");
  if (!downloadLine || !uploadLine || !downloadArea) return;

  const demandFactor = ready && activeUsers > 0
    ? Math.min(1.6, Math.max(0.55, activeUsers / 5))
    : 0;
  const download = estimatedTrafficShape.download.map((value) => value * demandFactor);
  const upload = estimatedTrafficShape.upload.map((value) => value * demandFactor);
  const peak = Math.max(...download, ...upload, 0);
  const axisMax = Math.max(2, Math.ceil(peak / 2) * 2);
  const downloadPath = trafficPath(download, axisMax);
  const uploadPath = trafficPath(upload, axisMax);

  downloadLine.setAttribute("d", downloadPath);
  uploadLine.setAttribute("d", uploadPath);
  downloadArea.setAttribute("d", `${downloadPath} L760 230 L0 230 Z`);

  const setText = (selector, value) => {
    const element = document.querySelector(selector);
    if (element) element.textContent = value;
  };
  setText("#dashboard-download-total", `${estimatedGigabytes(download).toFixed(1)} GB`);
  setText("#dashboard-upload-total", `${estimatedGigabytes(upload).toFixed(1)} GB`);
  setText("#dashboard-traffic-peak", `${peak.toFixed(1)} Mbps`);
  setText(
    "#dashboard-traffic-current",
    `${((download.at(-1) || 0) + (upload.at(-1) || 0)).toFixed(1)} Mbps`
  );
  setText("#dashboard-trend-updated", ready ? "已生成样例" : "等待 Runtime");
  setText(
    "#dashboard-chart-description",
    `估算样例：24 小时下行约 ${estimatedGigabytes(download).toFixed(1)} GB，`
      + `上行约 ${estimatedGigabytes(upload).toFixed(1)} GB，样例峰值 ${peak.toFixed(1)} Mbps。`
  );

  const chartY = document.querySelector("#dashboard-chart-y");
  if (chartY) {
    chartY.innerHTML = [
      axisMax,
      axisMax * (2 / 3),
      axisMax * (1 / 3),
      0
    ].map((value) => `<span>${value.toFixed(value % 1 === 0 ? 0 : 1)}</span>`).join("");
  }
  const chartX = document.querySelector("#dashboard-chart-x");
  if (chartX) {
    const now = new Date();
    const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    chartX.innerHTML = [-24, -18, -12, -6, 0].map((hours, index, ticks) => {
      if (index === ticks.length - 1) return "<span>现在</span>";
      const tick = new Date(now.getTime() + hours * 60 * 60 * 1000);
      return `<span>${timeFormatter.format(tick)}</span>`;
    }).join("");
  }
}

function trafficPath(values, maxValue) {
  const width = 760;
  const top = 20;
  const bottom = 209;
  return values.map((value, index) => {
    const x = index * (width / Math.max(1, values.length - 1));
    const y = bottom - (value / maxValue) * (bottom - top);
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function estimatedGigabytes(values) {
  const intervalSeconds = 2 * 60 * 60;
  const megabits = values.slice(1).reduce((total, value, index) => (
    total + ((values[index] + value) / 2) * intervalSeconds
  ), 0);
  return megabits / 8 / 1000;
}

function renderHosts() {
  if (!elements.hostBody) return;
  const hosts = controlPlane.hosts;
  if (!hosts.length) {
    elements.hostBody.innerHTML = '<tr><td colspan="7"><div class="empty-state">尚未配置 Runtime 主机</div></td></tr>';
    return;
  }
  const runtime = controlPlane.runtime || { state: "unknown", mode: "dry-run" };
  const enabledProtocols = controlPlane.protocols.filter((profile) => profile.enabled);
  const protocolLabels = enabledProtocols
    .map((profile) => controlPlane.protocolCatalog.find((item) => item.type === profile.type)?.name || profile.type);
  elements.hostBody.innerHTML = hosts.map((host) => {
    const isLocal = host.kind !== "remote";
    const healthy = isLocal
      ? ["running", "staged"].includes(runtime.state)
      : host.status === "online";
    const status = isLocal
      ? (healthy ? "已就绪" : "待配置")
      : ({ pending: "等待接入", online: "在线", degraded: "发布失败" }[host.status] || "离线");
    const statusClass = healthy ? "good" : host.status === "degraded" ? "warning" : "neutral";
    const lastSeen = host.lastSeenAt
      ? new Intl.DateTimeFormat("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit"
        }).format(new Date(host.lastSeenAt))
      : "尚无心跳";
    return `
    <tr>
      <td><button class="identity-link" data-open-host="${escapeHtml(host.id)}"><span class="flag">SB</span><span><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}</small></span></button></td>
      <td><span class="status-badge ${statusClass}"><i></i>${status}</span></td>
      <td>${protocolLabels.length
        ? protocolLabels.slice(0, 3).map((name) => `<span class="tag">${escapeHtml(name)}</span>`).join(" ")
        : '<span class="tag">尚未启用</span>'}</td>
      <td>${isLocal ? "控制面本机" : "RayLink Node"}</td>
      <td>${escapeHtml(isLocal ? runtime.platform || "local" : [host.platform, host.architecture].filter(Boolean).join(" / ") || "等待上报")}</td>
      <td><strong>${escapeHtml(isLocal ? runtime.runtimeVersion || runtime.mode : lastSeen)}</strong><small>${escapeHtml(isLocal ? runtime.state : host.runtimeVersion || host.agentVersion || "等待注册")}</small></td>
      <td><button class="icon-button small" aria-label="编辑${escapeHtml(host.name)}" data-open-host="${escapeHtml(host.id)}">${icon("more")}</button></td>
    </tr>`;
  }).join("");
  const host = hosts.find((item) => item.id === "local") || hosts[0];
  const healthyCount = hosts.filter((item) => item.id === "local"
    ? ["running", "staged"].includes(runtime.state)
    : item.status === "online").length;
  document.querySelector("#host-map-name").textContent = host.name;
  document.querySelector("#host-map-address").textContent = `${host.address} · ${host.region}`;
  document.querySelector("#host-map-status").innerHTML = `<i></i>${healthyCount}/${hosts.length} 个节点在线`;
  const managedTargetName = document.querySelector("#managed-target-name");
  if (managedTargetName) managedTargetName.textContent = host.name;
  document.querySelectorAll('.nav-item[data-view-target="system"] .nav-count').forEach((count) => {
    count.textContent = controlPlane.hosts.length;
  });
}

function renderProtocols() {
  const installation = controlPlane.installation || {
    installed: false,
    version: null,
    platform: "unknown",
    architecture: null,
    tags: []
  };
  const installButton = document.querySelector("#install-sing-box");
  const installCopy = document.querySelector("#runtime-installation-copy");
  const buildDetails = document.querySelector("#runtime-build-details");
  const protocolGrid = document.querySelector("#protocol-grid");
  if (!installButton || !installCopy || !buildDetails || !protocolGrid) return;

  installButton.disabled = installation.installed;
  installButton.classList.toggle("secondary", installation.installed);
  installButton.classList.toggle("primary", !installation.installed);
  installButton.innerHTML = installation.installed
    ? `${icon("check")} 已安装 ${escapeHtml(installation.version || "")}`
    : `${icon("terminal")} 一键安装 sing-box`;
  installCopy.textContent = installation.installed
    ? `已检测到 sing-box ${installation.version}，协议能力来自当前二进制构建。`
    : "当前主机未检测到 sing-box。安装完成后才能启用和发布协议。";
  buildDetails.innerHTML = installation.installed
    ? `<span>${escapeHtml(installation.platform)} / ${escapeHtml(installation.architecture || "unknown")}</span><span>${installation.tags.length} 个 build tags</span><code>${escapeHtml(installation.binaryPath)}</code>`
    : `<span>${escapeHtml(installation.platform)} · 未安装</span><span>macOS 使用 Homebrew，Linux 使用官方安装脚本</span>`;

  const profiles = new Map(controlPlane.protocols.map((profile) => [profile.type, profile]));
  protocolGrid.innerHTML = controlPlane.protocolCatalog.map((protocol) => {
    const profile = profiles.get(protocol.type);
    const enabled = profile?.enabled === true;
    const capability = protocol.available
      ? enabled ? "已启用" : protocol.formLevel === "advanced" ? "高级配置" : "可配置"
      : !installation.installed
        ? "未安装"
        : !protocol.versionSupported
          ? "版本不兼容"
          : protocol.platformSupported
            ? `缺少 ${protocol.missingTags.join(", ") || "运行时"}`
            : "当前平台不可用";
    const statusClass = enabled ? "good" : protocol.available ? "neutral" : "warning";
    return `
      <article class="protocol-card ${enabled ? "enabled" : ""}">
        <header><span class="protocol-kind">${escapeHtml(protocol.type)}</span><span class="status-badge ${statusClass}"><i></i>${escapeHtml(capability)}</span></header>
        <h3>${escapeHtml(protocol.name)}</h3>
        <p>${escapeHtml(protocol.description)}</p>
        <div class="protocol-meta">
          <span>${protocol.defaultPort ? `默认 ${protocol.defaultPort}` : "无固定端口"}</span>
          <span>${protocol.tls === "required" ? "需要 TLS" : protocol.realityAvailable ? "支持 Reality" : "标准入站"}</span>
        </div>
        <footer>
          <a href="${escapeHtml(protocol.sourceUrl)}" target="_blank" rel="noreferrer">源码 ↗</a>
          <button class="button secondary" data-protocol="${escapeHtml(protocol.type)}" ${protocol.available ? "" : "disabled"}>${enabled ? "编辑配置" : "配置协议"}</button>
        </footer>
      </article>`;
  }).join("");

  const enabledCount = controlPlane.protocols.filter((profile) => profile.enabled).length;
  document.querySelector("#enabled-protocol-count").textContent = `${enabledCount} 个协议已启用`;
  const inboundTabCount = document.querySelector("#inbound-tab-count");
  if (inboundTabCount) inboundTabCount.textContent = enabledCount;
  const serviceNavCount = document.querySelector("#service-nav-count");
  if (serviceNavCount) serviceNavCount.textContent = enabledCount;
}

function renderConfigPreview() {
  const preview = document.querySelector("#managed-config-preview");
  if (!preview) return;
  const inbounds = controlPlane.protocols.filter((profile) => profile.enabled).map((profile) => ({
    type: profile.type,
    tag: profile.type === "shadowsocks" ? "managed-shadowsocks" : `raylink-${profile.type}`,
    ...(profile.port ? { listen_port: profile.port } : {}),
    users: "$eligible_users"
  }));
  preview.textContent = JSON.stringify({
    log: { level: "info", timestamp: true },
    inbounds,
    outbounds: [{ type: "direct", tag: "direct" }],
    route: { final: "direct" }
  }, null, 2);
  const lineNumbers = preview.closest(".editor-body")?.querySelector(".line-numbers");
  if (lineNumbers) {
    lineNumbers.innerHTML = preview.textContent.split("\n").map((_, index) => `<li>${index + 1}</li>`).join("");
  }
  document.querySelector(".change-summary .add + strong").textContent = String(inbounds.length);
  const systemPreview = document.querySelector("#system-config-preview");
  if (systemPreview) systemPreview.textContent = preview.textContent;
}

function renderOperations() {
  const runtime = controlPlane.runtime || { state: "unknown", mode: "dry-run" };
  const installation = controlPlane.installation || { installed: false, version: null };
  const activeDeployment = controlPlane.deployments.find((deployment) => deployment.status === "active");
  const latestDeployment = controlPlane.deployments[0];
  const ready = ["running", "staged"].includes(runtime.state);
  const setText = (selector, value) => {
    const element = document.querySelector(selector);
    if (element) element.textContent = value;
  };
  setText("#operations-runtime-state", ready ? "运行正常" : "等待发布");
  setText("#operations-config-state", activeDeployment?.version || "尚未发布");
  setText(
    "#operations-validation-state",
    latestDeployment?.status === "failed" ? "最近一次失败" : activeDeployment ? "最近发布通过" : "尚无记录"
  );
  const facts = document.querySelector("#operations-runtime-facts");
  if (facts) {
    facts.innerHTML = `
      <span><small>状态</small><strong>${escapeHtml(runtime.state || "unknown")}</strong></span>
      <span><small>运行模式</small><strong>${escapeHtml(runtime.mode || "unknown")}</strong></span>
      <span><small>sing-box</small><strong>${escapeHtml(runtime.runtimeVersion || installation.version || "未检测")}</strong></span>
      <span><small>配置路径</small><strong>${escapeHtml(runtime.configPath || "尚未生成")}</strong></span>`;
  }
  const log = document.querySelector("#operations-log");
  if (log) {
    const entries = controlPlane.deployments.slice(0, 6).map((deployment) => {
      const time = deployment.publishedAt || deployment.createdAt;
      return `<span><time>${time ? new Date(time).toLocaleString("zh-CN") : "—"}</time> ${escapeHtml(deployment.version)} · ${escapeHtml(deployment.status)}</span>`;
    });
    log.innerHTML = entries.length
      ? entries.join("")
      : "<span>RayLink control plane ready.</span><span>等待首次发布事件…</span>";
  }
}

function renderDiagnostics() {
  const target = document.querySelector("#diagnostic-grid");
  if (!target) return;
  const installation = controlPlane.installation || { installed: false, version: null };
  const host = controlPlane.hosts[0];
  const enabledProtocols = controlPlane.protocols.filter((profile) => profile.enabled);
  const eligibleUsers = controlPlane.runtimePreview?.eligibleUsers || 0;
  const checks = [
    {
      name: "sing-box 安装",
      detail: installation.installed ? `已检测到 ${installation.version || "可用版本"}` : "当前主机尚未安装",
      pass: installation.installed
    },
    {
      name: "Runtime 主机",
      detail: host ? `${host.address} · ${host.region}` : "未配置主机地址",
      pass: Boolean(host?.address)
    },
    {
      name: "入站服务",
      detail: `${enabledProtocols.length} 个协议已启用`,
      pass: enabledProtocols.length > 0
    },
    {
      name: "有效用户",
      detail: `${eligibleUsers} 位用户可写入配置`,
      pass: eligibleUsers > 0
    }
  ];
  target.innerHTML = checks.map((check) => `
    <article class="${check.pass ? "pass" : "warning"}">
      <span>${check.pass ? icon("check") : "!"}</span>
      <div><strong>${escapeHtml(check.name)}</strong><small>${escapeHtml(check.detail)}</small></div>
    </article>`).join("");
}

function renderSystem() {
  const installation = controlPlane.installation || { installed: false, version: null, platform: "unknown", architecture: null };
  const version = document.querySelector("#system-version");
  const build = document.querySelector("#system-build");
  if (version) version.textContent = installation.installed
    ? `sing-box ${installation.version || ""}`
    : "sing-box 未安装";
  if (build) build.textContent = installation.installed
    ? `${installation.platform} / ${installation.architecture || "unknown"} · ${installation.tags?.length || 0} 个 build tags`
    : "可在服务工作区执行一键安装。";
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(`${value}T00:00:00`));
}

function renderUsers() {
  const query = elements.userSearch.value.trim().toLocaleLowerCase();
  const filtered = users.filter((user) => {
    const matchesFilter = activeUserFilter === "all" || user.state === activeUserFilter;
    const haystack = `${user.name} ${user.email} ${scopeToLabel(user.nodeScope)}`.toLocaleLowerCase();
    return matchesFilter && haystack.includes(query);
  });

  elements.userBody.innerHTML = filtered.map((user) => {
    const status = stateLabels[user.state];
    const ratio = Math.min(100, (user.used / user.quota) * 100);
    const progressClass = ratio >= 80 ? "warning" : "";
    return `
      <tr>
        <td>
          <button class="identity-link" data-user="${escapeHtml(user.email)}">
            <span class="avatar">${escapeHtml(user.initials)}</span>
            <span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}</small></span>
          </button>
        </td>
        <td><span class="status-badge ${status.className}"><i></i>${status.label}</span></td>
        <td class="usage-cell">
          <div class="usage-copy"><span>${user.used.toFixed(1)} GB</span><span>${user.quota} GB</span></div>
          <div class="progress ${progressClass}"><i style="width:${ratio.toFixed(1)}%"></i></div>
        </td>
        <td><span class="entitlement-cell"><strong>${escapeHtml(scopeToLabel(user.nodeScope))}</strong><small>${user.clients.length} 种客户端格式</small></span></td>
        <td class="numeric">${formatDate(user.expires)}</td>
        <td><button class="icon-button small" aria-label="编辑 ${escapeHtml(user.name)}" data-user="${escapeHtml(user.email)}">${icon("more")}</button></td>
      </tr>`;
  }).join("");

  elements.userCount.textContent = `显示 ${filtered.length} / ${accountSummary.totalUsers} 位用户`;
  document.querySelectorAll('.nav-item[data-view-target="users"] .nav-count').forEach((count) => {
    count.textContent = accountSummary.totalUsers;
  });
  document.querySelectorAll("[data-user-filter]").forEach((button) => {
    const filterName = button.dataset.userFilter;
    const count = filterName === "all" ? users.length : users.filter((user) => user.state === filterName).length;
    const badge = button.querySelector("span");
    if (badge) badge.textContent = count;
  });
  if (!filtered.length) {
    elements.userBody.innerHTML = `<tr><td colspan="6"><div class="empty-state">没有符合当前筛选条件的用户</div></td></tr>`;
  }
}

function navigate(viewName, updateHash = true) {
  const aliases = {
    "users/plans": "users",
    subscriptions: "users",
    hosts: "system",
    deploy: "operations"
  };
  const normalizedView = aliases[viewName] || viewName;
  const target = document.querySelector(`[data-view="${normalizedView}"]`) || document.querySelector('[data-view="not-found"]');
  const resolvedView = target.dataset.view;
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view === target));

  document.querySelectorAll("[data-view-target]").forEach((button) => {
    const active = button.dataset.viewTarget === resolvedView;
    button.classList.toggle("active", active);
    if (button.classList.contains("nav-item")) {
      button.toggleAttribute("aria-current", active);
    }
  });

  const railItem = document.querySelector(`.nav-item[data-view-target="${resolvedView}"]`);
  if (railItem) {
    const allItems = [...document.querySelectorAll(".nav-item")];
    const index = allItems.indexOf(railItem);
    elements.indicator.style.transform = `translateY(${index * 48}px)`;
  }

  const headings = {
    dashboard: "总览",
    users: "用户",
    services: "服务",
    policies: "策略",
    operations: "运维",
    system: "系统",
    "not-found": "未找到"
  };
  document.title = `${headings[resolvedView]} · RayLink`;
  if (updateHash) {
    history.pushState({ view: resolvedView }, "", `#/${resolvedView}`);
  } else if (normalizedView !== viewName) {
    history.replaceState({ view: normalizedView }, "", `#/${normalizedView}`);
  }
  elements.rail.classList.remove("open");
  elements.rail.toggleAttribute("inert", window.innerWidth <= 920);
  elements.menuToggle.setAttribute("aria-expanded", "false");
  window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function showToast(title, message) {
  clearTimeout(toastTimer);
  elements.toastTitle.textContent = title;
  elements.toastMessage.textContent = message;
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 3200);
}

function openDrawer({ title, eyebrow, content, saveLabel = "保存更改" }) {
  lastFocusedElement = document.activeElement;
  elements.drawerTitle.textContent = title;
  elements.drawerEyebrow.textContent = eyebrow;
  elements.drawerContent.innerHTML = content;
  elements.drawerSave.textContent = saveLabel;
  elements.drawer.classList.add("open");
  elements.drawerScrim.classList.add("open");
  elements.drawer.setAttribute("aria-hidden", "false");
  elements.drawer.removeAttribute("inert");
  document.body.style.overflow = "hidden";
  setTimeout(() => elements.drawerClose.focus(), 50);
}

function closeDrawer() {
  elements.drawer.classList.remove("open");
  elements.drawerScrim.classList.remove("open");
  elements.drawer.setAttribute("aria-hidden", "true");
  elements.drawer.setAttribute("inert", "");
  document.body.style.overflow = "";
  lastFocusedElement?.focus();
}

function userDrawerMarkup(user = {}) {
  const isNew = !user.id;
  const selectedNodeGroup = user.nodeScope?.length ? scopeToLabel(user.nodeScope) : "全部节点";
  const currentHostRegion = controlPlane.hosts[0]?.region;
  const standardNodeGroups = [
    selectedNodeGroup,
    "全部节点",
    currentHostRegion ? scopeToLabel([currentHostRegion]) : null,
    "东京 + 新加坡"
  ].filter(Boolean);
  const nodeGroupOptions = [...new Set(standardNodeGroups)]
    .map((nodeGroup) => `<option ${nodeGroup === selectedNodeGroup ? "selected" : ""}>${escapeHtml(nodeGroup)}</option>`)
    .join("");
  const capabilityRows = Object.entries(clientCatalog).map(([capabilityId, client]) => {
    const available = capabilityId === "sing-box";
    const selected = user.clients?.includes(capabilityId) || (isNew && available);
    return `
      <div class="switch-row"><div><strong>${client.name}</strong><small>${available ? client.platforms : `${client.platforms} · 即将支持`}</small></div><button type="button" class="switch ${selected ? "on" : ""}" data-capability="${capabilityId}" role="switch" aria-checked="${selected}" ${available ? "" : "disabled"}></button></div>`;
  }).join("");
  return `
    <form class="drawer-form" id="user-drawer-form" data-user-id="${escapeHtml(user.id || "")}">
      <div class="drawer-profile">
        <span class="avatar">${escapeHtml(user.initials || "新")}</span>
        <div><strong>${escapeHtml(user.name || "新用户")}</strong><small>${isNew ? "一次完成账号与权益设置" : escapeHtml(user.email)}</small></div>
      </div>
      <p class="drawer-section-label">基本信息</p>
      <label class="field"><span>显示名称</span><input name="name" value="${escapeHtml(user.name || "")}" placeholder="例如：徐清扬" required><small class="field-error"></small></label>
      <label class="field"><span>邮箱</span><input name="email" type="email" value="${escapeHtml(user.email || "")}" placeholder="name@company.com" required><small class="field-error"></small></label>
      ${isNew ? '<label class="field"><span>初始密码</span><input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="至少 8 位" required><small class="field-error"></small></label>' : ""}
      ${isNew ? "" : '<label class="field"><span>重置密码（可选）</span><input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="留空则保持不变"><small class="field-error"></small></label>'}
      <label class="field"><span>到期时间</span><input name="expires" type="date" value="${escapeHtml(user.expires || "2026-12-31")}" required><small class="field-error"></small></label>
      <label class="field"><span>已用流量</span><input name="usedGb" type="number" min="0" step="0.1" value="${Number(user.used || 0).toFixed(1)}" required><small class="field-error"></small><small class="field-hint">可由管理员或外部采集器通过用户更新 API 写回</small></label>
      <p class="drawer-section-label">用户权益</p>
      <label class="field"><span>流量额度（GB）</span><input name="quota" type="number" min="1" step="1" value="${Number(user.quota || 120)}" required><small class="field-error"></small></label>
      <label class="field"><span>节点范围</span><select name="nodeGroup">${nodeGroupOptions}</select><small class="field-hint">该用户只能获取所选区域的客户端配置</small></label>
      <p class="drawer-section-label">客户端能力</p>
      ${capabilityRows}
      <p class="drawer-section-label">账号状态</p>
      <div class="switch-row"><div><strong>启用账号</strong><small>允许登录用户中心并使用自己的流量、节点与客户端权益</small></div><button type="button" class="switch ${user.state !== "disabled" ? "on" : ""}" data-user-enabled role="switch" aria-checked="${user.state !== "disabled"}"></button></div>
      <div class="switch-row"><div><strong>${isNew ? "创建后激活用户中心" : "允许登录用户中心"}</strong><small>登录账号使用当前邮箱，密码与 Runtime 凭据相互独立</small></div><button type="button" class="switch ${isNew || user.portalStatus === "active" ? "on" : ""}" data-portal-enabled role="switch" aria-checked="${isNew || user.portalStatus === "active"}"></button></div>
    </form>`;
}

function openUser(email) {
  const user = users.find((item) => item.email === email);
  if (!user) return;
  openDrawer({ title: user.name, eyebrow: "用户详情", content: userDrawerMarkup(user) });
}

function openNewUser() {
  openDrawer({ title: "新建用户", eyebrow: "访问控制", content: userDrawerMarkup(), saveLabel: "创建用户" });
}

function hostDrawerMarkup(hostId) {
  const host = controlPlane.hosts.find((item) => item.id === hostId);
  const isRemote = host.kind === "remote";
  const runtimeCopy = isRemote
    ? `${host.status === "online" ? "在线" : host.status === "pending" ? "等待接入" : "需要检查"} · ${host.runtimeVersion || host.agentVersion || "尚未上报版本"}`
    : `${controlPlane.runtime?.mode || "dry-run"} · ${controlPlane.runtime?.configPath || "尚未生成配置"}`;
  return `
    <form class="drawer-form" id="host-drawer-form" data-host-id="${escapeHtml(host.id)}">
      <div class="drawer-profile"><span class="avatar">${escapeHtml(host.name.slice(0, 1))}</span><div><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}</small></div></div>
      <p class="drawer-section-label">主机连接</p>
      <label class="field"><span>名称</span><input name="hostname" value="${escapeHtml(host.name)}" placeholder="例如：东京生产节点" required></label>
      <label class="field"><span>公网 IP 或域名</span><input name="address" value="${escapeHtml(host.address)}" placeholder="node.example.com" required></label>
      <label class="field"><span>区域标识</span><input name="region" value="${escapeHtml(host.region)}" pattern="[A-Za-z0-9-]{2,32}" placeholder="tokyo" required></label>
      <p class="drawer-section-label">sing-box 入口</p>
      <div class="switch-row"><div><strong>Shadowsocks 2022</strong><small>端口由服务端环境变量统一设置；保存后用户配置立即使用新地址</small></div><span class="status-badge good"><i></i>已启用</span></div>
      <div class="switch-row"><div><strong>${isRemote ? "RayLink Node" : "Runtime 模式"}</strong><small>${escapeHtml(runtimeCopy)}</small></div><span class="status-badge neutral"><i></i>${escapeHtml(isRemote ? host.status : controlPlane.runtime?.state || "unknown")}</span></div>
      ${isRemote && !host.enrolledAt
        ? `<button type="button" class="button secondary" data-reissue-host="${escapeHtml(host.id)}">${icon("refresh")}重新生成接入命令</button><p class="field-hint">新的接入令牌会立即替换之前的令牌。</p>`
        : ""}
    </form>`;
}

function openHost(hostId) {
  const host = controlPlane.hosts.find((item) => item.id === hostId) || controlPlane.hosts[0];
  if (!host) return;
  openDrawer({
    title: host.name,
    eyebrow: "Runtime 主机",
    content: hostDrawerMarkup(host.id),
    saveLabel: "保存主机"
  });
}

function newHostDrawerMarkup() {
  return `
    <form class="drawer-form" id="new-host-drawer-form">
      <div class="drawer-profile"><span class="avatar">+</span><div><strong>添加第二台 VPS</strong><small>创建一次性接入令牌并安装 RayLink Node</small></div></div>
      <p class="drawer-section-label">节点信息</p>
      <label class="field"><span>名称</span><input name="hostname" placeholder="例如：法兰克福 02" required><small class="field-error"></small></label>
      <label class="field"><span>公网 IP 或域名</span><input name="address" placeholder="node-frankfurt.example.com" required><small class="field-error"></small><small class="field-hint">将写入用户客户端配置，请填写用户可访问的公网地址。</small></label>
      <label class="field"><span>区域标识</span><input name="region" pattern="[A-Za-z0-9-]{2,32}" placeholder="frankfurt" required><small class="field-error"></small><small class="field-hint">用户的“节点范围”会按此标识决定是否获得该节点。</small></label>
      <p class="drawer-section-label">接入过程</p>
      <div class="switch-row"><div><strong>1. 创建节点</strong><small>控制面生成仅可使用一次的接入令牌</small></div><span class="tag">当前步骤</span></div>
      <div class="switch-row"><div><strong>2. VPS 执行命令</strong><small>自动安装 sing-box 与 RayLink Node</small></div><span class="tag">下一步</span></div>
      <div class="switch-row"><div><strong>3. 自动上线</strong><small>节点心跳后即可接收发布配置</small></div><span class="tag">自动</span></div>
    </form>`;
}

function openNewHost() {
  openDrawer({
    title: "添加主机",
    eyebrow: "多节点接入",
    content: newHostDrawerMarkup(),
    saveLabel: "创建并生成命令"
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function enrollmentResultMarkup(created) {
  const origin = location.origin;
  const installUrl = `${origin}/node/install.sh`;
  const command = `curl -fsSL ${shellQuote(installUrl)} | sudo env RAYLINK_SERVER=${shellQuote(origin)} RAYLINK_ENROLL_TOKEN=${shellQuote(created.enrollmentToken)} bash`;
  const localOrigin = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  return `
    <div class="drawer-form">
      <div class="drawer-profile"><span class="avatar">${escapeHtml(created.host.name.slice(0, 1))}</span><div><strong>${escapeHtml(created.host.name)} 已创建</strong><small>${escapeHtml(created.host.address)} · 等待 RayLink Node 接入</small></div></div>
      <p class="drawer-section-label">在新 VPS 上执行</p>
      <pre class="advanced-preview"><code id="node-enrollment-command">${escapeHtml(command)}</code></pre>
      <button type="button" class="button secondary" data-copy-target="node-enrollment-command">${icon("copy")}复制安装命令</button>
      <p class="field-hint">${localOrigin
        ? "当前控制面地址是本机地址，远程 VPS 无法访问。正式使用时请从具有公网 HTTPS 域名的 RayLink 控制面生成命令。"
        : "令牌仅可注册一次；节点成功接入后会自动失效。安装程序会校验 Node.js 安装包并配置 systemd 自启动。"
      }</p>
      <p class="drawer-section-label">上线判定</p>
      <div class="switch-row"><div><strong>等待首次心跳</strong><small>执行命令后刷新页面；状态变为“在线”即完成。</small></div><span class="status-badge neutral"><i></i>等待接入</span></div>
    </div>`;
}

function protocolDrawerMarkup(type) {
  const protocol = controlPlane.protocolCatalog.find((item) => item.type === type);
  const profile = controlPlane.protocols.find((item) => item.type === type);
  const tlsModes = [
    ["none", "不启用 TLS"],
    ["certificate", "证书 TLS"],
    ...(protocol.realityAvailable ? [["reality", "Reality"]] : [])
  ];
  const transportOptions = [
    "none",
    "ws",
    "http",
    ...(protocol.quicTransportAvailable ? ["quic"] : []),
    "grpc",
    "httpupgrade"
  ];
  return `
    <form class="drawer-form" id="protocol-drawer-form" data-protocol-type="${escapeHtml(type)}">
      <div class="drawer-profile">
        <span class="avatar">${escapeHtml(type.slice(0, 2).toUpperCase())}</span>
        <div><strong>${escapeHtml(protocol.name)}</strong><small>${escapeHtml(protocol.description)}</small></div>
        <span class="status-badge ${profile.enabled ? "good" : "neutral"}"><i></i>${profile.enabled ? "已启用" : "未启用"}</span>
      </div>
      <div class="switch-row">
        <div><strong>启用此入站</strong><small>保存后进入草稿，点击“配置发布”才会写入 Runtime。</small></div>
        <button type="button" class="switch ${profile.enabled ? "on" : ""}" data-protocol-enabled role="switch" aria-checked="${profile.enabled}"></button>
      </div>
      <p class="drawer-section-label">监听设置</p>
      <label class="field"><span>监听地址</span><input name="listen" value="${escapeHtml(profile.listen)}" required><small class="field-hint">公网服务通常使用 ::，仅本机使用 127.0.0.1。</small></label>
      ${protocol.portless ? "" : `<label class="field"><span>监听端口</span><input name="port" type="number" min="1" max="65535" value="${profile.port}" required><small class="field-error"></small></label>`}
      ${protocol.tls === "none" || protocol.tls === "external" ? "" : `
        <p class="drawer-section-label">TLS 与 Reality</p>
        <label class="field"><span>TLS 模式</span><select name="tlsMode">${tlsModes.map(([value, label]) => `<option value="${value}" ${profile.tls.mode === value ? "selected" : ""}>${label}</option>`).join("")}</select><small class="field-hint">${protocol.tls === "required" ? "此协议启用时必须选择证书 TLS 或 Reality。" : "可按部署环境选配。"}</small></label>
        <label class="field"><span>服务器名称（SNI）</span><input name="serverName" value="${escapeHtml(profile.tls.serverName)}" placeholder="node.example.com"></label>
        <div class="quota-input">
          <label class="field"><span>证书路径</span><input name="certificatePath" value="${escapeHtml(profile.tls.certificatePath)}" placeholder="/etc/letsencrypt/live/node/fullchain.pem"></label>
          <label class="field"><span>私钥路径</span><input name="keyPath" value="${escapeHtml(profile.tls.keyPath)}" placeholder="/etc/letsencrypt/live/node/privkey.pem"></label>
        </div>
        ${protocol.realityAvailable ? `
          <div class="protocol-subsection">
            <div class="protocol-subsection-heading"><div><strong>Reality 参数</strong><small>密钥由本机 sing-box 生成。</small></div><button class="button secondary" type="button" data-generate-reality>生成密钥对</button></div>
            <div class="quota-input">
              <label class="field"><span>握手服务器</span><input name="handshakeServer" value="${escapeHtml(profile.tls.handshakeServer)}" placeholder="www.example.com"></label>
              <label class="field"><span>握手端口</span><input name="handshakePort" type="number" min="1" max="65535" value="${profile.tls.handshakePort || 443}"></label>
            </div>
            <label class="field"><span>Reality Private Key</span><input name="privateKey" value="${escapeHtml(profile.tls.privateKey)}" autocomplete="off"></label>
            <label class="field"><span>Reality Public Key</span><input name="publicKey" value="${escapeHtml(profile.tls.publicKey)}" autocomplete="off"></label>
            <label class="field"><span>Short ID</span><input name="shortId" value="${escapeHtml(profile.tls.shortId)}" placeholder="6ba85179e30d4fc2"></label>
          </div>` : ""}
      `}
      ${protocol.transports ? `
        <p class="drawer-section-label">V2Ray Transport</p>
        <label class="field"><span>传输方式</span><select name="transportType">${transportOptions.map((value) => `<option value="${value}" ${profile.transport.type === value ? "selected" : ""}>${value === "none" ? "原生 TCP" : value}</option>`).join("")}</select></label>
        <label class="field"><span>HTTP / WS / HTTPUpgrade 路径</span><input name="transportPath" value="${escapeHtml(profile.transport.path)}" placeholder="/raylink"><small class="field-hint">QUIC 不使用路径；选择 gRPC 时填写下方 Service Name。</small></label>
        <label class="field"><span>gRPC Service Name</span><input name="transportServiceName" value="${escapeHtml(profile.transport.serviceName)}" placeholder="raylink"></label>` : ""}
      ${type === "hysteria" ? `
        <p class="drawer-section-label">Hysteria 带宽</p>
        <div class="quota-input">
          <label class="field"><span>上传速率（Mbps）</span><input name="upMbps" type="number" min="1" value="${profile.options.up_mbps || 100}" required></label>
          <label class="field"><span>下载速率（Mbps）</span><input name="downMbps" type="number" min="1" value="${profile.options.down_mbps || 100}" required></label>
        </div>` : ""}
      <p class="drawer-section-label">高级选项</p>
      <label class="field"><span>附加 JSON 字段</span><textarea name="options" rows="7" spellcheck="false">${escapeHtml(JSON.stringify(profile.options, null, 2))}</textarea><small class="field-hint">字段会合并进该 inbound；type、tag、监听、用户、TLS 和 Transport 由 RayLink 管理，不能在此覆盖。</small><small class="field-error"></small></label>
      <div class="source-note"><span>能力来源：sing-box ${escapeHtml(controlPlane.installation?.version || "未安装")}</span><a href="${escapeHtml(protocol.docsUrl)}" target="_blank" rel="noreferrer">查看官方字段 ↗</a></div>
    </form>`;
}

function openProtocol(type) {
  const protocol = controlPlane.protocolCatalog.find((item) => item.type === type);
  if (!protocol) return;
  openDrawer({
    title: protocol.name,
    eyebrow: "入站协议配置",
    content: protocolDrawerMarkup(type),
    saveLabel: "保存协议"
  });
}

function portalLoginMarkup() {
  return `
    <form class="drawer-form portal-login-form" id="portal-login-form">
      <div class="drawer-profile">
        <span class="brand-mark">R/</span>
        <div><strong>登录 RayLink 用户中心</strong><small>使用管理员为你创建的账号</small></div>
      </div>
      <label class="field"><span>登录邮箱</span><input name="portalEmail" type="email" value="priya@vantage-bioworks.in" required><small class="field-error"></small></label>
      <label class="field"><span>密码</span><input name="portalPassword" type="password" autocomplete="current-password" required><small class="field-error"></small></label>
      <div class="portal-login-help"><svg><use href="#i-shield"/></svg><span><strong>账号由管理员开通</strong><small>首次登录邀请和密码重置邮件发送到用户邮箱。</small></span></div>
    </form>`;
}

function portalHomeMarkup() {
  const profile = controlPlane.portalProfile;
  const user = profile.user;
  const entitlement = profile.entitlement;
  const clientEntries = entitlement.clientFormats.map((clientId) => {
    const client = clientCatalog[clientId];
    if (!client) return "";
    const available = clientId === "sing-box";
    return `<button type="button" ${available ? 'data-client-import="sing-box"' : "disabled"}><span><strong>${client.name}</strong><small>${client.platforms}</small></span><span>${available ? "下载配置" : "即将支持"}</span></button>`;
  }).join("");
  return `
    <div class="portal-home">
      <div class="drawer-profile">
        <span class="avatar">${escapeHtml(user.initials)}</span>
        <div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.email)}</small></div>
        <span class="status-badge good"><i></i>账号正常</span>
      </div>
      <div class="portal-entitlement">
        <p class="drawer-section-label">当前用户权益</p>
        <h3>${escapeHtml(user.name)} 的访问权益</h3>
        <p>流量、节点和客户端能力由管理员为当前账号单独设置。</p>
        <div class="entitlement-preview"><span><small>剩余流量</small><strong>${Math.max(0, entitlement.quotaGb - user.usedGb).toFixed(1)} GB</strong></span><span><small>节点范围</small><strong>${escapeHtml(scopeToLabel(entitlement.nodeScope))}</strong></span></div>
      </div>
      <p class="drawer-section-label">选择客户端</p>
      <div class="portal-client-list">
        ${clientEntries}
      </div>
      <p class="portal-note">用户中心根据当前账号权益准备客户端配置。用户无需查看或编辑底层协议参数。</p>
    </div>`;
}

function openPortal() {
  openDrawer({
    title: "用户中心",
    eyebrow: "登录预览",
    content: portalLoginMarkup(),
    saveLabel: "登录并查看"
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  showToast("已复制", "用户中心入口已复制到剪贴板。");
}

async function downloadPortalConfig() {
  try {
    const response = await fetch("/api/portal/config/sing-box");
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body?.error?.message || "配置生成失败");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "raylink-sing-box.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast("配置已下载", "将 JSON 配置导入 sing-box 客户端即可使用。");
  } catch (error) {
    showToast("下载失败", error.message);
  }
}

function validateDrawerForm(form) {
  let valid = true;
  form.querySelectorAll(".field-error").forEach((error) => error.classList.remove("visible"));
  form.querySelectorAll("[required]").forEach((input) => {
    if (input.checkValidity()) return;
    const error = input.closest(".field")?.querySelector(".field-error");
    if (error) {
      error.textContent = input.validity.typeMismatch
        ? "请输入有效的邮箱地址"
        : input.validity.rangeUnderflow
          ? `数值必须大于或等于 ${input.min}`
          : "此项不能为空";
      error.classList.add("visible");
    }
    valid = false;
  });
  if (!valid) form.querySelector(":invalid")?.focus();
  return valid;
}

async function saveUserForm(form) {
  const userId = form.dataset.userId;
  const name = form.elements.name.value.trim();
  const email = form.elements.email.value.trim();
  const enabledClients = [...form.querySelectorAll(".switch[data-capability].on")]
    .map((button) => button.dataset.capability);
  const payload = {
    name,
    email,
    quotaGb: Number(form.elements.quota.value),
    nodeScope: labelToScope(form.elements.nodeGroup.value),
    clientFormats: enabledClients,
    expiresAt: form.elements.expires.value,
    usedGb: Number(form.elements.usedGb.value),
    state: form.querySelector("[data-user-enabled]").classList.contains("on") ? "active" : "disabled",
    portalStatus: form.querySelector("[data-portal-enabled]").classList.contains("on") ? "active" : "invited"
  };
  if (form.elements.password.value) payload.password = form.elements.password.value;
  await api(userId ? `/api/users/${encodeURIComponent(userId)}` : "/api/users", {
    method: userId ? "PATCH" : "POST",
    body: JSON.stringify(payload)
  });
  await loadBootstrap();
}

async function saveHostForm(form) {
  const hostId = form.dataset.hostId;
  await api(`/api/hosts/${encodeURIComponent(hostId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: form.elements.hostname.value.trim(),
      address: form.elements.address.value.trim(),
      region: form.elements.region.value.trim()
    })
  });
  await loadBootstrap();
}

async function saveNewHostForm(form) {
  return api("/api/hosts", {
    method: "POST",
    body: JSON.stringify({
      name: form.elements.hostname.value.trim(),
      address: form.elements.address.value.trim(),
      region: form.elements.region.value.trim()
    })
  });
}

async function saveProtocolForm(form) {
  let advancedOptions;
  try {
    advancedOptions = JSON.parse(form.elements.options.value || "{}");
  } catch {
    const error = new Error("附加 JSON 不是有效对象");
    error.code = "INVALID_PROTOCOL_JSON";
    throw error;
  }
  if (!advancedOptions || Array.isArray(advancedOptions) || typeof advancedOptions !== "object") {
    throw new Error("附加 JSON 必须是对象");
  }
  const protocol = controlPlane.protocolCatalog.find((item) => item.type === form.dataset.protocolType);
  const fieldValue = (name, fallback = "") => form.elements[name]?.value?.trim() ?? fallback;
  if (protocol.type === "hysteria") {
    advancedOptions = {
      ...advancedOptions,
      up_mbps: Number(fieldValue("upMbps", "100")),
      down_mbps: Number(fieldValue("downMbps", "100"))
    };
  }
  await api(`/api/runtime/protocols/${encodeURIComponent(form.dataset.protocolType)}`, {
    method: "PATCH",
    body: JSON.stringify({
      enabled: form.querySelector("[data-protocol-enabled]").classList.contains("on"),
      listen: fieldValue("listen", "::"),
      port: protocol.portless ? null : Number(fieldValue("port")),
      tls: {
        mode: fieldValue("tlsMode", "none"),
        serverName: fieldValue("serverName"),
        certificatePath: fieldValue("certificatePath"),
        keyPath: fieldValue("keyPath"),
        handshakeServer: fieldValue("handshakeServer"),
        handshakePort: Number(fieldValue("handshakePort", "443")),
        privateKey: fieldValue("privateKey"),
        publicKey: fieldValue("publicKey"),
        shortId: fieldValue("shortId")
      },
      transport: {
        type: fieldValue("transportType", "none"),
        path: fieldValue("transportPath"),
        serviceName: fieldValue("transportServiceName")
      },
      options: advancedOptions
    })
  });
  await loadBootstrap();
}

async function saveDrawer() {
  const form = elements.drawerContent.querySelector("form");
  if (!form) {
    closeDrawer();
    return;
  }
  if (!validateDrawerForm(form)) return;

  if (form.id === "portal-login-form") {
    const email = form.elements.portalEmail.value.trim();
    const password = form.elements.portalPassword.value;
    try {
      controlPlane.portalProfile = await api("/api/portal/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
    } catch (error) {
      const passwordError = form.elements.portalPassword.closest(".field").querySelector(".field-error");
      passwordError.textContent = error.message;
      passwordError.classList.add("visible");
      form.elements.portalPassword.focus();
      return;
    }
    const user = controlPlane.portalProfile.user;
    currentPortalUserEmail = user.email;
    elements.drawerEyebrow.textContent = "用户中心预览";
    elements.drawerTitle.textContent = "我的服务";
    elements.drawerContent.innerHTML = portalHomeMarkup();
    elements.drawerSave.textContent = "关闭预览";
    showToast("登录成功", `已进入 ${user.name} 的用户中心。`);
    return;
  }

  elements.drawerSave.disabled = true;
  const previousLabel = elements.drawerSave.textContent;
  elements.drawerSave.textContent = "保存中…";
  try {
    if (form.id === "user-drawer-form") await saveUserForm(form);
    if (form.id === "host-drawer-form") await saveHostForm(form);
    if (form.id === "new-host-drawer-form") {
      const created = await saveNewHostForm(form);
      await loadBootstrap();
      elements.drawerEyebrow.textContent = "一次性接入";
      elements.drawerTitle.textContent = "安装 RayLink Node";
      elements.drawerContent.innerHTML = enrollmentResultMarkup(created);
      elements.drawerSave.textContent = "完成";
      elements.drawerSave.disabled = false;
      showToast("主机已创建", "请在新 VPS 上执行一次性安装命令。");
      return;
    }
    if (form.id === "protocol-drawer-form") await saveProtocolForm(form);
  } catch (error) {
    showToast("保存失败", error.message);
    elements.drawerSave.disabled = false;
    elements.drawerSave.textContent = previousLabel;
    return;
  }

  const message = form?.id === "host-drawer-form"
      ? "Runtime 主机已更新，用户配置将使用新的公网地址。"
    : form?.id === "protocol-drawer-form"
      ? "协议草稿已保存，请在配置发布页校验并发布。"
    : form?.id === "user-drawer-form" && previousLabel.includes("创建")
      ? "用户已创建，独立权益已经保存。"
      : previousLabel.includes("添加")
        ? "主机连接信息已通过本地校验。"
        : "更改已经写入当前草稿。";
  closeDrawer();
  showToast("已保存", message);
  elements.drawerSave.disabled = false;
}

function handleSwitch(button) {
  const enabled = button.classList.toggle("on");
  button.setAttribute("aria-checked", String(enabled));
}

async function publishConfig() {
  if (publishInProgress) return;
  publishInProgress = true;
  const button = document.querySelector("#publish-config");
  const items = [...document.querySelectorAll("#publish-trail li")];
  const statusBadge = document.querySelector(".release-header .status-badge");
  button.disabled = true;
  button.innerHTML = `${icon("refresh")} 正在校验`;
  statusBadge.className = "status-badge warning";
  statusBadge.innerHTML = "<i></i>发布中";

  items[0].className = "done";
  items[0].querySelector("span").innerHTML = icon("check");
  try {
    const preview = await api("/api/deployments/preview", { method: "POST" });
    items[1].className = "done";
    items[1].querySelector("span").innerHTML = icon("check");
    items[2].className = "current";
    button.innerHTML = `${icon("refresh")} 写入快照`;
    showToast("校验完成", `${preview.eligibleUsers} 位有效用户，${preview.inboundCount} 个入站。`);

    const deployment = await api("/api/deployments", { method: "POST" });
    items.forEach((item) => {
      item.className = "done";
      item.querySelector("span").innerHTML = icon("check");
    });
    button.innerHTML = `${icon("check")} 已发布`;
    statusBadge.className = "status-badge good";
    statusBadge.innerHTML = "<i></i>已生效";
    document.querySelectorAll(".release-version").forEach((element) => {
      element.textContent = deployment.version;
    });
    await loadBootstrap();
    showToast("配置已生效", `${deployment.eligibleUsers} 位用户已写入 sing-box 配置。`);
  } catch (error) {
    button.innerHTML = `${icon("terminal")} 重试发布`;
    statusBadge.className = "status-badge warning";
    statusBadge.innerHTML = "<i></i>发布失败";
    showToast("发布失败", error.message);
  } finally {
    button.disabled = false;
    publishInProgress = false;
  }
}

async function rollbackConfig() {
  const button = document.querySelector("#rollback-config");
  const deploymentId = button.dataset.deploymentId;
  if (!deploymentId || publishInProgress) return;
  publishInProgress = true;
  button.disabled = true;
  button.innerHTML = `${icon("refresh")} 回滚中`;
  try {
    const deployment = await api(`/api/deployments/${encodeURIComponent(deploymentId)}/rollback`, {
      method: "POST"
    });
    await loadBootstrap();
    showToast("回滚已生效", `已从历史快照创建 ${deployment.version}。`);
  } catch (error) {
    showToast("回滚失败", error.message);
  } finally {
    publishInProgress = false;
    button.innerHTML = `${icon("rollback")} 回滚上一版本`;
    button.disabled = !button.dataset.deploymentId;
  }
}

async function installSingBox() {
  const button = document.querySelector("#install-sing-box");
  if (!button || button.disabled) return;
  button.disabled = true;
  button.innerHTML = `${icon("refresh")} 正在安装`;
  try {
    const installation = await api("/api/runtime/install", { method: "POST" });
    await loadBootstrap();
    showToast("sing-box 已安装", `当前版本 ${installation.version}，可以开始配置协议。`);
  } catch (error) {
    showToast("安装失败", error.message);
    button.disabled = false;
    button.innerHTML = `${icon("terminal")} 重试安装`;
  }
}

async function generateRealityKeypair(form) {
  const button = form.querySelector("[data-generate-reality]");
  button.disabled = true;
  button.textContent = "生成中…";
  try {
    const keypair = await api("/api/runtime/reality-keypair", { method: "POST" });
    form.elements.privateKey.value = keypair.privateKey;
    form.elements.publicKey.value = keypair.publicKey;
    if (keypair.shortId) form.elements.shortId.value = keypair.shortId;
    form.elements.tlsMode.value = "reality";
    showToast("Reality 密钥已生成", "密钥只保存在当前协议草稿中，保存后写入数据库。");
  } catch (error) {
    showToast("生成失败", error.message);
  } finally {
    button.disabled = false;
    button.textContent = "重新生成";
  }
}

function selectWorkspaceTab(kind, value) {
  const buttons = [...document.querySelectorAll(`[data-${kind}-tab]`)];
  buttons.forEach((button) => {
    const active = button.dataset[`${kind}Tab`] === value;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });

  const panels = [...document.querySelectorAll(`[data-${kind}-panel]`)];
  panels.forEach((panel) => {
    panel.hidden = panel.dataset[`${kind}Panel`] !== value;
  });

  if (kind === "service") {
    const inboundPanel = document.querySelector("#view-services .runtime-console");
    if (inboundPanel) inboundPanel.hidden = value !== "inbounds";
  }
}

function openAdvancedConfig() {
  const preview = document.querySelector("#managed-config-preview")?.textContent || "{}";
  openDrawer({
    title: "受管配置摘要",
    eyebrow: "配置 JSON",
    content: `
      <div class="advanced-drawer">
        <div class="notice-card">
          <span>${icon("shield")}</span>
          <div><strong>受管配置只读</strong><p>这里展示 RayLink 管理的核心字段。用户凭据、协议监听和发布字段由系统生成，请在对应工作区修改资源。</p></div>
        </div>
        <pre class="advanced-preview"><code>${escapeHtml(preview)}</code></pre>
        <p class="field-hint">发布前仍会执行 sing-box check，并保存不可变快照。</p>
      </div>`,
    saveLabel: "关闭"
  });
}

document.addEventListener("click", async (event) => {
  const viewButton = event.target.closest("[data-view-target]");
  if (viewButton) {
    navigate(viewButton.dataset.viewTarget);
    return;
  }

  const userButton = event.target.closest("[data-user]");
  if (userButton) {
    openUser(userButton.dataset.user);
    return;
  }

  const hostButton = event.target.closest("[data-open-host]");
  if (hostButton) {
    openHost(hostButton.dataset.openHost);
    return;
  }

  if (event.target.closest("[data-new-host]")) {
    openNewHost();
    return;
  }

  const reissueHostButton = event.target.closest("[data-reissue-host]");
  if (reissueHostButton) {
    try {
      const created = await api(
        `/api/hosts/${encodeURIComponent(reissueHostButton.dataset.reissueHost)}/enrollment-token`,
        { method: "POST" }
      );
      await loadBootstrap();
      elements.drawerEyebrow.textContent = "一次性接入";
      elements.drawerTitle.textContent = "安装 RayLink Node";
      elements.drawerContent.innerHTML = enrollmentResultMarkup(created);
      elements.drawerSave.textContent = "完成";
      showToast("接入命令已更新", "旧令牌已经失效，请使用新命令。");
    } catch (error) {
      showToast("生成失败", error.message);
    }
    return;
  }

  const protocolButton = event.target.closest("[data-protocol]");
  if (protocolButton) {
    openProtocol(protocolButton.dataset.protocol);
    return;
  }

  const serviceTab = event.target.closest("[data-service-tab]");
  if (serviceTab) {
    selectWorkspaceTab("service", serviceTab.dataset.serviceTab);
    return;
  }

  const policyTab = event.target.closest("[data-policy-tab]");
  if (policyTab) {
    selectWorkspaceTab("policy", policyTab.dataset.policyTab);
    return;
  }

  const operationTab = event.target.closest("[data-operation-tab]");
  if (operationTab) {
    selectWorkspaceTab("operation", operationTab.dataset.operationTab);
    return;
  }

  const systemTab = event.target.closest("[data-system-tab]");
  if (systemTab) {
    selectWorkspaceTab("system", systemTab.dataset.systemTab);
    return;
  }

  if (event.target.closest("[data-advanced-json]")) {
    openAdvancedConfig();
    return;
  }

  if (event.target.closest("[data-refresh-runtime]")) {
    try {
      await loadBootstrap();
      showToast("状态已刷新", "已重新读取 Runtime 与安装状态。");
    } catch (error) {
      showToast("刷新失败", error.message);
    }
    return;
  }

  if (event.target.closest("[data-run-diagnostics]")) {
    try {
      await loadBootstrap();
      renderDiagnostics();
      showToast("诊断完成", "安装、主机、协议和用户状态已重新检查。");
    } catch (error) {
      showToast("诊断失败", error.message);
    }
    return;
  }

  if (event.target.closest("#install-sing-box")) {
    await installSingBox();
    return;
  }

  const realityButton = event.target.closest("[data-generate-reality]");
  if (realityButton) {
    await generateRealityKeypair(realityButton.closest("form"));
    return;
  }

  if (event.target.closest("[data-new-user]")) {
    openNewUser();
    return;
  }

  if (event.target.closest("[data-open-portal]")) {
    openPortal();
    return;
  }

  const clientImport = event.target.closest("[data-client-import]");
  if (clientImport) {
    if (clientImport.dataset.clientImport === "sing-box") downloadPortalConfig();
    return;
  }

  if (event.target.closest("[data-send-invite]")) {
    const form = event.target.closest("#user-drawer-form");
    const user = users.find((item) => item.email === form?.dataset.originalEmail);
    if (user) {
      user.portalStatus = "invited";
      form.querySelector("[data-login-status]").textContent = "登录邀请已发送";
    }
    showToast("登录邀请已发送", "用户将通过邮箱完成首次登录或重置密码。");
    return;
  }

  const switchButton = event.target.closest(".switch");
  if (switchButton) {
    handleSwitch(switchButton);
    return;
  }

  const copyButton = event.target.closest("[data-copy-target]");
  if (copyButton) {
    const target = document.getElementById(copyButton.dataset.copyTarget);
    copyText(target.textContent.trim());
    return;
  }

  const filter = event.target.closest("[data-user-filter]");
  if (filter) {
    activeUserFilter = filter.dataset.userFilter;
    document.querySelectorAll("[data-user-filter]").forEach((button) => button.classList.toggle("active", button === filter));
    renderUsers();
    return;
  }

});

elements.userSearch.addEventListener("input", renderUsers);
elements.menuToggle.addEventListener("click", () => {
  const isOpen = elements.rail.classList.toggle("open");
  elements.menuToggle.setAttribute("aria-expanded", String(isOpen));
  elements.rail.toggleAttribute("inert", !isOpen && window.innerWidth <= 920);
});
elements.drawerClose.addEventListener("click", closeDrawer);
elements.drawerCancel.addEventListener("click", closeDrawer);
elements.drawerScrim.addEventListener("click", closeDrawer);
elements.drawerSave.addEventListener("click", saveDrawer);

document.querySelector("#publish-config").addEventListener("click", publishConfig);
document.querySelector("#rollback-config").addEventListener("click", rollbackConfig);

document.querySelector("#global-search").addEventListener("click", () => {
  navigate("users");
  setTimeout(() => elements.userSearch.focus(), 120);
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    navigate("users");
    setTimeout(() => elements.userSearch.focus(), 120);
  }
  if (event.key === "Escape") {
    if (elements.drawer.classList.contains("open")) closeDrawer();
    else {
      elements.rail.classList.remove("open");
      elements.rail.toggleAttribute("inert", window.innerWidth <= 920);
      elements.menuToggle.setAttribute("aria-expanded", "false");
    }
  }
  if (event.key === "Tab" && elements.drawer.classList.contains("open")) {
    const focusable = [...elements.drawer.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((node) => !node.disabled);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

window.addEventListener("popstate", () => {
  const route = location.hash.replace(/^#\//, "") || "dashboard";
  navigate(route, false);
});

function syncResponsiveNavigation() {
  const compact = window.innerWidth <= 920;
  if (!compact) elements.rail.classList.remove("open");
  elements.rail.toggleAttribute("inert", compact && !elements.rail.classList.contains("open"));
  elements.menuToggle.setAttribute("aria-expanded", String(elements.rail.classList.contains("open")));
}

window.addEventListener("resize", syncResponsiveNavigation);

async function enterControlPlane() {
  await loadBootstrap();
  elements.authScreen.hidden = true;
  elements.appShell.hidden = false;
  syncResponsiveNavigation();
  const initialRoute = location.hash.replace(/^#\//, "") || "dashboard";
  navigate(initialRoute, false);
}

elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.authError.textContent = "";
  const submit = elements.authForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "登录中…";
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: elements.authForm.elements.username.value.trim(),
        password: elements.authForm.elements.password.value
      })
    });
    await enterControlPlane();
  } catch (error) {
    elements.authError.textContent = error.message;
    elements.authForm.elements.password.focus();
  } finally {
    submit.disabled = false;
    submit.textContent = "登录";
  }
});

enterControlPlane().catch((error) => {
  if (error.status !== 401) elements.authError.textContent = `无法连接控制面：${error.message}`;
  elements.authScreen.hidden = false;
  elements.appShell.hidden = true;
});
