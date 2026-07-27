import { execFile as execFileCallback } from "node:child_process";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import { promisify } from "node:util";

import {
  protocolAvailability,
  protocolCatalog
} from "./singbox/protocol-catalog.js";

const execFile = promisify(execFileCallback);

const policies = new Map([
  ["shadowsocks", { group: "one-click", network: "tcp", exposure: "public", tls: "none" }],
  ["vmess", { group: "one-click", network: "tcp", exposure: "public", tls: "reality" }],
  ["vless", { group: "one-click", network: "tcp", exposure: "public", tls: "reality" }],
  ["trojan", { group: "tls", network: "tcp", exposure: "public", tls: "reality" }],
  ["naive", { group: "tls", network: "tcp", exposure: "public", tls: "acme" }],
  ["anytls", { group: "tls", network: "tcp", exposure: "public", tls: "reality" }],
  ["hysteria", { group: "udp-tls", network: "udp", exposure: "public", tls: "acme" }],
  ["tuic", { group: "udp-tls", network: "udp", exposure: "public", tls: "acme" }],
  ["hysteria2", { group: "udp-tls", network: "udp", exposure: "public", tls: "acme" }],
  ["socks", { group: "private", network: "tcp", exposure: "private", tls: "none" }],
  ["http", { group: "private", network: "tcp", exposure: "private", tls: "none" }],
  ["mixed", { group: "private", network: "tcp", exposure: "private", tls: "none" }],
  ["shadowtls", { group: "advanced", network: "tcp", exposure: "advanced", tls: "manual" }],
  ["direct", { group: "advanced", network: "tcp", exposure: "advanced", tls: "manual" }],
  ["tun", { group: "advanced", network: "system", exposure: "advanced", tls: "manual" }],
  ["redirect", { group: "advanced", network: "tcp", exposure: "advanced", tls: "manual" }],
  ["tproxy", { group: "advanced", network: "tcp", exposure: "advanced", tls: "manual" }]
]);

function activationError(code, message, statusCode = 422) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export function protocolActivationPolicy(type) {
  const policy = policies.get(type);
  if (!policy) throw activationError("PROTOCOL_NOT_FOUND", "sing-box 入站协议不存在", 404);
  return { ...policy };
}

function isDomain(value) {
  return Boolean(value)
    && net.isIP(value) === 0
    && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
}

function listenHostForProbe(listen) {
  if (listen === "::" || listen === "0.0.0.0") return "127.0.0.1";
  return listen;
}

