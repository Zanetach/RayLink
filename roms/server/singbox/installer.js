import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, copyFile, mkdir } from "node:fs/promises";
import { platform as currentPlatform, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const TARGET_VERSION = "1.13.12";
const SUPPORTED_VERSION_SERIES = "1.13";
const LATEST_RELEASE_URL = "https://api.github.com/repos/SagerNet/sing-box/releases/latest";
const LATEST_RELEASE_REDIRECT_URL = "https://github.com/SagerNet/sing-box/releases/latest";

export class SingBoxInstaller {
  constructor({
    binaryPath = "sing-box",
    platform = currentPlatform(),
    runner = execFile,
    fetchImpl = globalThis.fetch,
    dataDir = join(tmpdir(), "raylink-runtime"),
    activeConfigPath = null,
    runtimeMode = "dry-run",
    systemdUnit = "sing-box.service",
    clock = () => new Date(),
    healthCheckDelayMs = 2_000
  } = {}) {
    this.binaryPath = binaryPath;
    this.platform = platform;
    this.runner = runner;
    this.fetchImpl = fetchImpl;
    this.dataDir = dataDir;
    this.activeConfigPath = activeConfigPath;
    this.runtimeMode = runtimeMode;
    this.systemdUnit = systemdUnit;
    this.clock = clock;
    this.healthCheckDelayMs = Math.max(0, Number(healthCheckDelayMs) || 0);
    this.installing = false;
    this.updateState = {
      status: "not-checked",
      currentVersion: null,
      latestVersion: null,
      newerVersionAvailable: false,
      updateAvailable: false,
      compatible: true,
      checkedAt: null,
      releaseUrl: null,
      blockedReason: null
    };
  }

  async status() {
    try {
      const result = await this.runner(this.binaryPath, ["version"], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      });
      return parseVersionOutput(result.stdout, this.binaryPath, this.platform);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {
          installed: false,
          version: null,
          platform: this.platform,
          architecture: null,
          tags: [],
          binaryPath: this.binaryPath
        };
      }
      throw installerError("RUNTIME_INSPECTION_FAILED", error.message || "无法检测 sing-box", 500);
    }
  }

  async install() {
    if (this.installing) throw installerError("INSTALLATION_IN_PROGRESS", "sing-box 正在安装", 409);
    this.installing = true;
    try {
      const existing = await this.status();
      if (
        existing.installed
        && !isSupportedVersion(existing.version)
        && compareVersions(existing.version, TARGET_VERSION) >= 0
      ) {
        throw installerError(
          "RUNTIME_VERSION_UNSUPPORTED",
          `检测到 sing-box ${existing.version}，RayLink 当前只支持 ${SUPPORTED_VERSION_SERIES}.x`,
          409
        );
      }
      if (
        existing.installed
        && normalizeVersion(existing.version)
        && compareVersions(existing.version, TARGET_VERSION) >= 0
      ) {
        return { ...existing, alreadyInstalled: true };
      }
      if (this.platform === "darwin") {
        await this.runner("brew", [existing.installed ? "upgrade" : "install", "sing-box"], {
          timeout: 10 * 60 * 1000,
          maxBuffer: 8 * 1024 * 1024
        });
      } else if (this.platform === "linux") {
        await this.runner("sh", [
          "-c",
          "curl -fsSL https://sing-box.app/install.sh | sh -s -- --version 1.13.12"
        ], {
          timeout: 10 * 60 * 1000,
          maxBuffer: 8 * 1024 * 1024
        });
      } else {
        throw installerError(
          "INSTALLATION_UNSUPPORTED",
          `当前一键安装暂不支持 ${this.platform}，请使用官方包管理器安装`,
          422
        );
      }
      const installed = await this.status();
      if (!installed.installed) {
        throw installerError("INSTALLATION_NOT_DETECTED", "安装命令已完成，但未找到 sing-box 可执行文件", 500);
      }
      if (installed.version !== TARGET_VERSION) {
        throw installerError(
          "INSTALLATION_VERSION_MISMATCH",
          `期望 sing-box ${TARGET_VERSION}，实际检测到 ${installed.version || "未知版本"}`,
          500
        );
      }
      return installed;
    } catch (error) {
      if (error.statusCode) throw error;
      throw installerError("INSTALLATION_FAILED", String(error.stderr || error.message || "sing-box 安装失败"), 500);
    } finally {
      this.installing = false;
    }
  }

  releaseStatus() {
    return { ...this.updateState };
  }

  async checkForUpdates() {
    try {
      const [current, release] = await Promise.all([
        this.status(),
        this.fetchLatestStableRelease()
      ]);
      const latestVersion = normalizeVersion(release.tagName);
      if (!latestVersion) {
        throw new Error("最新稳定版本信息无效");
      }
      const newerVersionAvailable = current.installed
        && compareVersions(latestVersion, current.version) > 0;
      const compatible = isSupportedVersion(latestVersion);
      this.updateState = {
        status: "ready",
        currentVersion: current.version,
        latestVersion,
        newerVersionAvailable,
        updateAvailable: newerVersionAvailable && compatible,
        compatible,
        checkedAt: this.clock().toISOString(),
        releaseUrl: String(release.releaseUrl || ""),
        blockedReason: newerVersionAvailable && !compatible
          ? `sing-box ${latestVersion} 超出 RayLink 当前支持的 ${SUPPORTED_VERSION_SERIES}.x 系列`
          : null
      };
      return this.releaseStatus();
    } catch (error) {
      this.updateState = {
        ...this.updateState,
        status: "error",
        checkedAt: this.clock().toISOString(),
        error: String(error.message || "无法检查 sing-box 更新")
      };
      throw installerError("UPDATE_CHECK_FAILED", this.updateState.error, 502);
    }
  }

  async fetchLatestStableRelease() {
    const requestOptions = {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "RayLink-runtime-updater"
      },
      signal: AbortSignal.timeout(15_000)
    };
    const apiResponse = await this.fetchImpl(LATEST_RELEASE_URL, requestOptions);
    if (apiResponse.ok) {
      const release = await apiResponse.json();
      if (release.prerelease !== true && release.draft !== true) {
        return {
          tagName: release.tag_name,
          releaseUrl: release.html_url,
          publishedAt: release.published_at
        };
      }
    }

    const redirectResponse = await this.fetchImpl(LATEST_RELEASE_REDIRECT_URL, {
      headers: { "user-agent": "RayLink-runtime-updater" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000)
    });
    if (!redirectResponse.ok) {
      throw new Error(`GitHub Releases 返回 HTTP ${redirectResponse.status}`);
    }
    const releaseUrl = String(redirectResponse.url || "");
    const tagName = releaseUrl.match(/\/releases\/tag\/(v?\d+\.\d+\.\d+)\/?$/)?.[1];
    if (!tagName) throw new Error("无法从官方最新版本地址解析版本号");
    return { tagName, releaseUrl, publishedAt: null };
  }

  async upgrade(targetVersion) {
    const normalizedTarget = normalizeVersion(targetVersion);
    if (!normalizedTarget || !isSupportedVersion(normalizedTarget)) {
      throw installerError(
        "RUNTIME_UPGRADE_UNSUPPORTED",
        `RayLink 当前只支持升级到 sing-box ${SUPPORTED_VERSION_SERIES}.x 稳定版本`,
        422
      );
    }
    if (this.platform !== "linux") {
      throw installerError(
        "RUNTIME_UPGRADE_UNSUPPORTED",
        "安全在线升级当前仅支持 Linux；其他平台请使用系统包管理器",
        422
      );
    }
    if (this.installing) {
      throw installerError("INSTALLATION_IN_PROGRESS", "sing-box 正在安装或升级", 409);
    }
    this.installing = true;
    let backupCreated = false;
    let previous = null;
    let conflictingServiceState = null;
    let resolvedBinaryPath = null;
    const backupDir = join(this.dataDir, "sing-box-upgrade");
    const backupPath = join(backupDir, "sing-box.previous");
    try {
      previous = await this.status();
      if (!previous.installed) {
        throw installerError("RUNTIME_NOT_INSTALLED", "请先安装 sing-box", 409);
      }
      if (compareVersions(normalizedTarget, previous.version) <= 0) {
        return {
          ...previous,
          previousVersion: previous.version,
          alreadyCurrent: true,
          rolledBack: false
        };
      }
      if (
        this.runtimeMode === "systemd"
        && (!this.activeConfigPath || !await pathExists(this.activeConfigPath))
      ) {
        throw installerError(
          "RUNTIME_NOT_CONFIGURED",
          "当前 Runtime 没有活动配置，请先完成配置发布",
          409
        );
      }
      conflictingServiceState = await this.inspectConflictingSystemdService();
      if (conflictingServiceState?.active) {
        throw installerError(
          "RUNTIME_SERVICE_CONFLICT",
          "检测到非 RayLink 管理的 sing-box.service 正在运行，请先确认并停止该服务",
          409
        );
      }

      resolvedBinaryPath = await this.resolveBinaryPath();
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      await copyFile(resolvedBinaryPath, backupPath);
      await chmod(backupPath, 0o700);
      backupCreated = true;

      await this.installOfficialVersion(normalizedTarget);
      const installed = await this.status();
      if (installed.version !== normalizedTarget) {
        throw new Error(
          `升级后版本不匹配：期望 ${normalizedTarget}，实际 ${installed.version || "未知"}`
        );
      }
      if (this.activeConfigPath && await pathExists(this.activeConfigPath)) {
        await this.runner(this.binaryPath, ["check", "-c", this.activeConfigPath], {
          timeout: 15_000,
          maxBuffer: 1024 * 1024
        });
      }
      await this.disableConflictingSystemdService();
      if (this.runtimeMode === "systemd") {
        await this.restartAndVerify(normalizedTarget);
      }
      this.updateState = {
        ...this.updateState,
        status: "ready",
        currentVersion: normalizedTarget,
        newerVersionAvailable: false,
        updateAvailable: false,
        compatible: true,
        checkedAt: this.clock().toISOString(),
        error: undefined
      };
      return {
        ...installed,
        previousVersion: previous.version,
        rolledBack: false
      };
    } catch (error) {
      if (!backupCreated) {
        if (error.statusCode) throw error;
        throw installerError("RUNTIME_UPGRADE_FAILED", String(error.message || error), 500);
      }
      let packageMetadataRestored = true;
      try {
        if (normalizeVersion(previous?.version)) {
          try {
            await this.installOfficialVersion(previous.version);
          } catch {
            packageMetadataRestored = false;
          }
        }
        await copyFile(backupPath, resolvedBinaryPath);
        await chmod(resolvedBinaryPath, 0o755);
        await this.restoreConflictingSystemdService(conflictingServiceState);
        if (this.runtimeMode === "systemd") await this.restartAndVerify(previous?.version);
      } catch (rollbackError) {
        throw installerError(
          "RUNTIME_UPGRADE_ROLLBACK_FAILED",
          `sing-box 升级失败且自动回滚失败：${rollbackError.message}`,
          500
        );
      }
      if (!packageMetadataRestored) {
        throw installerError(
          "RUNTIME_UPGRADE_PARTIAL_ROLLBACK",
          `sing-box 升级失败，${previous?.version || "原版本"}二进制和服务已恢复，但包管理器元数据未能降级，请人工检查`,
          500
        );
      }
      throw installerError(
        "RUNTIME_UPGRADE_ROLLED_BACK",
        `sing-box 升级失败，已恢复 ${previous?.version || "原版本"}：${error.message}`,
        500
      );
    } finally {
      this.installing = false;
    }
  }

  async resolveBinaryPath() {
    if (isAbsolute(this.binaryPath)) return this.binaryPath;
    const { stdout } = await this.runner("which", [this.binaryPath], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024
    });
    const resolvedPath = String(stdout || "").trim().split(/\s+/)[0];
    if (!resolvedPath || !isAbsolute(resolvedPath)) {
      throw new Error("无法定位 sing-box 可执行文件");
    }
    return resolvedPath;
  }

  async restartAndVerify(expectedVersion) {
    await this.runner("systemctl", ["restart", this.systemdUnit], { timeout: 30_000 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { stdout } = await this.runner("systemctl", ["is-active", this.systemdUnit], {
        timeout: 10_000
      });
      if (String(stdout).trim() !== "active") {
        throw new Error(`${this.systemdUnit} 未恢复运行`);
      }
      if (attempt < 2 && this.healthCheckDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.healthCheckDelayMs));
      }
    }
    const running = await this.status();
    if (expectedVersion && running.version !== expectedVersion) {
      throw new Error(
        `${this.systemdUnit} 运行版本不匹配：期望 ${expectedVersion}，实际 ${running.version || "未知"}`
      );
    }
  }

  async installOfficialVersion(version) {
    await this.runner("sh", [
      "-c",
      `curl -fsSL https://sing-box.app/install.sh | sh -s -- --version ${version}`
    ], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024
    });
  }

  async inspectConflictingSystemdService() {
    if (
      this.platform !== "linux"
      || this.runtimeMode !== "systemd"
      || this.systemdUnit === "sing-box.service"
    ) return null;
    const { stdout } = await this.runner(
      "systemctl",
      ["list-unit-files", "sing-box.service", "--no-legend"],
      { timeout: 10_000 }
    );
    if (!String(stdout || "").includes("sing-box.service")) {
      return { exists: false, enabled: false, active: false };
    }
    const enabled = await this.systemdState("is-enabled", "sing-box.service");
    const active = await this.systemdState("is-active", "sing-box.service");
    return { exists: true, enabled: enabled === "enabled", active: active === "active" };
  }

  async systemdState(action, unit) {
    try {
      const { stdout } = await this.runner("systemctl", [action, unit], { timeout: 10_000 });
      return String(stdout || "").trim();
    } catch (error) {
      return String(error.stdout || "").trim();
    }
  }

  async disableConflictingSystemdService() {
    if (
      this.platform !== "linux"
      || this.runtimeMode !== "systemd"
      || this.systemdUnit === "sing-box.service"
    ) return;
    const { stdout } = await this.runner(
      "systemctl",
      ["list-unit-files", "sing-box.service", "--no-legend"],
      { timeout: 10_000 }
    );
    if (!String(stdout || "").includes("sing-box.service")) return;
    await this.runner("systemctl", ["disable", "--now", "sing-box.service"], {
      timeout: 30_000
    });
  }

  async restoreConflictingSystemdService(previousState) {
    if (!previousState) return;
    const { stdout } = await this.runner(
      "systemctl",
      ["list-unit-files", "sing-box.service", "--no-legend"],
      { timeout: 10_000 }
    );
    if (!String(stdout || "").includes("sing-box.service")) return;
    await this.runner(
      "systemctl",
      [previousState.enabled ? "enable" : "disable", "sing-box.service"],
      { timeout: 30_000 }
    );
    await this.runner(
      "systemctl",
      [previousState.active ? "start" : "stop", "sing-box.service"],
      { timeout: 30_000 }
    );
  }

  async generateRealityKeypair() {
    const status = await this.status();
    if (!status.installed) throw installerError("RUNTIME_NOT_INSTALLED", "请先安装 sing-box", 409);
    const { stdout } = await this.runner(this.binaryPath, ["generate", "reality-keypair"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
    const privateKey = String(stdout).match(/PrivateKey:\s*(\S+)/)?.[1];
    const publicKey = String(stdout).match(/PublicKey:\s*(\S+)/)?.[1];
    if (!privateKey || !publicKey) {
      throw installerError("KEYPAIR_GENERATION_FAILED", "sing-box 未返回有效的 Reality 密钥对", 500);
    }
    return { privateKey, publicKey, shortId: randomBytes(8).toString("hex") };
  }
}

function parseVersionOutput(stdout, binaryPath, fallbackPlatform) {
  const output = String(stdout || "");
  const version = output.match(/sing-box version\s+([^\s]+)/i)?.[1] || null;
  const environment = output.match(/Environment:\s+\S+\s+([^/\s]+)\/([^\s]+)/i);
  const tags = output.match(/Tags:\s*(.+)/i)?.[1]
    ?.split(",")
    .map((tag) => tag.trim())
    .filter(Boolean) || [];
  return {
    installed: Boolean(version),
    version,
    platform: normalizePlatform(environment?.[1] || fallbackPlatform),
    architecture: environment?.[2] || null,
    tags,
    binaryPath
  };
}

function normalizePlatform(value) {
  return value === "windows" ? "win32" : value;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+\.\d+\.\d+)$/);
  return match?.[1] || null;
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left)?.split(".").map(Number);
  const rightParts = normalizeVersion(right)?.split(".").map(Number);
  if (!leftParts || !rightParts) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function isSupportedVersion(version) {
  return String(version).startsWith(`${SUPPORTED_VERSION_SERIES}.`);
}

function installerError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
