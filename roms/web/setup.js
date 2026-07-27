const form = document.querySelector("#setup-form");
const steps = [...document.querySelectorAll("[data-step]")];
const progress = [...document.querySelectorAll("[data-progress]")];
const backButton = document.querySelector("#setup-back");
const nextButton = document.querySelector("#setup-next");
const submitButton = document.querySelector("#setup-submit");
const errorElement = document.querySelector("#setup-error");
const stateLabel = document.querySelector("#setup-state-label");
const expiryLabel = document.querySelector("#setup-expiry");
const summary = document.querySelector("#setup-summary");
const preflightElement = document.querySelector("#setup-preflight");
const confirmationElement = document.querySelector(".setup-confirm");
const initializationProgress = document.querySelector("#setup-initialization-progress");
const initializationTitle = document.querySelector("#setup-initialization-title");
const initializationMessage = document.querySelector("#setup-initialization-message");
const initializationPercent = document.querySelector("#setup-initialization-percent");
const initializationBar = document.querySelector("#setup-initialization-bar");
const initializationStages = [...document.querySelectorAll("[data-initialization-stage]")];
const previewMode = location.protocol === "file:";
let currentStep = 0;
let preflightPassed = false;
let initializationMonitorActive = false;
let initializationMonitorTimer = null;
let initializationResume = false;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || "服务器请求失败");
    error.status = response.status;
    error.code = body.error?.code;
    throw error;
  }
  return body;
}

function tokenFromFragment() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = params.get("token") || "";
  if (token) {
    form.elements.token.value = token;
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
}

function updateCertificateOptions() {
  const mode = form.elements.accessMode.value;
  const select = form.elements.certificateMode;
  const previousMode = select.value;
  select.replaceChildren();
  const choices = mode === "domain"
    ? [
        ["caddy-auto", "Caddy 自动 HTTPS"],
        ["external", "已有 HTTPS / 反向代理"]
      ]
    : [
        ["ip-self-signed", "安装器生成的 IP 证书"],
        ["external", "已有 IP HTTPS / 反向代理"]
      ];
  for (const [value, label] of choices) {
    select.add(new Option(label, value));
  }
  if (choices.some(([value]) => value === previousMode)) {
    select.value = previousMode;
  }
  const automaticCertificate = select.value === "caddy-auto";
  const emailField = document.querySelector("[data-certificate-email]");
  emailField.hidden = !automaticCertificate;
  form.elements.certificateEmail.required = automaticCertificate;
  const subscriptionField = document.querySelector("[data-subscription-origin]");
  subscriptionField.hidden = mode !== "domain";
  form.elements.subscriptionOrigin.disabled = mode !== "domain";
  form.elements.subscriptionOrigin.required = mode === "domain";
  form.elements.canonicalOrigin.placeholder = mode === "domain"
    ? "https://panel.example.com"
    : "https://203.0.113.10";
}

function currentFields() {
  return [...steps[currentStep].querySelectorAll("input, select, textarea")]
    .filter((field) => !field.disabled);
}

function fieldLabel(field) {
  return field.closest("label")?.querySelector("span")?.textContent.trim() || "该字段";
}

function passwordClassCount(password) {
  return [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password)
  ].filter(Boolean).length;
}

function validationMessage(field) {
  const value = String(field.value || "");
  if (field.name === "password") {
    if (!value) return "请输入管理员密码";
    if (value.length < 12) return "管理员密码至少需要 12 位";
    if (passwordClassCount(value) < 3) {
      return "管理员密码需包含大小写字母、数字、符号中的至少三类";
    }
    return "";
  }
  if (field.name === "passwordConfirm") {
    if (!value) return "请再次输入管理员密码";
    if (value !== form.elements.password.value) return "两次输入的管理员密码不一致";
    return "";
  }
  if (field.validity.valueMissing) {
    return field.type === "checkbox"
      ? "请确认管理入口可达，并已保存管理员凭据"
      : `请填写${fieldLabel(field)}`;
  }
  if (field.validity.typeMismatch) {
    return field.type === "email" ? "请输入有效的邮箱地址" : "请输入有效的访问地址";
  }
  if (field.validity.tooShort) {
    return `${fieldLabel(field)}至少需要 ${field.minLength} 位`;
  }
  if (field.validity.patternMismatch) {
    return "区域标识只能包含 2–32 位字母、数字或连字符";
  }
  return field.checkValidity() ? "" : `请检查${fieldLabel(field)}`;
}