function waitForSocket(socket, timeoutMs, onReady) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try {
        socket.close?.();
      } catch {}
      try {
        socket.destroy?.();
      } catch {}
      reject(new Error("端口操作超时"));
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    onReady(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function tcpPortAvailable(host, port) {
  const server = net.createServer();
  try {
    await waitForSocket(server, 2_000, (ready) => {
      server.listen({ host, port, exclusive: true }, ready);
    });
    return true;
  } catch (error) {
    if (error.code === "EADDRINUSE" || error.code === "EACCES") return false;
    throw error;
  } finally {
    await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
  }
}

async function udpPortAvailable(host, port) {
  const family = host.includes(":") ? "udp6" : "udp4";
  const socket = dgram.createSocket(family);
  try {
    await waitForSocket(socket, 2_000, (ready) => {
      socket.bind({ address: host, port, exclusive: true }, ready);
    });
    return true;
  } catch (error) {
    if (error.code === "EADDRINUSE" || error.code === "EACCES") return false;
    throw error;
  } finally {
    try {
      socket.close();
    } catch {}
  }
}

export class LocalPortManager {
  async available({ listen, port, network }) {
    return network === "udp"
      ? udpPortAvailable(listen, port)
      : tcpPortAvailable(listen, port);
  }

  async findAvailable({ preferredPort, listen, network, usedPorts = [] }) {
    const reserved = new Set(usedPorts);
    for (let offset = 0; offset <= 200; offset += 1) {
      const port = preferredPort + offset;
      if (port > 65_535 || reserved.has(port)) continue;
      if (await this.available({ listen, port, network })) return port;
    }
    throw activationError(
      "NO_AVAILABLE_PROTOCOL_PORT",
      `从 ${preferredPort} 开始未找到可用的 ${network.toUpperCase()} 端口`,
      409
    );
  }

  async waitForListening({ listen, port, network, timeoutMs = 8_000 }) {
    const deadline = Date.now() + timeoutMs;
    const host = listenHostForProbe(listen);
    while (Date.now() < deadline) {
      if (network === "udp") {
        if (!await udpPortAvailable(listen, port)) return true;
      } else {
        try {
          await new Promise((resolve, reject) => {
            const socket = net.connect({ host, port });
            socket.setTimeout(1_000);
            socket.once("connect", () => {
              socket.destroy();
              resolve();
            });
            socket.once("timeout", () => {
              socket.destroy();
              reject(new Error("timeout"));
            });
            socket.once("error", reject);
          });
          return true;
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw activationError("PROTOCOL_NOT_LISTENING", `端口 ${port}/${network} 未开始监听`, 502);
  }
}

export class UfwFirewallManager {
  constructor({ commandRunner = execFile, enabled = true } = {}) {
    this.commandRunner = commandRunner;
    this.enabled = enabled;
  }

  async open({ port, network }) {
    if (!this.enabled) return { managed: false, rollback: async () => {} };
    let status;
    try {
      status = await this.commandRunner("ufw", ["status"]);
    } catch (error) {
      if (error.code === "ENOENT") return { managed: false, rollback: async () => {} };
      throw error;
    }
    if (!/^Status:\s+active/im.test(String(status.stdout || ""))) {
      return { managed: false, rollback: async () => {} };
    }
    const rule = `${port}/${network}`;
    if (
      String(status.stdout || "").split("\n").some((line) => (
        new RegExp(`^\\s*${port}\\/${network}\\s+ALLOW\\b`, "i").test(line)
      ))
    ) {
      return { managed: false, preexisting: true, rule, rollback: async () => {} };
    }
    await this.commandRunner("ufw", ["allow", rule, "comment", "RayLink managed"]);
    return {
      managed: true,
      rule,
      rollback: async () => {
        await this.commandRunner("ufw", ["--force", "delete", "allow", rule]);
      }
    };
  }
}

export class PublicConnectivityProbe {
  async verify({ address, port, network, timeoutMs = 5_000 }) {
    if (network === "udp") {
      return {
        reachable: null,
        reason: "UDP 公网握手需要协议级外部探针；已完成本机监听与防火墙验证"
      };
    }
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: address, port });
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("timeout", () => {
        socket.destroy();
        reject(activationError("PUBLIC_PORT_UNREACHABLE", `公网端口 ${address}:${port} 连接超时`, 502));
      });
      socket.once("error", (error) => {
        reject(activationError(
          "PUBLIC_PORT_UNREACHABLE",
          `公网端口 ${address}:${port} 不可达：${error.message}`,
          502
        ));
      });
    });
    return { reachable: true };
  }
}

export class ProtocolActivationManager {
  constructor({
    store,
    runtimeManager,
    installer,
    portManager = new LocalPortManager(),
    firewallManager = new UfwFirewallManager(),
    publicProbe = new PublicConnectivityProbe(),
    protocolProbe = null,
    certificateEmail = () => "",
    certificateProvider = null,
    randomBytes = cryptoRandomBytes,
    runtimeMode = "systemd"
  }) {
    this.store = store;
    this.runtimeManager = runtimeManager;
    this.installer = installer;
    this.portManager = portManager;
    this.firewallManager = firewallManager;
    this.publicProbe = publicProbe;
    this.protocolProbe = protocolProbe;
    this.certificateEmail = certificateEmail;
    this.certificateProvider = certificateProvider;
    this.randomBytes = randomBytes;
    this.runtimeMode = runtimeMode;
    this.activating = new Set();
  }

  record(hostId, type, state, extra = {}) {
    return this.store.setProtocolActivation(hostId, type, {
      state,
      updatedAt: new Date().toISOString(),
      ...extra
    });
  }

  async installationFor(host) {
    if (host.id === "local") return this.installer.status();
    return host.runtimeVersion
      ? {
          installed: true,
          version: host.runtimeVersion,
          platform: host.platform,
          tags: host.buildTags
        }
      : null;
  }

  async assertAvailable(host, type) {
    const catalog = protocolCatalog.find((entry) => entry.type === type);
    const installation = await this.installationFor(host);
    if (!installation) {
      throw activationError(
        "HOST_CAPABILITIES_UNKNOWN",
        "远程主机尚未上报 sing-box 能力，请先完成 RayLink Node 接入",
        409
      );
    }
    const availability = protocolAvailability(catalog, installation);
    if (!availability.available) {
      throw activationError(
        "PROTOCOL_UNAVAILABLE",
        !availability.versionSupported
          ? `RayLink 当前协议 schema 支持 sing-box 1.13.x，检测到 ${installation.version || "未知版本"}`
          : availability.platformSupported
            ? `当前 sing-box 构建缺少 ${availability.missingTags.join(", ") || "所需能力"}`
            : `当前平台不支持 ${catalog.name}`
      );
    }
    return { catalog, availability, installation };
  }

