#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { arch, cpus, freemem, hostname, platform, totalmem } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const AGENT_VERSION = "0.4.0";

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args, options = {}) {
  try {
    return await execFile(command, args, {
      timeout: options.timeout || 30_000,
      maxBuffer: options.maxBuffer || 1024 * 1024
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message).trim();
    throw new Error(detail || `${command} 执行失败`);
  }
}

function cpuTimesSnapshot() {
  return cpus().reduce((totals, cpu) => {
    const times = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    totals.idle += cpu.times.idle;
    totals.total += times;
    return totals;
  }, { idle: 0, total: 0 });
}

async function networkBytesSnapshot() {
  if (platform() !== "linux") return { networkRxBytes: null, networkTxBytes: null };
  try {
    const content = await readFile("/proc/net/dev", "utf8");
    return content.split("\n").slice(2).reduce((totals, line) => {
      const [interfaceName, counters] = line.trim().split(/\s*:\s*/);
      if (!interfaceName || !counters || interfaceName === "lo") return totals;
      const fields = counters.trim().split(/\s+/).map(Number);
      totals.networkRxBytes += Number.isFinite(fields[0]) ? fields[0] : 0;
      totals.networkTxBytes += Number.isFinite(fields[8]) ? fields[8] : 0;
      return totals;
    }, { networkRxBytes: 0, networkTxBytes: 0 });
  } catch {
    return { networkRxBytes: null, networkTxBytes: null };
  }
}

async function systemSample() {
  const memoryTotalBytes = totalmem();
  return {
    cpu: cpuTimesSnapshot(),
    memoryUsedBytes: memoryTotalBytes - freemem(),
    memoryTotalBytes,
    ...await networkBytesSnapshot()
  };
}

async function serviceState(systemdUnit) {
  if (platform() !== "linux") return "unknown";
  try {
    const { stdout } = await execFile("systemctl", ["is-active", systemdUnit], { timeout: 5_000 });
    return String(stdout).trim() === "active" ? "running" : "stopped";
  } catch (error) {
    return String(error.stdout || "").trim() === "inactive" ? "stopped" : "failed";
  }
}

export class NodeTelemetryCollector {
  constructor(options = {}) {
    this.sampleProvider = options.sampleProvider || systemSample;
    this.serviceProvider = options.serviceProvider
      || (() => serviceState(options.systemdUnit || "raylink-sing-box.service"));
    this.clock = options.clock || Date.now;
    this.previous = null;
  }

  async collect() {
    const sample = await this.sampleProvider();
    const timestamp = this.clock();
    const elapsedSeconds = this.previous
      ? Math.max(0.001, (timestamp - this.previous.timestamp) / 1000)
      : null;
    const cpuTotalDelta = this.previous ? sample.cpu.total - this.previous.sample.cpu.total : 0;
    const cpuIdleDelta = this.previous ? sample.cpu.idle - this.previous.sample.cpu.idle : 0;
    const cpuPercent = cpuTotalDelta > 0
      ? Math.max(0, Math.min(100, ((cpuTotalDelta - cpuIdleDelta) / cpuTotalDelta) * 100))
      : 0;
    const byteRate = (current, previous) => {
      if (
        elapsedSeconds === null
        || !Number.isFinite(current)
        || !Number.isFinite(previous)
        || current < previous
      ) return 0;
      return ((current - previous) * 8) / elapsedSeconds;
    };
    const telemetry = {
      cpuPercent: Number(cpuPercent.toFixed(1)),
      memoryUsedBytes: sample.memoryUsedBytes,
      memoryTotalBytes: sample.memoryTotalBytes,
      networkRxBytes: sample.networkRxBytes,
      networkTxBytes: sample.networkTxBytes,
      networkRxBps: byteRate(sample.networkRxBytes, this.previous?.sample.networkRxBytes),
      networkTxBps: byteRate(sample.networkTxBytes, this.previous?.sample.networkTxBytes),
      serviceStatus: await this.serviceProvider()
    };
    this.previous = { sample, timestamp };
    return telemetry;
  }
}

export class NodeRuntimeAdapter {
  constructor(options = {}) {
    this.dataDir = options.dataDir || "/var/lib/raylink-node/sing-box";
    this.binaryPath = options.binaryPath || "sing-box";
    this.systemdUnit = options.systemdUnit || "raylink-sing-box.service";
    this.runtimeMode = options.runtimeMode || "systemd";
    this.commandRunner = options.commandRunner || runCommand;
    this.healthCheckDelayMs = Math.max(0, Number(options.healthCheckDelayMs ?? 2_000) || 0);
  }

  get configPath() {
    return join(this.dataDir, "config.json");
  }

  async publish(task) {
    if (!task?.configText) throw new Error("发布任务缺少 sing-box 配置");
    await mkdir(this.dataDir, { recursive: true, mode: 0o750 });
    const temporaryPath = join(this.dataDir, `.config-${process.pid}-${Date.now()}.json`);
    const backupPath = join(this.dataDir, "config.previous.json");
    const hadConfig = await pathExists(this.configPath);
    await writeFile(temporaryPath, `${task.configText.trim()}\n`, { mode: 0o640 });

    try {
      await this.commandRunner(this.binaryPath, ["check", "-c", temporaryPath]);
      if (hadConfig) await copyFile(this.configPath, backupPath);
      await rename(temporaryPath, this.configPath);
      if (this.runtimeMode === "systemd") {
        try {
          await this.commandRunner("systemctl", ["restart", this.systemdUnit]);
        } catch (error) {
          if (hadConfig && await pathExists(backupPath)) {
            await copyFile(backupPath, this.configPath);
            await this.commandRunner("systemctl", ["restart", this.systemdUnit]).catch(() => {});
          } else {
            await rm(this.configPath, { force: true });
          }
          throw error;
        }
      }
      const version = await this.commandRunner(this.binaryPath, ["version"]);
      return {
        runtimeVersion: version.stdout.match(/sing-box version\s+([^\s]+)/i)?.[1] || "unknown",
        configPath: this.configPath,
        version: task.version,
        checksum: task.checksum
      };
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async resolveBinaryPath() {
    if (isAbsolute(this.binaryPath)) return this.binaryPath;
    const { stdout } = await this.commandRunner("which", [this.binaryPath]);
    const resolvedPath = String(stdout || "").trim().split(/\s+/)[0];
    if (!resolvedPath || !isAbsolute(resolvedPath)) {
      throw new Error("无法定位 sing-box 可执行文件");
    }
    return resolvedPath;
  }

  async restartAndVerify(expectedVersion) {
    await this.commandRunner("systemctl", ["restart", this.systemdUnit]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { stdout } = await this.commandRunner("systemctl", ["is-active", this.systemdUnit]);
      if (String(stdout).trim() !== "active") {
        throw new Error(`${this.systemdUnit} 未恢复运行`);
      }
      if (attempt < 2 && this.healthCheckDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.healthCheckDelayMs));
      }
    }
    const version = await this.commandRunner(this.binaryPath, ["version"]);
    const runtimeVersion = version.stdout.match(/sing-box version\s+([^\s]+)/i)?.[1] || "unknown";
    if (expectedVersion && runtimeVersion !== expectedVersion) {
      throw new Error(
        `${this.systemdUnit} 运行版本不匹配：期望 ${expectedVersion}，实际 ${runtimeVersion}`
      );
    }
  }

  async installOfficialVersion(version) {
    await this.commandRunner("sh", [
      "-c",
      `curl -fsSL https://sing-box.app/install.sh | sh -s -- --version ${version}`
    ], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024
    });
  }

  async commandState(action, unit) {
    try {
      const { stdout } = await this.commandRunner("systemctl", [action, unit]);
      return String(stdout || "").trim();
    } catch (error) {
      return String(error.stdout || error.message || "").trim();
    }
  }

  async inspectConflictingSystemdService() {
    if (this.runtimeMode !== "systemd" || this.systemdUnit === "sing-box.service") return null;
    const units = await this.commandRunner(
      "systemctl",
      ["list-unit-files", "sing-box.service", "--no-legend"]
    );
    if (!String(units.stdout || "").includes("sing-box.service")) {
      return { exists: false, enabled: false, active: false };
    }
    return {
      exists: true,
      enabled: await this.commandState("is-enabled", "sing-box.service") === "enabled",
      active: await this.commandState("is-active", "sing-box.service") === "active"
    };
  }

  async disableConflictingSystemdService() {
    if (this.runtimeMode !== "systemd" || this.systemdUnit === "sing-box.service") return;
    const units = await this.commandRunner(
      "systemctl",
      ["list-unit-files", "sing-box.service", "--no-legend"]
    );
    if (String(units.stdout || "").includes("sing-box.service")) {
      await this.commandRunner("systemctl", ["disable", "--now", "sing-box.service"]);
    }
  }

  async restoreConflictingSystemdService(previousState) {
    if (!previousState) return;
    const units = await this.commandRunner(
      "systemctl",
      ["list-unit-files", "sing-box.service", "--no-legend"]
    );
    if (!String(units.stdout || "").includes("sing-box.service")) return;
    await this.commandRunner(
      "systemctl",
      [previousState.enabled ? "enable" : "disable", "sing-box.service"]
    );
    await this.commandRunner(
      "systemctl",
      [previousState.active ? "start" : "stop", "sing-box.service"]
    );
  }

  async upgrade(task) {
    const targetVersion = String(task?.targetVersion || "");
    if (!/^1\.13\.\d+$/.test(targetVersion)) {
      throw new Error("RayLink 当前只支持升级到 sing-box 1.13.x 稳定版本");
    }
    await mkdir(this.dataDir, { recursive: true, mode: 0o750 });
    const resolvedBinaryPath = await this.resolveBinaryPath();
    const backupPath = join(this.dataDir, "sing-box.previous.binary");
    const previous = await this.commandRunner(this.binaryPath, ["version"]);
    const previousVersion = previous.stdout.match(/sing-box version\s+([^\s]+)/i)?.[1] || "unknown";
    if (previousVersion === targetVersion) {
      return { runtimeVersion: targetVersion, previousVersion, alreadyCurrent: true, rolledBack: false };
    }
    if (!await pathExists(this.configPath)) {
      throw new Error("当前 Runtime 没有活动配置，请先完成配置发布");
    }
    const conflictingServiceState = await this.inspectConflictingSystemdService();
    if (conflictingServiceState?.active) {
      throw new Error(
        "检测到非 RayLink 管理的 sing-box.service 正在运行，请先确认并停止该服务"
      );
    }
    await copyFile(resolvedBinaryPath, backupPath);
    await chmod(backupPath, 0o700);

    try {
      await this.installOfficialVersion(targetVersion);
      const installed = await this.commandRunner(this.binaryPath, ["version"]);
      const runtimeVersion = installed.stdout.match(/sing-box version\s+([^\s]+)/i)?.[1] || "unknown";
      if (runtimeVersion !== targetVersion) {
        throw new Error(`升级后版本不匹配：期望 ${targetVersion}，实际 ${runtimeVersion}`);
      }
      const hasConfig = await pathExists(this.configPath);
      if (hasConfig) {
        await this.commandRunner(this.binaryPath, ["check", "-c", this.configPath]);
        await this.disableConflictingSystemdService();
        if (this.runtimeMode === "systemd") await this.restartAndVerify(targetVersion);
      }
      return { runtimeVersion, previousVersion, rolledBack: false };
    } catch (error) {
      let packageMetadataRestored = true;
      try {
        if (/^\d+\.\d+\.\d+$/.test(previousVersion)) {
          try {
            await this.installOfficialVersion(previousVersion);
          } catch {
            packageMetadataRestored = false;
          }
        }
        await copyFile(backupPath, resolvedBinaryPath);
        await chmod(resolvedBinaryPath, 0o755);
        await this.restoreConflictingSystemdService(conflictingServiceState);
        if (this.runtimeMode === "systemd" && await pathExists(this.configPath)) {
          await this.restartAndVerify(previousVersion);
        }
      } catch (rollbackError) {
        const failure = new Error(`sing-box 升级失败且回滚失败：${rollbackError.message}`);
        failure.rolledBack = false;
        failure.previousVersion = previousVersion;
        throw failure;
      }
      if (!packageMetadataRestored) {
        const failure = new Error(
          `sing-box 升级失败，已恢复 ${previousVersion} 二进制和服务，但包管理器元数据未能降级`
        );
        failure.rolledBack = true;
        failure.packageMetadataRestored = false;
        failure.previousVersion = previousVersion;
        throw failure;
      }
      const failure = new Error(`sing-box 升级失败，已回滚到 ${previousVersion}：${error.message}`);
      failure.rolledBack = true;
      failure.packageMetadataRestored = true;
      failure.previousVersion = previousVersion;
      throw failure;
    }
  }
}

