import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const BBR_CONFIG = [
  "# Managed by RayLink. Changes may be replaced during initialization.",
  "net.core.default_qdisc = fq",
  "net.ipv4.tcp_congestion_control = bbr",
  ""
].join("\n");

function bbrError(code, message, cause, statusCode = 500) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export class BbrManager {
  constructor({
    mode = "dry-run",
    configPath = "/var/lib/raylink/managed/99-raylink-bbr.conf",
    runCommand = (command, args) => execFile(command, args, {
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    })
  } = {}) {
    this.mode = mode;
    this.configPath = configPath;
    this.runCommand = runCommand;
  }

  async readParameter(key) {
    const { stdout } = await this.runCommand("sysctl", ["-n", key]);
    return String(stdout || "").trim();
  }

  async inspect() {
    if (this.mode !== "systemd") {
      return {
        status: "development",
        congestionControl: null,
        qdisc: null
      };
    }
    try {
      const [available, congestionControl, qdisc] = await Promise.all([
        this.readParameter("net.ipv4.tcp_available_congestion_control"),
        this.readParameter("net.ipv4.tcp_congestion_control"),
        this.readParameter("net.core.default_qdisc")
      ]);
      return {
        status: congestionControl === "bbr" && qdisc === "fq"
          ? "enabled"
          : available.split(/\s+/).includes("bbr")
            ? "available"
            : "unsupported",
        congestionControl,
        qdisc
      };
    } catch {
      return {
        status: "unavailable",
        congestionControl: null,
        qdisc: null
      };
    }
  }

  async configure() {
    if (this.mode !== "systemd") return this.inspect();
    try {
      await this.runCommand("modprobe", ["tcp_bbr"]);
    } catch {
      // Some kernels compile BBR in directly and do not expose a loadable module.
    }
    const capability = await this.inspect();
    if (!["available", "enabled"].includes(capability.status)) {
      throw bbrError(
        "BBR_UNAVAILABLE",
        capability.status === "unsupported"
          ? "当前 Linux 内核不支持 BBR，请升级内核后重试初始化"
          : "无法读取 Linux 网络拥塞控制能力",
        undefined,
        409
      );
    }

    await mkdir(dirname(this.configPath), { recursive: true });
    const temporaryPath = `${this.configPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, BBR_CONFIG, { mode: 0o644 });
      await rename(temporaryPath, this.configPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw bbrError("BBR_CONFIG_WRITE_FAILED", "无法持久化 BBR 内核参数", error);
    }

    try {
      await this.runCommand("sysctl", ["-p", this.configPath]);
    } catch (error) {
      throw bbrError("BBR_APPLY_FAILED", "BBR 内核参数应用失败", error);
    }
    const active = await this.inspect();
    if (active.status !== "enabled") {
      throw bbrError("BBR_VERIFICATION_FAILED", "BBR 配置完成但内核状态验证未通过");
    }
    return active;
  }
}