function clearFieldError(field) {
  field.classList.remove("invalid");
  field.removeAttribute("aria-invalid");
}

function presentValidationError(field, message) {
  field.classList.add("invalid");
  field.setAttribute("aria-invalid", "true");
  errorElement.textContent = message;
  field.focus();
}

function validateStep() {
  errorElement.textContent = "";
  for (const field of currentFields()) {
    clearFieldError(field);
    const message = validationMessage(field);
    if (message) {
      presentValidationError(field, message);
      return false;
    }
  }
  return true;
}

function renderSummary() {
  const mode = form.elements.accessMode.value;
  const rows = [
    ["访问方式", mode === "domain" ? "域名" : "IP 地址"],
    ["控制台地址", form.elements.canonicalOrigin.value.trim()],
    ["订阅服务", mode === "domain"
      ? form.elements.subscriptionOrigin.value.trim()
      : form.elements.canonicalOrigin.value.trim()],
    ["证书方式", form.elements.certificateMode.selectedOptions[0]?.textContent || ""],
    ...(form.elements.certificateMode.value === "caddy-auto"
      ? [["证书邮箱", form.elements.certificateEmail.value.trim()]]
      : []),
    ["管理员", form.elements.username.value.trim()],
    ["本机 Runtime", `${form.elements.runtimeName.value.trim()} · ${form.elements.runtimeRegion.value.trim()}`],
    ["主机地址", form.elements.runtimeAddress.value.trim()],
    ["网络加速", "自动启用 BBR + fq"]
  ];
  summary.replaceChildren(...rows.map(([term, value]) => {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    row.append(dt, dd);
    return row;
  }));
}

async function runPreflight() {
  preflightPassed = false;
  submitButton.disabled = true;
  preflightElement.textContent = "正在检查访问入口与 Runtime…";
  try {
    const result = await api("/api/setup/preflight", {
      method: "POST",
      body: JSON.stringify(setupPayload())
    });
    const labels = {
      setupToken: "一次性令牌",
      accessOrigin: "当前访问入口",
      https: "HTTPS",
      runtime: "sing-box Runtime",
      bbr: "BBR 网络加速",
      dns: "域名 DNS",
      caddy: "Caddy"
    };
    const states = {
      passed: "通过",
      development: "开发模式",
      available: "将在初始化时启用",
      enabled: "已启用",
      unsupported: "内核不支持",
      unavailable: "检测失败",
      automatic: "将自动配置",
      "configuration-ready": "配置就绪"
    };
    preflightElement.replaceChildren(...Object.entries(result.checks).map(([key, value]) => {
      const row = document.createElement("span");
      row.textContent = `${labels[key] || key}：${states[value] || value}`;
      row.dataset.state = value;
      return row;
    }));
    preflightPassed = true;
    submitButton.disabled = false;
  } catch (error) {
    preflightElement.textContent = `检查未通过：${error.message}`;
    errorElement.textContent = error.message;
    if (error.code === "SETUP_TOKEN_INVALID") showStep(0);
  }
}