export async function collectNodeMetadata(binaryPath = "sing-box", telemetryCollector = null) {
  let runtimeVersion = null;
  let buildTags = [];
  try {
    const result = await runCommand(binaryPath, ["version"]);
    runtimeVersion = result.stdout.match(/sing-box version\s+([^\s]+)/i)?.[1] || null;
    const tags = result.stdout.match(/Tags:\s*(.+)/i)?.[1];
    buildTags = tags ? tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
  } catch {
    // The installer may enroll before the runtime is available.
  }
  return {
    hostname: hostname(),
    platform: platform(),
    architecture: arch(),
    agentVersion: AGENT_VERSION,
    runtimeVersion,
    buildTags,
    telemetry: telemetryCollector ? await telemetryCollector.collect() : undefined
  };
}

export class RayLinkNode {
  constructor(options = {}) {
    this.serverUrl = String(options.serverUrl || "").replace(/\/+$/, "");
    this.enrollmentToken = options.enrollmentToken || "";
    this.statePath = options.statePath || "/etc/raylink-node/node.json";
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.runtimeAdapter = options.runtimeAdapter || new NodeRuntimeAdapter(options);
    this.telemetryCollector = options.telemetryCollector || new NodeTelemetryCollector({
      systemdUnit: this.runtimeAdapter.systemdUnit
    });
    this.metadataProvider = options.metadataProvider
      || (() => collectNodeMetadata(this.runtimeAdapter.binaryPath, this.telemetryCollector));
    this.pollIntervalMs = Number(options.pollIntervalMs || 10_000);
    this.state = null;
  }

