const users = [
  { name: "林知夏", initials: "LZ", email: "lin.zhixia@meridian-log.cn", password: "raylink-demo", portalStatus: "active", state: "active", used: 74.3, planId: "standard", expires: "2026-10-18" },
  { name: "岡本和也", initials: "OK", email: "k.okamoto@hokkaido-ceramics.jp", password: "raylink-demo", portalStatus: "active", state: "warning", used: 104.8, planId: "standard", expires: "2026-08-04" },
  { name: "Priya Mehta", initials: "PM", email: "priya@vantage-bioworks.in", password: "raylink-demo", portalStatus: "active", state: "active", used: 75.4, planId: "high-speed", expires: "2026-09-01" },
  { name: "Nia Okafor", initials: "NO", email: "nia@lagos-fieldworks.ng", password: "raylink-demo", portalStatus: "active", state: "active", used: 46.8, planId: "standard", expires: "2026-11-23" },
  { name: "Lars Eriksson", initials: "LE", email: "lars@nordhavn-data.se", password: "raylink-demo", portalStatus: "invited", state: "disabled", used: 18.2, planId: "temporary", expires: "2026-07-31" },
  { name: "陈望舒", initials: "CW", email: "wangshu@lingnan-studio.cn", password: "raylink-demo", portalStatus: "active", state: "warning", used: 103.7, planId: "standard", expires: "2026-08-12" }
];

const plans = {
  "standard": { name: "标准访问", quota: 120, devices: 3, nodeGroup: "东京 + 新加坡", clients: ["mihomo", "sing-box"], description: "适合日常办公和开发", tone: "standard" },
  "high-speed": { name: "高速访问", quota: 320, devices: 5, nodeGroup: "全部节点", clients: ["mihomo", "sing-box", "download"], description: "面向高流量研发团队", tone: "premium" },
  "temporary": { name: "临时访问", quota: 36, devices: 1, nodeGroup: "东京", clients: ["mihomo", "sing-box"], description: "外部协作和短期项目", tone: "temporary" }
};