function showStep(index, { runChecks = true } = {}) {
  currentStep = Math.max(0, Math.min(steps.length - 1, index));
  steps.forEach((step, stepIndex) => {
    step.hidden = stepIndex !== currentStep;
    step.classList.toggle("active", stepIndex === currentStep);
  });
  progress.forEach((item, itemIndex) => {
    item.classList.toggle("active", itemIndex === currentStep);
    item.classList.toggle("complete", itemIndex < currentStep);
  });
  backButton.hidden = currentStep === 0;
  nextButton.hidden = currentStep === steps.length - 1;
  submitButton.hidden = currentStep !== steps.length - 1;
  if (currentStep === steps.length - 1) {
    renderSummary();
    if (runChecks) void runPreflight();
  }
  steps[currentStep].scrollTop = 0;
  steps[currentStep].querySelector("input, select, textarea")?.focus();
}

function renderInitializationProgress(progressState = {}, ready = false) {
  const total = Math.max(1, Number(progressState.total) || 4);
  const current = ready ? total : Math.max(0, Math.min(total, Number(progressState.current) || 0));
  const percent = ready ? 100 : Math.round((current / total) * 100);
  const stage = ready ? "complete" : progressState.stage || "starting";
  initializationProgress.hidden = false;
  preflightElement.hidden = true;
  initializationTitle.textContent = ready
    ? "初始化完成"
    : progressState.message || "正在准备初始化";
  initializationMessage.textContent = ready
    ? "正在进入 RayLink 控制台…"
    : "进度由服务器实时上报，刷新页面后仍可继续查看。";
  initializationPercent.textContent = `${percent}%`;
  initializationBar.style.width = `${percent}%`;

  const stageIndex = initializationStages.findIndex(
    (item) => item.dataset.initializationStage === stage
  );
  initializationStages.forEach((item, index) => {
    item.classList.toggle("complete", ready || (stageIndex >= 0 && index < stageIndex));
    item.classList.toggle("active", !ready && index === stageIndex);
  });
}

function stopInitializationMonitor() {
  initializationMonitorActive = false;
  if (initializationMonitorTimer) {
    clearTimeout(initializationMonitorTimer);
    initializationMonitorTimer = null;
  }
}

async function monitorInitialization() {
  if (!initializationMonitorActive) return;
  try {
    const status = await api("/api/setup/status");
    if (status.state === "READY") {
      stopInitializationMonitor();
      renderInitializationProgress({ current: 3, total: 3 }, true);
      if (initializationResume) {
        setTimeout(() => location.replace("/"), 450);
      }
      return;
    }
    if (status.state === "INITIALIZING") {
      renderInitializationProgress(status.progress);
    } else if (status.state === "SETUP_PENDING" && !initializationResume) {
      renderInitializationProgress({
        stage: "starting",
        current: 0,
        total: 3,
        message: "正在等待服务器启动初始化"
      });
    } else {
      stopInitializationMonitor();
      initializationTitle.textContent = "初始化未完成";
      initializationMessage.textContent = "服务器已恢复为可重试状态，请重新检查后提交。";
      initializationPercent.textContent = "需重试";
      errorElement.textContent = "初始化未完成，请刷新页面后重试。";
      return;
    }
  } catch {
    initializationMessage.textContent = "访问入口正在切换，正在重新连接服务器…";
  }
  if (initializationMonitorActive) {
    initializationMonitorTimer = setTimeout(monitorInitialization, 900);
  }
}

function setupPayload() {
  return {
    token: form.elements.token.value,
    access: {
      mode: form.elements.accessMode.value,
      canonicalOrigin: form.elements.canonicalOrigin.value.trim(),
      subscriptionOrigin: form.elements.accessMode.value === "domain"
        ? form.elements.subscriptionOrigin.value.trim()
        : form.elements.canonicalOrigin.value.trim(),
      allowedOrigins: form.elements.allowedOrigins.value
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean)
    },
    certificate: {
      mode: form.elements.certificateMode.value,
      email: form.elements.certificateEmail.value.trim()
    },
    admin: {
      username: form.elements.username.value.trim(),
      password: form.elements.password.value
    },
    runtime: {
      name: form.elements.runtimeName.value.trim(),
      address: form.elements.runtimeAddress.value.trim(),
      region: form.elements.runtimeRegion.value.trim()
    }
  };
}