  async prepare(host, type, policy, catalog, profiles) {
    const current = profiles.find((profile) => profile.type === type);
    if (!current) throw activationError("PROTOCOL_NOT_FOUND", "sing-box 入站协议不存在", 404);
    const listen = policy.exposure === "private" ? "127.0.0.1" : "::";
    const usedPorts = profiles
      .filter((profile) => profile.type !== type && profile.enabled && profile.port)
      .map((profile) => profile.port);
    const lastActivation = host.protocolActivations?.find((item) => item.type === type);
    const preferredPort = lastActivation?.errorCode === "PROTOCOL_PORT_OCCUPIED"
      && Number.isInteger(lastActivation.suggestedPort)
      ? lastActivation.suggestedPort
      : current.port || catalog.defaultPort;
    const port = catalog.portless
      ? null
      : host.kind === "remote"
        ? (() => {
            const reserved = new Set(usedPorts);
            for (let offset = 0; offset <= 200; offset += 1) {
              const candidate = preferredPort + offset;
              if (candidate <= 65_535 && !reserved.has(candidate)) return candidate;
            }
            throw activationError(
              "NO_AVAILABLE_PROTOCOL_PORT",
              `从 ${preferredPort} 开始未找到可用的 ${policy.network.toUpperCase()} 端口`,
              409
            );
          })()
        : await this.portManager.findAvailable({
            preferredPort,
            listen,
            network: policy.network,
            usedPorts
          });
    const tls = { ...current.tls, mode: "none" };
    if (policy.tls === "reality") {
      const keypair = await this.installer.generateRealityKeypair();
      Object.assign(tls, {
        mode: "reality",
        serverName: "www.microsoft.com",
        handshakeServer: "www.microsoft.com",
        handshakePort: 443,
        privateKey: keypair.privateKey,
        publicKey: keypair.publicKey,
        shortId: this.randomBytes(8).toString("hex")
      });
    } else if (policy.tls === "acme") {
      const email = String(this.certificateEmail() || "").trim();
      if (!isDomain(host.address)) {
        throw activationError(
          "NODE_DOMAIN_REQUIRED",
          `${catalog.name} 自动证书需要先为该节点设置已解析的独立域名`
        );
      }
      if (!email) {
        throw activationError(
          "ACME_EMAIL_REQUIRED",
          `${catalog.name} 自动证书需要先在系统访问设置中填写证书通知邮箱`
        );
      }
      if (host.kind === "local" && this.certificateProvider) {
        const certificate = await this.certificateProvider(host.address);
        if (certificate) {
          Object.assign(tls, {
            mode: "certificate",
            serverName: certificate.serverName || host.address,
            certificatePath: certificate.certificatePath,
            keyPath: certificate.keyPath
          });
          return {
            candidate: {
              ...current,
              enabled: true,
              listen,
              port,
              tls
            },
            certificate
          };
        }
      }
      Object.assign(tls, {
        mode: "acme",
        serverName: host.address,
        acmeEmail: email
      });
    }
    return {
      candidate: {
        ...current,
        enabled: true,
        listen,
        port,
        tls
      },
      certificate: null
    };
  }

