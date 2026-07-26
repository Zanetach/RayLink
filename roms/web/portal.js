const loginPanel = document.querySelector("#portal-login-panel");
const accountPanel = document.querySelector("#portal-account-panel");
const loginForm = document.querySelector("#standalone-portal-login");
const loginError = document.querySelector("#portal-login-error");
const downloadButton = document.querySelector("#portal-download-config");
const subscriptionAction = document.querySelector("#portal-subscription-action");
const subscriptionStatus = document.querySelector("#portal-subscription-status");
const subscriptionValue = document.querySelector("#portal-subscription-value");
const subscriptionUrl = document.querySelector("#portal-subscription-url");
const copySubscription = document.querySelector("#portal-copy-subscription");

async function portalApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || "请求失败");
  return body;
}

function scopeLabel(scope) {
  const labels = { all: "全部节点", tokyo: "东京", singapore: "新加坡" };
  if (scope.includes("all")) return labels.all;
  return scope.map((item) => labels[item] || item).join(" + ");
}

function renderAccount(profile) {
  const { user, entitlement } = profile;
  document.querySelector("#portal-user-initials").textContent = user.initials;
  document.querySelector("#portal-user-name").textContent = user.name;
  document.querySelector("#portal-user-email").textContent = user.email;
  document.querySelector("#portal-account-title").textContent = `${user.name} 的访问权益`;
  document.querySelector("#portal-remaining-quota").textContent = `${Math.max(0, entitlement.quotaGb - user.usedGb).toFixed(1)} GB`;
  document.querySelector("#portal-node-scope").textContent = scopeLabel(entitlement.nodeScope);
  downloadButton.hidden = !entitlement.clientFormats.includes("sing-box");
  const configured = Boolean(user.subscription?.configured);
  subscriptionAction.textContent = configured ? "重置订阅地址" : "生成订阅地址";
  subscriptionStatus.textContent = configured
    ? "订阅已启用。出于安全考虑，地址不会再次显示；如果遗失，请重置后重新导入客户端。"
    : "生成后粘贴到 sing-box 客户端；地址保持有效，直到你主动重置。";
  loginPanel.hidden = true;
  accountPanel.hidden = false;
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const submit = loginForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = "登录中…";
  try {
    const profile = await portalApi("/api/portal/login", {
      method: "POST",
      body: JSON.stringify({
        email: loginForm.elements.email.value.trim(),
        password: loginForm.elements.password.value
      })
    });
    loginForm.elements.password.value = "";
    renderAccount(profile);
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = "登录";
  }
});

downloadButton.addEventListener("click", async () => {
  downloadButton.disabled = true;
  downloadButton.textContent = "正在生成…";
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
    anchor.click();
    URL.revokeObjectURL(url);
    document.querySelector("#portal-download-note").textContent = "配置已生成。请妥善保管，其中包含你的专属运行凭据。";
  } catch (error) {
    document.querySelector("#portal-download-note").textContent = error.message;
  } finally {
    downloadButton.disabled = false;
    downloadButton.textContent = "下载 sing-box 配置";
  }
});

subscriptionAction.addEventListener("click", async () => {
  const isReset = subscriptionAction.textContent.includes("重置");
  if (isReset && !window.confirm("重置后，已经导入客户端的旧订阅地址会立即失效。确定继续吗？")) return;

  subscriptionAction.disabled = true;
  subscriptionAction.textContent = isReset ? "正在重置…" : "正在生成…";
  try {
    const result = await portalApi("/api/portal/subscription/rotate", { method: "POST" });
    subscriptionUrl.value = result.subscriptionUrl;
    subscriptionValue.hidden = false;
    subscriptionStatus.textContent = "新地址已生成。请立即复制并导入客户端；本页面刷新后不会再次显示完整地址。";
    subscriptionAction.textContent = "重置订阅地址";
  } catch (error) {
    subscriptionStatus.textContent = error.message;
    subscriptionAction.textContent = isReset ? "重置订阅地址" : "生成订阅地址";
  } finally {
    subscriptionAction.disabled = false;
  }
});

copySubscription.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(subscriptionUrl.value);
    copySubscription.textContent = "已复制";
    window.setTimeout(() => { copySubscription.textContent = "复制"; }, 1600);
  } catch {
    subscriptionUrl.focus();
    subscriptionUrl.select();
    copySubscription.textContent = "请手动复制";
  }
});

portalApi("/api/portal/me").then(renderAccount).catch(() => {
  loginPanel.hidden = false;
  accountPanel.hidden = true;
});
