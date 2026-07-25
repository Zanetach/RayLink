const users = [];
const plans = {};

const clientCatalog = {
  "mihomo": { name: "Mihomo", platforms: "macOS / Windows / Android", action: "一键导入" },
  "sing-box": { name: "sing-box", platforms: "iOS / Android / Desktop", action: "一键导入" },
  "download": { name: "其他客户端", platforms: "下载兼容配置文件", action: "下载配置" }
};

const accountSummary = { totalUsers: 0, planAssignments: {} };

const controlPlane = {
  currentAdmin: null,
  hosts: [],
  runtime: null,
  runtimePreview: null,
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

const accountTabs = {
  "users": { route: "users", title: "用户管理", aliases: [] },
  "plans": { route: "users/plans", title: "方案管理", aliases: ["subscriptions"] }
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
  planList: document.querySelector("#plan-list"),
  hostBody: document.querySelector("#host-table-body"),
  clientEntryList: document.querySelector("#client-entry-list"),
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
let activeAccountTab = "users";
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
    planId: user.planId,
    expires: user.expiresAt
  })));
  Object.keys(plans).forEach((planId) => delete plans[planId]);
  Object.keys(accountSummary.planAssignments).forEach((planId) => delete accountSummary.planAssignments[planId]);
  data.plans.forEach((plan) => {
    plans[plan.id] = {
      name: plan.name,
      quota: plan.quotaGb,
      devices: plan.deviceLimit,
      nodeGroup: scopeToLabel(plan.nodeScope),
      clients: plan.clientFormats,
      description: plan.description,
      tone: plan.tone
    };
    accountSummary.planAssignments[plan.id] = plan.assignedUsers;
  });
  accountSummary.totalUsers = users.length;
  controlPlane.currentAdmin = data.currentAdmin;
  controlPlane.hosts = data.hosts;
  controlPlane.runtime = data.runtime;
  controlPlane.runtimePreview = data.runtimePreview;
  controlPlane.deployments = data.deployments;
  renderUsers();
  renderPlans();
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
}

function renderHosts() {
  if (!elements.hostBody) return;
  const host = controlPlane.hosts[0];
  if (!host) {
    elements.hostBody.innerHTML = '<tr><td colspan="7"><div class="empty-state">尚未配置 Runtime 主机</div></td></tr>';
    return;
  }
  const runtime = controlPlane.runtime || { state: "unknown", mode: "dry-run" };
  const healthy = ["running", "staged"].includes(runtime.state);
  elements.hostBody.innerHTML = `
    <tr>
      <td><button class="identity-link" data-open-host="${escapeHtml(host.id)}"><span class="flag">SB</span><span><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}</small></span></button></td>
      <td><span class="status-badge ${healthy ? "good" : "neutral"}"><i></i>${healthy ? "已就绪" : "待配置"}</span></td>
      <td><span class="tag">Shadowsocks 2022</span></td>
      <td class="numeric">—</td>
      <td class="numeric">—</td>
      <td>${runtime.runtimeVersion || runtime.mode}</td>
      <td><button class="icon-button small" aria-label="编辑${escapeHtml(host.name)}" data-open-host="${escapeHtml(host.id)}">${icon("more")}</button></td>
    </tr>`;
  document.querySelector("#host-map-name").textContent = host.name;
  document.querySelector("#host-map-address").textContent = `${host.address} · ${host.region}`;
  document.querySelector("#host-map-status").innerHTML = `<i></i>${healthy ? "Runtime 已就绪" : "等待首次发布"}`;
  const managedTargetName = document.querySelector("#managed-target-name");
  if (managedTargetName) managedTargetName.textContent = host.name;
  document.querySelectorAll('.nav-item[data-view-target="hosts"] .nav-count').forEach((count) => {
    count.textContent = controlPlane.hosts.length;
  });
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(`${value}T00:00:00`));
}

