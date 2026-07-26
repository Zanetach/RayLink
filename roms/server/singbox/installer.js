import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { platform as currentPlatform } from "node:os";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export class SingBoxInstaller {
  constructor({
    binaryPath = "sing-box",
    platform = currentPlatform(),
    runner = execFile
  } = {}) {
    this.binaryPath = binaryPath;
    this.platform = platform;
    this.runner = runner;
    this.installing = false;
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
      if (existing.installed) return { ...existing, alreadyInstalled: true };
      if (this.platform === "darwin") {
        await this.runner("brew", ["install", "sing-box"], {
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
      return installed;
    } catch (error) {
      if (error.statusCode) throw error;
      throw installerError("INSTALLATION_FAILED", String(error.stderr || error.message || "sing-box 安装失败"), 500);
    } finally {
      this.installing = false;
    }
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

function installerError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