nextButton.addEventListener("click", () => {
  if (validateStep()) showStep(currentStep + 1);
});
backButton.addEventListener("click", () => showStep(currentStep - 1));
document.querySelectorAll('input[name="accessMode"]').forEach((radio) => {
  radio.addEventListener("change", updateCertificateOptions);
});
form.elements.certificateMode.addEventListener("change", updateCertificateOptions);
for (const field of form.elements) {
  if (!(field instanceof HTMLElement)) continue;
  const clearCurrentError = () => {
    clearFieldError(field);
    errorElement.textContent = "";
  };
  field.addEventListener("input", clearCurrentError);
  field.addEventListener("change", clearCurrentError);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validateStep()) return;
  if (!preflightPassed) {
    await runPreflight();
    if (!preflightPassed) return;
  }
  errorElement.textContent = "";
  submitButton.disabled = true;
  submitButton.textContent = "正在初始化…";
  backButton.disabled = true;
  confirmationElement.hidden = true;
  initializationResume = false;
  initializationMonitorActive = true;
  renderInitializationProgress();
  void monitorInitialization();
  try {
    const result = await api("/api/setup/complete", {
      method: "POST",
      body: JSON.stringify(setupPayload())
    });
    stopInitializationMonitor();
    renderInitializationProgress({ current: 4, total: 4 }, true);
    location.assign(result.redirectTo || "/");
  } catch (error) {
    stopInitializationMonitor();
    errorElement.textContent = error.message;
    if (error.code === "SETUP_TOKEN_INVALID") showStep(0);
    preflightElement.hidden = false;
    initializationProgress.hidden = true;
    confirmationElement.hidden = false;
    backButton.disabled = false;
    submitButton.disabled = false;
    submitButton.textContent = "完成初始化";
  }
});

async function initialize() {
  tokenFromFragment();
  updateCertificateOptions();
  if (previewMode) {
    stateLabel.textContent = "本地界面预览";
    expiryLabel.textContent = "部署后将在这里显示初始化令牌有效期";
    form.elements.token.value = "raylink-preview-token";
    form.elements.accessMode.value = "domain";
    form.elements.certificateEmail.value = "ops@example.com";
    updateCertificateOptions();
    return;
  }
  const status = await api("/api/setup/status");
  if (status.state === "READY") {
    location.replace("/");
    return;
  }
  if (status.state === "INITIALIZING") {
    stateLabel.textContent = "初始化正在进行";
    expiryLabel.textContent = "可安全刷新页面，进度会从服务器恢复";
    summary.hidden = true;
    confirmationElement.hidden = true;
    showStep(steps.length - 1, { runChecks: false });
    backButton.disabled = true;
    submitButton.disabled = true;
    submitButton.textContent = "正在初始化…";
    initializationResume = true;
    initializationMonitorActive = true;
    renderInitializationProgress(status.progress);
    void monitorInitialization();
    return;
  }
  stateLabel.textContent = status.state === "UNINITIALIZED"
    ? "尚未生成初始化令牌"
    : "等待完成首次初始化";
  expiryLabel.textContent = status.state === "UNINITIALIZED"
    ? "请在服务器运行 /opt/raylink/deploy/rotate-setup-token.sh"
    : status.expiresAt
      ? `令牌有效期至 ${new Date(status.expiresAt).toLocaleString()}`
      : "";
  const hostname = location.hostname;
  const normalizedHostname = hostname.replace(/^\[|\]$/g, "");
  const origin = location.origin;
  form.elements.accessMode.value = normalizedHostname && !/^[\d.:]+$/.test(normalizedHostname)
    ? "domain"
    : "ip";
  form.elements.canonicalOrigin.value = origin;
  form.elements.allowedOrigins.value = origin;
  form.elements.runtimeAddress.value = hostname || "127.0.0.1";
  updateCertificateOptions();
}

initialize().catch((error) => {
  errorElement.textContent = `无法读取初始化状态：${error.message}`;
  stateLabel.textContent = "服务状态不可用";
});