function renderUsers() {
  const query = elements.userSearch.value.trim().toLocaleLowerCase();
  const filtered = users.filter((user) => {
    const matchesFilter = activeUserFilter === "all" || user.state === activeUserFilter;
    const haystack = `${user.name} ${user.email} ${plans[user.planId].name}`.toLocaleLowerCase();
    return matchesFilter && haystack.includes(query);
  });

  elements.userBody.innerHTML = filtered.map((user) => {
    const status = stateLabels[user.state];
    const userPlan = plans[user.planId];
    const ratio = Math.min(100, (user.used / userPlan.quota) * 100);
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
          <div class="usage-copy"><span>${user.used.toFixed(1)} GB</span><span>${userPlan.quota} GB</span></div>
          <div class="progress ${progressClass}"><i style="width:${ratio.toFixed(1)}%"></i></div>
        </td>
        <td><span class="plan-cell"><strong>${escapeHtml(userPlan.name)}</strong><small>${userPlan.devices} 台设备</small></span></td>
        <td class="numeric">${formatDate(user.expires)}</td>
        <td><button class="icon-button small" aria-label="编辑 ${escapeHtml(user.name)}" data-user="${escapeHtml(user.email)}">${icon("more")}</button></td>
      </tr>`;
  }).join("");

  elements.userCount.textContent = `显示 ${filtered.length} / ${accountSummary.totalUsers} 位用户`;
  document.querySelector("#account-tab-users small").textContent = `${accountSummary.totalUsers} 位用户`;
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

function renderPlans() {
  if (!elements.planList) return;
  elements.planList.innerHTML = Object.entries(plans).map(([planId, plan]) => {
    const assignedUsers = accountSummary.planAssignments[planId] || 0;
    const scopeTags = plan.nodeGroup.split(" + ").map((scope) => `<span class="tag">${escapeHtml(scope === "全部节点" ? "全节点" : scope)}</span>`).join("");
    const groupCount = plan.nodeGroup === "全部节点" ? 4 : plan.nodeGroup.split(" + ").length;
    return `
      <article class="plan-row">
        <div class="plan-identity"><i class="plan-dot ${plan.tone === "standard" ? "" : escapeHtml(plan.tone)}"></i><span><strong>${escapeHtml(plan.name)}</strong><small>${escapeHtml(plan.description)}</small></span></div>
        <div class="plan-metric"><strong>${plan.quota} GB</strong><small>${plan.devices} 台设备</small></div>
        <div class="plan-scope">${scopeTags}<small>${groupCount} 个节点组</small></div>
        <div class="plan-users"><strong>${assignedUsers}</strong><small>位用户</small></div>
        <button class="icon-button small" aria-label="编辑${escapeHtml(plan.name)}方案" data-plan="${escapeHtml(planId)}">${icon("more")}</button>
      </article>`;
  }).join("");

  const totalUsage = users.reduce((sum, user) => sum + (user.used / plans[user.planId].quota), 0);
  document.querySelector("#plan-count").textContent = Object.keys(plans).length;
  document.querySelector("#assigned-user-count").textContent = accountSummary.totalUsers;
  document.querySelector("#average-plan-usage").textContent = users.length ? `${((totalUsage / users.length) * 100).toFixed(1)}%` : "0.0%";
  document.querySelector("#account-tab-plans small").textContent = `${Object.keys(plans).length} 个方案`;
}

function renderClientEntries() {
  if (!elements.clientEntryList) return;
  elements.clientEntryList.innerHTML = Object.values(clientCatalog).map((client) => `
    <button data-open-portal><span><strong>${client.name}</strong><small>${client.platforms}</small></span>${icon("arrow")}</button>`).join("");
}

function accountTabForRoute(routeName) {
  return Object.entries(accountTabs).find(([, tab]) => tab.route === routeName || tab.aliases.includes(routeName))?.[0] || null;
}

function setAccountTab(tabName, updateHash = false) {
  activeAccountTab = accountTabs[tabName] ? tabName : "users";
  const activeTabConfig = accountTabs[activeAccountTab];

  document.querySelectorAll("[data-account-tab]").forEach((button) => {
    const active = button.dataset.accountTab === activeAccountTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });

  document.querySelectorAll("[data-account-panel]").forEach((panel) => {
    const active = panel.dataset.accountPanel === activeAccountTab;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });

  document.querySelectorAll("[data-account-action]").forEach((button) => {
    button.hidden = button.dataset.accountAction !== activeAccountTab;
  });

  document.title = `${activeTabConfig.title} · RayLink`;
  if (updateHash) {
    history.pushState({ view: "users", accountTab: activeAccountTab }, "", `#/${activeTabConfig.route}`);
  }
}

function navigate(viewName, updateHash = true) {
  const requestedAccountTab = accountTabForRoute(viewName);
  const normalizedView = requestedAccountTab ? "users" : viewName;
  const target = document.querySelector(`[data-view="${normalizedView}"]`) || document.querySelector('[data-view="not-found"]');
  const resolvedView = target.dataset.view;
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view === target));
  if (resolvedView === "users") setAccountTab(requestedAccountTab || activeAccountTab);

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

  const headings = { dashboard: "仪表盘", users: accountTabs[activeAccountTab].title, hosts: "主机", deploy: "配置发布", "not-found": "未找到" };
  document.title = `${headings[resolvedView]} · RayLink`;
  if (updateHash) {
    const route = resolvedView === "users" ? accountTabs[activeAccountTab].route : resolvedView;
    history.pushState({ view: resolvedView, accountTab: activeAccountTab }, "", `#/${route}`);
  } else if (requestedAccountTab && viewName !== accountTabs[requestedAccountTab].route) {
    history.replaceState({ view: "users", accountTab: requestedAccountTab }, "", `#/${accountTabs[requestedAccountTab].route}`);
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
  const selectedPlanId = user.planId || Object.keys(plans)[0];
  const selectedPlan = plans[selectedPlanId];
  const planOptions = Object.entries(plans).map(([planId, plan]) => `<option value="${escapeHtml(planId)}" ${planId === selectedPlanId ? "selected" : ""}>${escapeHtml(plan.name)}</option>`).join("");
  return `
    <form class="drawer-form" id="user-drawer-form" data-user-id="${escapeHtml(user.id || "")}">
      <div class="drawer-profile">
        <span class="avatar">${escapeHtml(user.initials || "新")}</span>
        <div><strong>${escapeHtml(user.name || "新用户")}</strong><small>${isNew ? "尚未分配方案" : escapeHtml(user.email)}</small></div>
      </div>
      <p class="drawer-section-label">基本信息</p>
      <label class="field"><span>显示名称</span><input name="name" value="${escapeHtml(user.name || "")}" placeholder="例如：徐清扬" required><small class="field-error"></small></label>
      <label class="field"><span>邮箱</span><input name="email" type="email" value="${escapeHtml(user.email || "")}" placeholder="name@company.com" required><small class="field-error"></small></label>
      ${isNew ? '<label class="field"><span>初始密码</span><input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="至少 8 位" required><small class="field-error"></small></label>' : ""}
      ${isNew ? "" : '<label class="field"><span>重置密码（可选）</span><input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="留空则保持不变"><small class="field-error"></small></label>'}
      <label class="field"><span>到期时间</span><input name="expires" type="date" value="${escapeHtml(user.expires || "2026-12-31")}" required><small class="field-error"></small></label>
      <p class="drawer-section-label">订阅方案</p>
      <label class="field"><span>分配方案</span><select name="plan">${planOptions}</select><small class="field-hint">流量、设备数、节点和客户端能力跟随方案</small></label>
      <div class="assigned-plan-preview"><span><small>每月流量</small><strong data-plan-quota>${selectedPlan.quota} GB</strong></span><span><small>设备上限</small><strong data-plan-devices>${selectedPlan.devices} 台</strong></span><span><small>节点范围</small><strong data-plan-nodes>${escapeHtml(selectedPlan.nodeGroup)}</strong></span></div>
      <p class="drawer-section-label">账号状态</p>
      <div class="switch-row"><div><strong>启用账号</strong><small>允许登录用户中心并使用已分配方案</small></div><button type="button" class="switch ${user.state !== "disabled" ? "on" : ""}" data-user-enabled role="switch" aria-checked="${user.state !== "disabled"}"></button></div>
      <div class="switch-row"><div><strong>允许客户端同步</strong><small>客户端按方案自动获取最新配置</small></div><button type="button" class="switch on" role="switch" aria-checked="true"></button></div>
      <div class="switch-row"><div><strong>${isNew ? "创建后激活用户中心" : "允许登录用户中心"}</strong><small>登录账号使用当前邮箱，密码与 Runtime 凭据相互独立</small></div><button type="button" class="switch ${isNew || user.portalStatus === "active" ? "on" : ""}" data-portal-enabled role="switch" aria-checked="${isNew || user.portalStatus === "active"}"></button></div>
    </form>`;
}

