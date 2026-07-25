const users = [
  { name: "林知夏", initials: "LZ", email: "lin.zhixia@meridian-log.cn", state: "active", used: 74.3, quota: 200, protocols: ["VLESS", "HY2"], expires: "2026-10-18" },
  { name: "岡本和也", initials: "OK", email: "k.okamoto@hokkaido-ceramics.jp", state: "warning", used: 131.4, quota: 150, protocols: ["VLESS", "Trojan"], expires: "2026-08-04" },
  { name: "Priya Mehta", initials: "PM", email: "priya@vantage-bioworks.in", state: "active", used: 75.4, quota: 180, protocols: ["HY2", "TUIC"], expires: "2026-09-01" },
  { name: "Nia Okafor", initials: "NO", email: "nia@lagos-fieldworks.ng", state: "active", used: 46.8, quota: 120, protocols: ["VLESS"], expires: "2026-11-23" },
  { name: "Lars Eriksson", initials: "LE", email: "lars@nordhavn-data.se", state: "disabled", used: 18.2, quota: 80, protocols: ["Trojan"], expires: "2026-07-31" },
  { name: "陈望舒", initials: "CW", email: "wangshu@lingnan-studio.cn", state: "warning", used: 92.7, quota: 110, protocols: ["VLESS", "HY2"], expires: "2026-08-12" }
];

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
    const haystack = `${user.name} ${user.email} ${user.protocols.join(" ")}`.toLocaleLowerCase();
    return matchesFilter && haystack.includes(query);
  });

  elements.userBody.innerHTML = filtered.map((user) => {
    const status = stateLabels[user.state];
    const ratio = Math.min(100, (user.used / user.quota) * 100);
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
          <div class="usage-copy"><span>${user.used.toFixed(1)} GB</span><span>${user.quota} GB</span></div>
          <div class="progress ${progressClass}"><i style="width:${ratio.toFixed(1)}%"></i></div>
        </td>
        <td>${user.protocols.map((item) => `<span class="tag">${item}</span>`).join("")}</td>
        <td class="numeric">${formatDate(user.expires)}</td>
        <td><button class="icon-button small" aria-label="编辑 ${user.name}" data-user="${user.email}">${icon("more")}</button></td>
      </tr>`;
  }).join("");

  elements.userCount.textContent = `显示 ${filtered.length} / 27 位用户`;
  if (!filtered.length) {
    elements.userBody.innerHTML = `<tr><td colspan="6"><div class="empty-state">没有符合当前筛选条件的用户</div></td></tr>`;
  }
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

  const headings = { dashboard: "仪表盘", users: "用户", subscriptions: "订阅配置", hosts: "主机", deploy: "配置发布", "not-found": "未找到" };
  document.title = `${headings[resolvedView]} · Linehaul`;
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
  return `
    <form class="drawer-form" id="user-drawer-form">
      <div class="drawer-profile">
        <span class="avatar">${user.initials || "新"}</span>
        <div><strong>${user.name || "新用户"}</strong><small>${isNew ? "尚未创建订阅" : user.email}</small></div>
      </div>
      <p class="drawer-section-label">基本信息</p>
      <label class="field"><span>显示名称</span><input name="name" value="${user.name || ""}" placeholder="例如：徐清扬" required><small class="field-error"></small></label>
      <label class="field"><span>邮箱</span><input name="email" type="email" value="${user.email || ""}" placeholder="name@company.com" required><small class="field-error"></small></label>
      <div class="quota-input">
        <label class="field"><span>每月流量配额</span><input name="quota" type="number" min="1" value="${user.quota || 100}" required></label>
        <label class="field"><span>单位</span><select><option>GB</option><option>TB</option></select></label>
      </div>
      <label class="field"><span>到期时间</span><input name="expires" type="date" value="${user.expires || "2026-12-31"}" required></label>
      <p class="drawer-section-label">访问策略</p>
      <div class="switch-row"><div><strong>启用账号</strong><small>允许订阅刷新和节点连接</small></div><button type="button" class="switch ${user.state !== "disabled" ? "on" : ""}" role="switch" aria-checked="${user.state !== "disabled"}"></button></div>
      <div class="switch-row"><div><strong>自动重置流量</strong><small>每月 1 日按配额重置</small></div><button type="button" class="switch on" role="switch" aria-checked="true"></button></div>
      <label class="field"><span>可用协议</span><select multiple size="4"><option selected>VLESS + Reality</option><option ${user.protocols?.includes("HY2") ? "selected" : ""}>Hysteria2</option><option ${user.protocols?.includes("Trojan") ? "selected" : ""}>Trojan TLS</option><option ${user.protocols?.includes("TUIC") ? "selected" : ""}>TUIC</option></select></label>
    </form>`;
}

function openUser(email) {
  const user = users.find((item) => item.email === email);
  if (!user) return;
  openDrawer({ title: user.name, eyebrow: "用户详情", content: userDrawerMarkup(user) });
}

function openNewUser() {
  openDrawer({ title: "新建用户", eyebrow: "访问控制", content: userDrawerMarkup(), saveLabel: "创建并生成订阅" });
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
  showToast("已复制", "订阅地址已复制到剪贴板。");
}

function validateSubscriptionForm() {
  const input = document.querySelector('input[name="subdomain"]');
  const error = input.parentElement.querySelector(".field-error");
  try {
    const url = new URL(input.value);
    if (url.protocol !== "https:") throw new Error("protocol");
    input.classList.remove("invalid");
    error.classList.remove("visible");
    return true;
  } catch {
    input.classList.add("invalid");
    error.textContent = "请输入以 https:// 开头的有效域名";
    error.classList.add("visible");
    input.focus();
    return false;
  }
}

function saveDrawer() {
  const form = elements.drawerContent.querySelector("form");
  if (form && !form.reportValidity()) return;
  const message = elements.drawerSave.textContent.includes("添加")
    ? "主机连接信息已通过本地校验。"
    : elements.drawerSave.textContent.includes("创建")
      ? "用户已创建，订阅令牌已经生成。"
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

  if (event.target.closest("[data-new-user]")) {
    openNewUser();
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

  const formatTab = event.target.closest(".format-tabs button");
  if (formatTab) {
    document.querySelectorAll(".format-tabs button").forEach((button) => button.classList.toggle("active", button === formatTab));
    showToast("预览已切换", `当前显示 ${formatTab.textContent} 格式。`);
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

document.querySelector("#save-subscription").addEventListener("click", () => {
  if (!validateSubscriptionForm()) return;
  const domain = document.querySelector('input[name="subdomain"]').value.replace(/\/$/, "");
  const prefix = document.querySelector('input[name="prefix"]').value.replace(/^\/|\/$/g, "");
  document.querySelector("#preview-url").textContent = `${domain}/${prefix}/9z3is74hjy2jswgh...`;
  showToast("订阅设置已保存", "新的设置将在下次刷新时生效。");
});

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
syncResponsiveNavigation();
const initialRoute = location.hash.replace(/^#\//, "") || "dashboard";
navigate(initialRoute, false);