  async enable({ hostId, type, adminId = null }) {
    const key = `${hostId}:${type}`;
    if (this.activating.has(key)) {
      throw activationError("PROTOCOL_ACTIVATION_IN_PROGRESS", "该协议正在配置中", 409);
    }
    this.activating.add(key);
    let original;
    const firewalls = [];
    let certificate = null;
    let published = false;
    try {
      const host = this.store.getHost(hostId);
      if (!host) throw activationError("HOST_NOT_FOUND", "主机不存在", 404);
      const policy = protocolActivationPolicy(type);
      if (policy.group === "advanced") {
        throw activationError(
          "PROTOCOL_ADVANCED_ONLY",
          "该协议涉及系统网络或协议编排，只能在高级配置中手动启用"
        );
      }
      const { catalog, availability, installation } = await this.assertAvailable(host, type);
      if (policy.tls === "reality" && !availability.realityAvailable) {
        throw activationError(
          "REALITY_UNAVAILABLE",
          "当前 sing-box 构建缺少 Reality 所需的 with_utls"
        );
      }
      const profiles = this.store.listHostProtocolConfigs(hostId);
      original = structuredClone(profiles.find((profile) => profile.type === type));
      this.record(hostId, type, "configuring", { progress: 10 });
      const prepared = await this.prepare(host, type, policy, catalog, profiles);
      const candidate = prepared.candidate;
      certificate = prepared.certificate;
      if (candidate.tls.mode === "acme" && !installation.tags?.includes("with_acme")) {
        throw activationError(
          "ACME_UNAVAILABLE",
          "当前 sing-box 构建缺少自动证书所需的 with_acme"
        );
      }
      const saved = this.store.updateHostProtocolConfig(hostId, type, candidate);
      const challengePorts = saved.tls.mode === "acme"
        ? [
            { port: 80, network: "tcp", purpose: "acme-http-01" },
            { port: 443, network: "tcp", purpose: "acme-tls-alpn-01" }
          ]
        : [];
      this.record(hostId, type, "pending-publish", { progress: 35, port: saved.port });

      if (host.kind === "remote") {
        const deployment = await this.runtimeManager.publish(adminId, {
          activation: {
            hostId,
            type,
            network: policy.network,
            exposure: policy.exposure,
            address: host.address,
            port: saved.port,
            listen: saved.listen,
            challengePorts,
            previousProfile: original
          }
        });
        this.record(hostId, type, "deploying", {
          progress: 60,
          port: saved.port,
          deploymentId: deployment.id
        });
        return {
          profile: saved,
          deployment,
          activation: {
            state: "deploying",
            asynchronous: true,
            port: saved.port,
            network: policy.network
          }
        };
      }

      if (policy.exposure === "public") {
        for (const rule of [
          { port: saved.port, network: policy.network },
          ...challengePorts
        ]) {
          firewalls.push(await this.firewallManager.open(rule));
        }
      }
      this.record(hostId, type, "deploying", { progress: 60, port: saved.port });
      const deployment = await this.runtimeManager.publish(adminId, {
        reason: "one-click-protocol-activation"
      });
      published = true;
      if (this.runtimeMode !== "dry-run") {
        await this.portManager.waitForListening({
          listen: saved.listen,
          port: saved.port,
          network: policy.network
        });
      }
      this.record(hostId, type, "port-listening", { progress: 85, port: saved.port });
      let publicCheck = { reachable: null, reason: "仅本机协议不执行公网探测" };
      if (policy.exposure === "public" && this.runtimeMode !== "dry-run") {
        publicCheck = policy.network === "udp" && this.protocolProbe
          ? await this.protocolProbe({
              type,
              address: host.address,
              port: saved.port,
              network: policy.network
            })
          : await this.publicProbe.verify({
              address: host.address,
              port: saved.port,
              network: policy.network
            });
      } else if (policy.exposure === "public") {
        publicCheck = { reachable: true, simulated: true };
      }
      const state = publicCheck.reachable === true ? "public-ready" : "port-listening";
      const activation = this.record(hostId, type, state, {
        progress: 100,
        port: saved.port,
        network: policy.network,
        firewallManaged: firewalls.some((item) => item.managed === true),
        publicCheck
      });
      return { profile: saved, deployment, activation };
    } catch (error) {
      const rollbackFailures = [];
      if (original) {
        try {
          this.store.updateHostProtocolConfig(hostId, type, original);
          if (published) {
            await this.runtimeManager.publish(adminId, {
              reason: "one-click-protocol-rollback"
            });
          }
        } catch (rollbackError) {
          rollbackFailures.push(`配置：${rollbackError.message}`);
        }
      }
      for (const firewall of firewalls.reverse()) {
        try {
          await firewall.rollback();
        } catch (rollbackError) {
          rollbackFailures.push(`防火墙：${rollbackError.message}`);
        }
      }
      if (certificate?.rollback) {
        try {
          await certificate.rollback();
        } catch (rollbackError) {
          rollbackFailures.push(`证书：${rollbackError.message}`);
        }
      }
      if (rollbackFailures.length) error.rollbackError = rollbackFailures.join("；");
      if (original) {
        this.record(hostId, type, "failed", {
          progress: 100,
          error: error.message,
          rolledBack: !error.rollbackError,
          ...(error.rollbackError ? { rollbackError: error.rollbackError } : {})
        });
      }
      throw error;
    } finally {
      this.activating.delete(key);
    }
  }
}