function openUser(email) {
  const user = users.find((item) => item.email === email);
  if (!user) return;
  openDrawer({ title: user.name, eyebrow: "用户详情", content: userDrawerMarkup(user) });
}

function openNewUser() {
  openDrawer({ title: "新建用户", eyebrow: "访问控制", content: userDrawerMarkup(), saveLabel: "创建并分配方案" });
}

function planDrawerMarkup(planId) {
  const plan = plans[planId];
  const isNew = !plan;
  const assignedUsers = accountSummary.planAssignments[planId] || 0;
  const capabilityRows = Object.entries(clientCatalog).map(([capabilityId, client]) => {
    const available = capabilityId === "sing-box";
    const selected = available && (plan?.clients.includes(capabilityId) || isNew);
    return `
      <div class="switch-row"><div><strong>${client.name}</strong><small>${available ? client.platforms : `${client.platforms} · 即将支持`}</small></div><button type="button" class="switch ${selected ? "on" : ""}" data-capability="${capabilityId}" role="switch" aria-checked="${selected}" ${available ? "" : "disabled"}></button></div>`;
  }).join("");
  return `
    <form class="drawer-form" id="plan-drawer-form" data-plan-id="${escapeHtml(isNew ? "" : planId)}">
      <p class="drawer-section-label">方案信息</p>
      ${isNew ? '<label class="field"><span>方案 ID</span><input name="planId" pattern="[a-z0-9][a-z0-9-]{1,31}" placeholder="regional-office" required><small class="field-error"></small><small class="field-hint">2–32 位小写字母、数字或连字符，创建后不可更改</small></label>' : ""}
      <label class="field"><span>方案名称</span><input name="planName" value="${escapeHtml(plan?.name || "")}" placeholder="例如：区域办公" required><small class="field-error"></small></label>
      <label class="field"><span>适用场景</span><input name="description" value="${escapeHtml(plan?.description || "")}" placeholder="例如：适合区域办公室日常使用"></label>
      <div class="quota-input">
        <label class="field"><span>每月流量</span><input name="quota" type="number" min="1" value="${plan?.quota || 120}" required><small class="field-error"></small></label>
        <label class="field"><span>设备上限</span><input name="devices" type="number" min="1" value="${plan?.devices || 3}" required><small class="field-error"></small></label>
      </div>
      <label class="field"><span>节点范围</span><select name="nodeGroup"><option ${plan?.nodeGroup === "东京 + 新加坡" ? "selected" : ""}>东京 + 新加坡</option><option ${plan?.nodeGroup === "全部节点" ? "selected" : ""}>全部节点</option><option ${plan?.nodeGroup === "东京" ? "selected" : ""}>东京</option></select></label>
      <p class="drawer-section-label">客户端能力</p>
      ${capabilityRows}
      ${isNew ? "" : `<p class="drawer-section-label">分配情况</p><div class="switch-row"><div><strong>${assignedUsers} 位用户</strong><small>修改后同步影响所有已分配用户</small></div><span class="status-badge good"><i></i>使用中</span></div>`}
    </form>`;
}