const clientCatalog = {
  "mihomo": { name: "Mihomo", platforms: "macOS / Windows / Android", action: "一键导入" },
  "sing-box": { name: "sing-box", platforms: "iOS / Android / Desktop", action: "一键导入" },
  "download": { name: "其他客户端", platforms: "下载兼容配置文件", action: "下载配置" }
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
  rail: document.querySelector("#rail"),
  menuToggle: document.querySelector("#menu-toggle"),
  indicator: document.querySelector(".nav-indicator"),
  userBody: document.querySelector("#user-table-body"),
  userCount: document.querySelector("#user-result-count"),
  userSearch: document.querySelector("#user-search"),
  planList: document.querySelector("#plan-list"),
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
let toastTimer;
let lastFocusedElement;
let publishInProgress = false;
let currentPortalUserEmail = "";

function icon(name) {
  return `<svg aria-hidden="true"><use href="#i-${name}"></use></svg>`;
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
          <button class="identity-link" data-user="${user.email}">
            <span class="avatar">${user.initials}</span>
            <span><strong>${user.name}</strong><small>${user.email}</small></span>
          </button>
        </td>
        <td><span class="status-badge ${status.className}"><i></i>${status.label}</span></td>
        <td class="usage-cell">
          <div class="usage-copy"><span>${user.used.toFixed(1)} GB</span><span>${userPlan.quota} GB</span></div>
          <div class="progress ${progressClass}"><i style="width:${ratio.toFixed(1)}%"></i></div>
        </td>
        <td><span class="plan-cell"><strong>${userPlan.name}</strong><small>${userPlan.devices} 台设备</small></span></td>
        <td class="numeric">${formatDate(user.expires)}</td>
        <td><button class="icon-button small" aria-label="编辑 ${user.name}" data-user="${user.email}">${icon("more")}</button></td>
      </tr>`;
  }).join("");

  elements.userCount.textContent = `显示 ${filtered.length} / 27 位用户`;
  if (!filtered.length) {
    elements.userBody.innerHTML = `<tr><td colspan="6"><div class="empty-state">没有符合当前筛选条件的用户</div></td></tr>`;
  }
}

function renderPlans() {
  if (!elements.planList) return;
  elements.planList.innerHTML = Object.entries(plans).map(([planId, plan]) => {
    const assignedUsers = users.filter((user) => user.planId === planId).length;
    const scopeTags = plan.nodeGroup.split(" + ").map((scope) => `<span class="tag">${scope === "全部节点" ? "全节点" : scope}</span>`).join("");
    const groupCount = plan.nodeGroup === "全部节点" ? 4 : plan.nodeGroup.split(" + ").length;
    return `
      <article class="plan-row">
        <div class="plan-identity"><i class="plan-dot ${plan.tone === "standard" ? "" : plan.tone}"></i><span><strong>${plan.name}</strong><small>${plan.description}</small></span></div>
        <div class="plan-metric"><strong>${plan.quota} GB</strong><small>${plan.devices} 台设备</small></div>
        <div class="plan-scope">${scopeTags}<small>${groupCount} 个节点组</small></div>
        <div class="plan-users"><strong>${assignedUsers}</strong><small>位用户</small></div>
        <button class="icon-button small" aria-label="编辑${plan.name}方案" data-plan="${planId}">${icon("more")}</button>
      </article>`;
  }).join("");

  const totalUsage = users.reduce((sum, user) => sum + (user.used / plans[user.planId].quota), 0);
  document.querySelector("#plan-count").textContent = Object.keys(plans).length;
  document.querySelector("#assigned-user-count").textContent = users.length;
  document.querySelector("#average-plan-usage").textContent = `${((totalUsage / users.length) * 100).toFixed(1)}%`;
}

function renderClientEntries() {
  if (!elements.clientEntryList) return;
  elements.clientEntryList.innerHTML = Object.values(clientCatalog).map((client) => `
    <button data-open-portal><span><strong>${client.name}</strong><small>${client.platforms}</small></span>${icon("arrow")}</button>`).join("");
}

function navigate(viewName, updateHash = true) {
  const target = document.querySelector(`[data-view="${viewName}"]`) || document.querySelector('[data-view="not-found"]');
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

  const headings = { dashboard: "仪表盘", users: "用户", subscriptions: "订阅方案", hosts: "主机", deploy: "配置发布", "not-found": "未找到" };
  document.title = `${headings[resolvedView]} · RayLink`;
  if (updateHash) history.pushState({ view: resolvedView }, "", `#/${resolvedView}`);
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
  const isNew = !user.email;
  const selectedPlanId = user.planId || Object.keys(plans)[0];
  const selectedPlan = plans[selectedPlanId];
  const planOptions = Object.entries(plans).map(([planId, plan]) => `<option value="${planId}" ${planId === selectedPlanId ? "selected" : ""}>${plan.name}</option>`).join("");
  return `
    <form class="drawer-form" id="user-drawer-form" data-original-email="${user.email || ""}">
      <div class="drawer-profile">
        <span class="avatar">${user.initials || "新"}</span>
        <div><strong>${user.name || "新用户"}</strong><small>${isNew ? "尚未分配方案" : user.email}</small></div>
      </div>
      <p class="drawer-section-label">基本信息</p>
      <label class="field"><span>显示名称</span><input name="name" value="${user.name || ""}" placeholder="例如：徐清扬" required><small class="field-error"></small></label>
      <label class="field"><span>邮箱</span><input name="email" type="email" value="${user.email || ""}" placeholder="name@company.com" required><small class="field-error"></small></label>
      <label class="field"><span>到期时间</span><input name="expires" type="date" value="${user.expires || "2026-12-31"}" required><small class="field-error"></small></label>
      <p class="drawer-section-label">订阅方案</p>
      <label class="field"><span>分配方案</span><select name="plan">${planOptions}</select><small class="field-hint">流量、设备数、节点和客户端能力跟随方案</small></label>
      <div class="assigned-plan-preview"><span><small>每月流量</small><strong data-plan-quota>${selectedPlan.quota} GB</strong></span><span><small>设备上限</small><strong data-plan-devices>${selectedPlan.devices} 台</strong></span><span><small>节点范围</small><strong data-plan-nodes>${selectedPlan.nodeGroup}</strong></span></div>
      <p class="drawer-section-label">账号状态</p>
      <div class="switch-row"><div><strong>启用账号</strong><small>允许登录用户中心并使用已分配方案</small></div><button type="button" class="switch ${user.state !== "disabled" ? "on" : ""}" role="switch" aria-checked="${user.state !== "disabled"}"></button></div>
      <div class="switch-row"><div><strong>允许客户端同步</strong><small>客户端按方案自动获取最新配置</small></div><button type="button" class="switch on" role="switch" aria-checked="true"></button></div>
      <div class="switch-row"><div><strong data-login-status>${isNew ? "等待创建账号" : user.portalStatus === "active" ? "用户中心账号已激活" : "登录邀请已发送"}</strong><small>${isNew ? "保存用户后自动发送首次登录邀请" : "登录账号使用当前邮箱"}</small></div><button type="button" class="button secondary compact" data-send-invite ${isNew ? "disabled" : ""}>${isNew ? "创建后发送" : "重发邀请"}</button></div>
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
  const assignedUsers = users.filter((user) => user.planId === planId).length;
  const capabilityRows = Object.entries(clientCatalog).map(([capabilityId, client]) => `
    <div class="switch-row"><div><strong>${client.name}</strong><small>${client.platforms}</small></div><button type="button" class="switch ${plan?.clients.includes(capabilityId) || (isNew && capabilityId !== "download") ? "on" : ""}" data-capability="${capabilityId}" role="switch" aria-checked="${Boolean(plan?.clients.includes(capabilityId) || (isNew && capabilityId !== "download"))}"></button></div>`).join("");
  return `
    <form class="drawer-form" id="plan-drawer-form" data-plan-id="${isNew ? "" : planId}">
      <p class="drawer-section-label">方案信息</p>
      <label class="field"><span>方案名称</span><input name="planName" value="${plan?.name || ""}" placeholder="例如：区域办公" required><small class="field-error"></small></label>
      <label class="field"><span>适用场景</span><input name="description" value="${plan?.description || ""}" placeholder="例如：适合区域办公室日常使用"></label>
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

function hostDrawerMarkup(name) {
  const host = hostDetails[name];
  const isNew = !host;
  return `
    <form class="drawer-form" id="host-drawer-form">
      ${isNew ? "" : `<div class="drawer-profile"><span class="avatar">${name.slice(0, 1)}</span><div><strong>${name}</strong><small>${host.ip} · ${host.os}</small></div></div>`}
      <p class="drawer-section-label">主机连接</p>
      <label class="field"><span>名称</span><input name="hostname" value="${isNew ? "" : name}" placeholder="例如：首尔入口" required></label>
      <label class="field"><span>IP 地址或域名</span><input name="address" value="${host?.ip || ""}" placeholder="203.0.113.10" required></label>
      <label class="field"><span>区域</span><input name="region" value="${host?.region || ""}" placeholder="韩国 · 首尔"></label>
      <div class="quota-input">
        <label class="field"><span>SSH 端口</span><input type="number" value="22"></label>
        <label class="field"><span>用户</span><input value="root"></label>
      </div>
      <p class="drawer-section-label">sing-box 入口</p>
      <label class="field"><span>协议组合</span><select><option ${host?.protocols.includes("Reality") ? "selected" : ""}>VLESS + Reality</option><option ${host?.protocols.includes("Hysteria2") ? "selected" : ""}>Hysteria2 + TUIC</option><option ${host?.protocols.includes("Trojan") ? "selected" : ""}>VLESS + Trojan</option></select></label>
      <label class="field"><span>监听端口</span><input value="${host?.port || "443"}"></label>
      ${isNew ? "" : `<p class="drawer-section-label">实时资源</p><div class="switch-row"><div><strong>CPU ${host.cpu}%</strong><small>内存 ${host.memory}% · 同步 ${host.sync}</small></div><span class="status-badge good"><i></i>在线</span></div>`}
      <div class="switch-row"><div><strong>纳入自动发布</strong><small>配置发布时自动同步该节点</small></div><button type="button" class="switch on" role="switch" aria-checked="true"></button></div>
    </form>`;
}

function openHost(name) {
  const isNew = name === "新主机";
  openDrawer({
    title: isNew ? "添加主机" : name,
    eyebrow: isNew ? "基础设施" : "主机详情",
    content: hostDrawerMarkup(name),
    saveLabel: isNew ? "验证并添加" : "保存主机"
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
      <label class="field"><span>密码</span><input name="portalPassword" type="password" value="raylink-demo" required><small class="field-error"></small></label>
      <div class="portal-login-help"><svg><use href="#i-shield"/></svg><span><strong>账号由管理员开通</strong><small>首次登录邀请和密码重置邮件发送到用户邮箱。</small></span></div>
    </form>`;
}

function portalHomeMarkup() {
  const user = users.find((item) => item.email === currentPortalUserEmail);
  const plan = plans[user.planId];
  const clientEntries = plan.clients.map((clientId) => {
    const client = clientCatalog[clientId];
    return `<button type="button" data-client-import="${client.name}"><span><strong>${client.name}</strong><small>${client.platforms}</small></span><span>${client.action}</span></button>`;
  }).join("");
  return `
    <div class="portal-home">
      <div class="drawer-profile">
        <span class="avatar">${user.initials}</span>
        <div><strong>${user.name}</strong><small>${user.email}</small></div>
        <span class="status-badge good"><i></i>账号正常</span>
      </div>
      <div class="portal-entitlement">
        <p class="drawer-section-label">当前订阅方案</p>
        <h3>${plan.name}</h3>
        <p>${plan.description}</p>
        <div class="assigned-plan-preview"><span><small>剩余流量</small><strong>${(plan.quota - user.used).toFixed(1)} GB</strong></span><span><small>设备上限</small><strong>${plan.devices} 台</strong></span><span><small>节点范围</small><strong>${plan.nodeGroup}</strong></span></div>
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

function saveUserForm(form) {
  const originalEmail = form.dataset.originalEmail;
  const name = form.elements.name.value.trim();
  const email = form.elements.email.value.trim();
  const planId = form.elements.plan.value;
  const expires = form.elements.expires.value;
  const existingUser = users.find((user) => user.email === originalEmail);

  if (existingUser) {
    Object.assign(existingUser, { name, email, planId, expires });
  } else {
    const initials = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
    users.push({ name, initials: initials || "新", email, password: "raylink-demo", portalStatus: "invited", state: "active", used: 0, planId, expires });
  }
  renderUsers();
  renderPlans();
}

function savePlanForm(form) {
  const planId = form.dataset.planId || `custom-${Date.now()}`;
  const name = form.elements.planName.value.trim();
  const previousPlan = plans[planId];
  const enabledClients = [...form.querySelectorAll(".switch[data-capability].on")].map((button) => button.dataset.capability);
  const updatedPlan = {
    name,
    quota: Number(form.elements.quota.value),
    devices: Number(form.elements.devices.value),
    nodeGroup: form.elements.nodeGroup.value,
    clients: enabledClients,
    description: form.elements.description.value.trim() || "自定义服务方案",
    tone: previousPlan?.tone || "standard"
  };

  plans[planId] = updatedPlan;
  renderUsers();
  renderPlans();
}

function saveDrawer() {
  const form = elements.drawerContent.querySelector("form");
  if (!form) {
    closeDrawer();
    return;
  }
  if (!validateDrawerForm(form)) return;

  if (form.id === "portal-login-form") {
    const email = form.elements.portalEmail.value.trim();
    const password = form.elements.portalPassword.value;
    const user = users.find((item) => item.email === email);
    if (!user || user.password !== password || user.portalStatus !== "active") {
      const passwordError = form.elements.portalPassword.closest(".field").querySelector(".field-error");
      passwordError.textContent = user?.portalStatus === "invited" ? "该账号尚未完成首次登录激活" : "账号或密码不正确";
      passwordError.classList.add("visible");
      form.elements.portalPassword.focus();
      return;
    }
    currentPortalUserEmail = user.email;
    elements.drawerEyebrow.textContent = "用户中心预览";
    elements.drawerTitle.textContent = "我的服务";
    elements.drawerContent.innerHTML = portalHomeMarkup();
    elements.drawerSave.textContent = "关闭预览";
    showToast("登录成功", `已进入 ${user.name} 的用户中心。`);
    return;
  }

  if (form.id === "user-drawer-form") saveUserForm(form);
  if (form.id === "plan-drawer-form") savePlanForm(form);

  const message = form?.id === "plan-drawer-form"
    ? "方案设置已保存，关联用户将在下次同步时更新。"
    : form?.id === "user-drawer-form" && elements.drawerSave.textContent.includes("创建")
      ? "用户已创建并分配订阅方案。"
      : elements.drawerSave.textContent.includes("添加")
        ? "主机连接信息已通过本地校验。"
        : "更改已经写入当前草稿。";
  closeDrawer();
  showToast("已保存", message);
}

function handleSwitch(button) {
  const enabled = button.classList.toggle("on");
  button.setAttribute("aria-checked", String(enabled));
}

function publishConfig() {
  if (publishInProgress) return;
  publishInProgress = true;
  const button = document.querySelector("#publish-config");
  const items = [...document.querySelectorAll("#publish-trail li")];
  const statusBadge = document.querySelector(".release-header .status-badge");
  button.disabled = true;
  button.innerHTML = `${icon("refresh")} 发布中 0 / 4`;
  statusBadge.className = "status-badge warning";
  statusBadge.innerHTML = "<i></i>发布中";

  const stages = [
    { index: 1, text: "校验完成", button: "发布中 0 / 4" },
    { index: 2, text: "快照已保存", button: "发布中 0 / 4" },
    { index: 3, text: "节点 2 / 4", button: "发布中 2 / 4" },
    { index: 4, text: "健康检查通过", button: "发布中 4 / 4" }
  ];

  items[0].className = "done";
  items[0].querySelector("span").innerHTML = icon("check");

  stages.forEach((stage, step) => {
    setTimeout(() => {
      const previous = items[stage.index - 1];
      if (previous) {
        previous.className = "done";
        previous.querySelector("span").innerHTML = icon("check");
      }
      const current = items[stage.index];
      current.className = step === stages.length - 1 ? "done" : "current";
      current.querySelector("span").innerHTML = step === stages.length - 1 ? icon("check") : String(stage.index + 1);
      button.innerHTML = `${icon("refresh")} ${stage.button}`;
      showToast(stage.text, step === stages.length - 1 ? "4 个节点均已加载新配置。" : "配置发布轨迹已更新。");

      if (step === stages.length - 1) {
        button.disabled = false;
        button.innerHTML = `${icon("check")} 已发布`;
        statusBadge.className = "status-badge good";
        statusBadge.innerHTML = "<i></i>已生效";
        document.querySelector(".release-version").textContent = "v2026.07.25-05";
        publishInProgress = false;
      }
    }, 850 * (step + 1));
  });
}

document.addEventListener("click", (event) => {
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
    showToast("客户端已准备", `${clientImport.dataset.clientImport} 的导入配置已经生成。`);
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

renderUsers();
renderPlans();
renderClientEntries();
syncResponsiveNavigation();
const initialRoute = location.hash.replace(/^#\//, "") || "dashboard";
navigate(initialRoute, false);
