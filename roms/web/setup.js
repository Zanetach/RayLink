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
let currentStep = 0;
let preflightPassed = false;

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
  select.replaceChildren();
  const choices = mode === "domain"
    ? [
        ["external", "已有 HTTPS / 反向代理"]
      ]
    : [
        ["ip-self-signed", "安装器生成的 IP 证书"],
        ["external", "已有 IP HTTPS / 反向代理"]
      ];
  for (const [value, label] of choices) {
    select.add(new Option(label, value));
  }
  form.elements.canonicalOrigin.placeholder = mode === "domain"
    ? "https://panel.example.com"
    : "https://203.0.113.10";
}

function currentFields() {
  return [...steps[currentStep].querySelectorAll("input, select, textarea")]
    .filter((field) => !field.disabled);
}

function validateStep() {
  errorElement.textContent = "";
  for (const field of currentFields()) {
    if (!field.reportValidity()) return false;
  }
  if (
    currentStep === 2
    && form.elements.password.value !== form.elements.passwordConfirm.value
  ) {
    errorElement.textContent = "两次输入的管理员密码不一致";
    form.elements.passwordConfirm.focus();
    return false;
  }
  return true;
}

function renderSummary() {
  const mode = form.elements.accessMode.value;
  const rows = [
    ["访问方式", mode === "domain" ? "域名" : "IP 地址"],
    ["主访问地址", form.elements.canonicalOrigin.value.trim()],
    ["证书方式", form.elements.certificateMode.selectedOptions[0]?.textContent || ""],
    ["管理员", form.elements.username.value.trim()],
    ["本机 Runtime", `${form.elements.runtimeName.value.trim()} · ${form.elements.runtimeRegion.value.trim()}`],
    ["主机地址", form.elements.runtimeAddress.value.trim()]
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
      runtime: "sing-box Runtime"
    };
    preflightElement.replaceChildren(...Object.entries(result.checks).map(([key, value]) => {
      const row = document.createElement("span");
      row.textContent = `${labels[key] || key}：${value === "passed" ? "通过" : "开发模式"}`;
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

function showStep(index) {
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
    void runPreflight();
  }
  steps[currentStep].querySelector("input, select, textarea")?.focus();
}

function setupPayload() {
  return {
    token: form.elements.token.value,
    access: {
      mode: form.elements.accessMode.value,
      canonicalOrigin: form.elements.canonicalOrigin.value.trim(),
      allowedOrigins: form.elements.allowedOrigins.value
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean)
    },
    certificate: { mode: form.elements.certificateMode.value },
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
  try {
    const result = await api("/api/setup/complete", {
      method: "POST",
      body: JSON.stringify(setupPayload())
    });
    location.assign(result.redirectTo || "/");
  } catch (error) {
    errorElement.textContent = error.message;
    if (error.code === "SETUP_TOKEN_INVALID") showStep(0);
    submitButton.disabled = false;
    submitButton.textContent = "完成初始化";
  }
});

async function initialize() {
  tokenFromFragment();
  updateCertificateOptions();
  const status = await api("/api/setup/status");
  if (status.state === "READY") {
    location.replace("/");
    return;
  }
  stateLabel.textContent = status.state === "UNINITIALIZED"
    ? "尚未生成初始化令牌"
    : status.state === "INITIALIZING"
      ? "初始化正在进行"
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