function openPlan(planId) {
  const isNew = planId === "new";
  const plan = plans[planId];
  openDrawer({
    title: isNew ? "新建订阅方案" : plan.name,
    eyebrow: "服务策略",
    content: planDrawerMarkup(planId),
    saveLabel: isNew ? "创建方案" : "保存方案"
  });
}

function hostDrawerMarkup(hostId) {
  const host = controlPlane.hosts.find((item) => item.id === hostId);
  return `
    <form class="drawer-form" id="host-drawer-form" data-host-id="${escapeHtml(host.id)}">
      <div class="drawer-profile"><span class="avatar">${escapeHtml(host.name.slice(0, 1))}</span><div><strong>${escapeHtml(host.name)}</strong><small>${escapeHtml(host.address)} · ${escapeHtml(host.region)}</small></div></div>
      <p class="drawer-section-label">主机连接</p>
      <label class="field"><span>名称</span><input name="hostname" value="${escapeHtml(host.name)}" placeholder="例如：东京生产节点" required></label>
      <label class="field"><span>公网 IP 或域名</span><input name="address" value="${escapeHtml(host.address)}" placeholder="node.example.com" required></label>
      <label class="field"><span>区域标识</span><input name="region" value="${escapeHtml(host.region)}" pattern="[A-Za-z0-9-]{2,32}" placeholder="tokyo" required></label>
      <p class="drawer-section-label">sing-box 入口</p>
      <div class="switch-row"><div><strong>Shadowsocks 2022</strong><small>端口由服务端环境变量统一设置；保存后用户配置立即使用新地址</small></div><span class="status-badge good"><i></i>已启用</span></div>
      <div class="switch-row"><div><strong>Runtime 模式</strong><small>${controlPlane.runtime?.mode || "dry-run"} · ${controlPlane.runtime?.configPath || "尚未生成配置"}</small></div><span class="status-badge neutral"><i></i>${controlPlane.runtime?.state || "unknown"}</span></div>
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
  const plan = profile.plan;
  const clientEntries = plan.clientFormats.map((clientId) => {
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
        <p class="drawer-section-label">当前订阅方案</p>
        <h3>${escapeHtml(plan.name)}</h3>
        <p>${escapeHtml(plan.description)}</p>
        <div class="assigned-plan-preview"><span><small>剩余流量</small><strong>${Math.max(0, plan.quotaGb - user.usedGb).toFixed(1)} GB</strong></span><span><small>设备上限</small><strong>${plan.deviceLimit} 台</strong></span><span><small>节点范围</small><strong>${escapeHtml(scopeToLabel(plan.nodeScope))}</strong></span></div>
      </div>
      <p class="drawer-section-label">选择客户端</p>
      <div class="portal-client-list">
        ${clientEntries}
      </div>
      <p class="portal-note">用户中心根据当前方案准备客户端配置。用户无需查看或编辑底层协议参数。</p>
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
  const planId = form.elements.plan.value;
  const payload = {
    name,
    email,
    planId,
    expiresAt: form.elements.expires.value,
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

async function savePlanForm(form) {
  const existingPlanId = form.dataset.planId;
  const planId = existingPlanId || form.elements.planId.value.trim();
  const name = form.elements.planName.value.trim();
  const enabledClients = [...form.querySelectorAll(".switch[data-capability].on")].map((button) => button.dataset.capability);
  if (!enabledClients.length) {
    const error = new Error("至少启用一种客户端格式");
    error.code = "INVALID_CLIENT_FORMATS";
    throw error;
  }
  const payload = {
    ...(existingPlanId ? {} : { id: planId }),
    name,
    quotaGb: Number(form.elements.quota.value),
    deviceLimit: Number(form.elements.devices.value),
    nodeScope: labelToScope(form.elements.nodeGroup.value),
    clientFormats: enabledClients,
    description: form.elements.description.value.trim() || "自定义服务方案",
    tone: plans[planId]?.tone || "standard"
  };
  await api(existingPlanId ? `/api/plans/${encodeURIComponent(existingPlanId)}` : "/api/plans", {
    method: existingPlanId ? "PATCH" : "POST",
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
    if (form.id === "plan-drawer-form") await savePlanForm(form);
    if (form.id === "host-drawer-form") await saveHostForm(form);
  } catch (error) {
    showToast("保存失败", error.message);
    elements.drawerSave.disabled = false;
    elements.drawerSave.textContent = previousLabel;
    return;
  }

  const message = form?.id === "plan-drawer-form"
    ? "方案设置已保存，关联用户将在下次同步时更新。"
    : form?.id === "host-drawer-form"
      ? "Runtime 主机已更新，用户配置将使用新的公网地址。"
    : form?.id === "user-drawer-form" && previousLabel.includes("创建")
      ? "用户已创建并分配订阅方案。"
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

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view-target]");
  if (viewButton) {
    navigate(viewButton.dataset.viewTarget);
    return;
  }

  const accountTab = event.target.closest("[data-account-tab]");
  if (accountTab) {
    setAccountTab(accountTab.dataset.accountTab, true);
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

  const planButton = event.target.closest("[data-plan]");
  if (planButton) {
    openPlan(planButton.dataset.plan);
    return;
  }

  if (event.target.closest("[data-new-user]")) {
    openNewUser();
    return;
  }

  if (event.target.closest("[data-new-plan]")) {
    openPlan("new");
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

document.addEventListener("change", (event) => {
  if (!event.target.matches('#user-drawer-form select[name="plan"]')) return;
  const selectedPlan = plans[event.target.value];
  const form = event.target.closest("form");
  form.querySelector("[data-plan-quota]").textContent = `${selectedPlan.quota} GB`;
  form.querySelector("[data-plan-devices]").textContent = `${selectedPlan.devices} 台`;
  form.querySelector("[data-plan-nodes]").textContent = selectedPlan.nodeGroup;
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
  if (["ArrowLeft", "ArrowRight"].includes(event.key) && event.target.matches("[data-account-tab]")) {
    event.preventDefault();
    const nextTab = activeAccountTab === "users" ? "plans" : "users";
    setAccountTab(nextTab, true);
    document.querySelector(`[data-account-tab="${nextTab}"]`).focus();
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
  renderClientEntries();
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
