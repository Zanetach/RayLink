import { execFile as execFileCallback } from "node:child_process";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function commandFailure(error, fallback) {
  const detail = String(error.stderr || error.stdout || error.message || fallback).trim();
  const wrapped = new Error(detail || fallback);
  wrapped.cause = error;
  return wrapped;
}

export class LocalSingBoxAdapter {
  constructor({
    dataDir,
    binaryPath = "sing-box",
    mode = "dry-run",
    systemdUnit = "sing-box.service"
  }) {
    if (!["dry-run", "systemd"].includes(mode)) throw new Error(`Unsupported runtime mode: ${mode}`);
    if (!/^[a-zA-Z0-9@_.-]+$/.test(systemdUnit)) throw new Error("Invalid systemd unit");
    this.runtimeDir = join(dataDir, "sing-box");
    this.activePath = join(this.runtimeDir, "config.json");
    this.backupPath = join(this.runtimeDir, "config.json.bak");
    this.binaryPath = binaryPath;
    this.mode = mode;
    this.systemdUnit = systemdUnit;
  }

  async binaryVersion() {
    try {
      const { stdout } = await execFile(this.binaryPath, ["version"], { timeout: 5_000 });
      return String(stdout).match(/sing-box version\s+([^\s]+)/i)?.[1] || String(stdout).trim() || null;
    } catch (error) {
      if (error.code === "ENOENT" && this.mode === "dry-run") return null;
      throw commandFailure(error, "无法读取 sing-box 版本");
    }
  }

  async validate(candidatePath) {
    try {
      await execFile(this.binaryPath, ["check", "-c", candidatePath], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024
      });
      return "sing-box";
    } catch (error) {
      if (error.code === "ENOENT" && this.mode === "dry-run") {
        JSON.parse(await readFile(candidatePath, "utf8"));
        return "json-only";
      }
      throw commandFailure(error, "sing-box 配置校验失败");
    }
  }

  async restartSystemd() {
    try {
      await execFile("systemctl", ["restart", this.systemdUnit], { timeout: 20_000 });
      const { stdout } = await execFile("systemctl", ["is-active", this.systemdUnit], { timeout: 10_000 });
      if (String(stdout).trim() !== "active") throw new Error(`${this.systemdUnit} is not active`);
    } catch (error) {
      throw commandFailure(error, "sing-box 服务重启失败");
    }
  }

  async publish({ version, checksum, configText }) {
    JSON.parse(configText);
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    const safeVersion = version.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const candidatePath = join(this.runtimeDir, `config.${safeVersion}.tmp`);
    await writeFile(candidatePath, configText, { mode: 0o600 });

    try {
      const validation = await this.validate(candidatePath);
      let hadActiveConfig = false;
      try {
        await access(this.activePath);
        hadActiveConfig = true;
        await copyFile(this.activePath, this.backupPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }

      await rename(candidatePath, this.activePath);
      if (this.mode === "systemd") {
        try {
          await this.restartSystemd();
        } catch (error) {
          if (hadActiveConfig) {
            await copyFile(this.backupPath, this.activePath);
            await this.restartSystemd().catch(() => {});
          } else {
            await rm(this.activePath, { force: true });
          }
          throw error;
        }
      }

      return {
        mode: this.mode,
        configPath: this.activePath,
        checksum,
        validation,
        runtimeVersion: await this.binaryVersion()
      };
    } finally {
      await rm(candidatePath, { force: true });
    }
  }

  async status() {
    let configPresent = false;
    try {
      await access(this.activePath);
      configPresent = true;
    } catch {}

    if (this.mode === "dry-run") {
      return {
        state: configPresent ? "staged" : "not-configured",
        mode: this.mode,
        configPath: this.activePath,
        runtimeVersion: await this.binaryVersion()
      };
    }

    try {
      const { stdout } = await execFile("systemctl", ["is-active", this.systemdUnit], { timeout: 10_000 });
      return {
        state: String(stdout).trim() === "active" ? "running" : "stopped",
        mode: this.mode,
        configPath: this.activePath,
        runtimeVersion: await this.binaryVersion()
      };
    } catch {
      return {
        state: "stopped",
        mode: this.mode,
        configPath: this.activePath,
        runtimeVersion: null
      };
    }
  }
}