  async request(path, init = {}) {
    const response = await this.fetchFn(`${this.serverUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {})
      }
    });
    if (!response.ok) {
      let message = `控制面请求失败（HTTP ${response.status}）`;
      try {
        const body = await response.json();
        message = body.error || body.message || message;
      } catch {
        // Keep the status-based message when the response is not JSON.
      }
      throw new Error(message);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async loadState() {
    if (this.state) return this.state;
    try {
      this.state = JSON.parse(await readFile(this.statePath, "utf8"));
      if (!this.state.hostId || !this.state.nodeSecret) throw new Error("节点凭据不完整");
      return this.state;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async persistState(state) {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.statePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.statePath);
    await chmod(this.statePath, 0o600);
    this.state = state;
  }

  async ensureEnrolled() {
    const existing = await this.loadState();
    if (existing) return existing;
    if (!this.serverUrl) throw new Error("缺少 RAYLINK_SERVER");
    if (!this.enrollmentToken) throw new Error("缺少 RAYLINK_ENROLL_TOKEN");
    const metadata = await this.metadataProvider();
    const credential = await this.request("/api/node/enroll", {
      method: "POST",
      body: JSON.stringify({ token: this.enrollmentToken, ...metadata })
    });
    const state = { hostId: credential.hostId, nodeSecret: credential.nodeSecret };
    await this.persistState(state);
    return state;
  }

  async authenticatedRequest(path, init = {}) {
    const state = await this.ensureEnrolled();
    return this.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${state.nodeSecret}`,
        "x-raylink-host-id": state.hostId,
        ...(init.headers || {})
      }
    });
  }

  async completeTask(taskId, attempt, status, result) {
    return this.authenticatedRequest(`/api/node/tasks/${encodeURIComponent(taskId)}/complete`, {
      method: "POST",
      body: JSON.stringify({ attempt, status, result })
    });
  }

  async pollOnce() {
    const metadata = await this.metadataProvider();
    await this.authenticatedRequest("/api/node/heartbeat", {
      method: "POST",
      body: JSON.stringify(metadata)
    });
    const task = await this.authenticatedRequest("/api/node/tasks/next");
    if (!task) return false;
    try {
      const result = task.kind === "publish-config"
        ? await this.runtimeAdapter.publish(task.payload)
        : task.kind === "upgrade-runtime"
          ? await this.runtimeAdapter.upgrade(task.payload)
          : (() => { throw new Error(`不支持的节点任务：${task.kind}`); })();
      await this.completeTask(task.id, task.attempt, "succeeded", result);
    } catch (error) {
      await this.completeTask(task.id, task.attempt, "failed", {
        error: error.message,
        ...(error.previousVersion ? { previousVersion: error.previousVersion } : {}),
        ...(typeof error.rolledBack === "boolean" ? { rolledBack: error.rolledBack } : {}),
        ...(typeof error.packageMetadataRestored === "boolean"
          ? { packageMetadataRestored: error.packageMetadataRestored }
          : {})
      });
    }
    return true;
  }

  async run() {
    let delayMs = this.pollIntervalMs;
    for (;;) {
      try {
        const handledTask = await this.pollOnce();
        delayMs = handledTask ? 500 : this.pollIntervalMs;
      } catch (error) {
        console.error(`[RayLink Node] ${new Date().toISOString()} ${error.message}`);
        delayMs = Math.min(Math.max(delayMs * 2, 5_000), 60_000);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main() {
  const node = new RayLinkNode({
    serverUrl: process.env.RAYLINK_SERVER,
    enrollmentToken: process.env.RAYLINK_ENROLL_TOKEN,
    statePath: process.env.RAYLINK_NODE_STATE,
    dataDir: process.env.RAYLINK_NODE_DATA,
    binaryPath: process.env.SING_BOX_BIN,
    systemdUnit: process.env.SING_BOX_SYSTEMD_UNIT,
    runtimeMode: process.env.RAYLINK_RUNTIME_MODE
  });
  await node.run();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[RayLink Node] 启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
