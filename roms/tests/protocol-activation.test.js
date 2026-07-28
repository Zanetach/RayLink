import assert from "node:assert/strict";
import test from "node:test";

import {
  ProtocolActivationManager,
  protocolActivationPolicy,
  UfwFirewallManager
} from "../server/protocol-activation.js";

function profile(type, overrides = {}) {
  return {
    type,
    enabled: false,
    listen: "::",
    port: {
      shadowsocks: 8388,
      vless: 8444,
      hysteria2: 8448,
      direct: 9090
    }[type],
    tls: {
      mode: "none",
      serverName: "",
      certificatePath: "",
      keyPath: "",
      handshakeServer: "",
      handshakePort: 443,
      privateKey: "",
      publicKey: "",
      shortId: "",
      acmeEmail: ""
    },
    transport: { type: "none", path: "", serviceName: "" },
    options: {},
    ...overrides
  };
}

function fixture(type, overrides = {}) {
  const profiles = [profile("shadowsocks"), profile("vless"), profile("hysteria2"), profile("direct")];
  const original = structuredClone(profiles.find((item) => item.type === type));
  const events = [];
  const store = {
    getHost: () => ({
      id: "local",
      kind: overrides.kind || "local",
      address: overrides.address || "node.example.com",
      runtimeVersion: "1.13.14",
      platform: "linux",
      buildTags: ["with_utls", "with_acme", "with_quic"],
      protocolActivations: overrides.protocolActivations || []
    }),
    listHostProtocolConfigs: () => structuredClone(profiles),
    updateHostProtocolConfig: (_hostId, protocolType, input) => {
      const index = profiles.findIndex((item) => item.type === protocolType);
      profiles[index] = {
        ...profiles[index],
        ...structuredClone(input),
        tls: { ...profiles[index].tls, ...(input.tls || {}) },
        transport: { ...profiles[index].transport, ...(input.transport || {}) }
      };
      events.push(["store", structuredClone(profiles[index])]);
      return structuredClone(profiles[index]);
    },
    setProtocolActivation: (_hostId, protocolType, activation) => {
      events.push(["state", protocolType, activation.state]);
      return activation;
    }
  };
  const portManager = {
    findAvailable: async ({ preferredPort, network, listen }) => {
      events.push(["port", preferredPort, network, listen]);
      return overrides.port || preferredPort;
    },
    waitForListening: async (input) => {
      events.push(["listening", input.network, input.port]);
      if (overrides.listenerError) throw new Error("端口未监听");
      return true;
    }
  };
  const firewallManager = {
    open: async (input) => {
      events.push(["firewall-open", input.network, input.port]);
      return {
        managed: true,
        rollback: async () => events.push(["firewall-rollback", input.network, input.port])
      };
    }
  };
  const publicProbe = {
    verify: async (input) => {
      events.push(["public-probe", input.network, input.port]);
      if (overrides.publicError) throw new Error("公网不可达");
      return { reachable: true };
    }
  };
  const protocolProbe = async (input) => {
    events.push(["protocol-probe", input.type, input.port]);
    if (overrides.protocolProbeError) throw new Error("协议握手失败");
    return {
      reachable: true,
      probe: "sing-box-tools-fetch",
      protocol: input.type
    };
  };
  const runtimeManager = {
    publish: async (_adminId, options) => {
      events.push(["publish", options]);
      return { id: "deployment-1", status: "active", remoteQueued: 0 };
    }
  };
  const installer = {
    status: async () => ({
      installed: true,
      version: "1.13.14",
      platform: "linux",
      tags: ["with_utls", "with_acme", "with_quic"]
    }),
    generateRealityKeypair: async () => ({
      privateKey: "private-key",
      publicKey: "public-key"
    })
  };
  const manager = new ProtocolActivationManager({
    store,
    runtimeManager,
    installer,
    portManager,
    firewallManager,
    publicProbe,
    protocolProbe,
    certificateEmail: () => "ops@example.com",
    certificateProvider: overrides.certificateProvider,
    certificateStager: overrides.certificateStager,
    randomBytes: () => Buffer.from("0011223344556677", "hex")
  });
  return { manager, events, profiles, original };
}

test("protocol policies separate public, TLS, private and advanced behavior", () => {
  assert.equal(protocolActivationPolicy("shadowsocks").group, "one-click");
  assert.equal(protocolActivationPolicy("trojan").group, "tls");
  assert.equal(protocolActivationPolicy("hysteria2").network, "udp");
  assert.equal(protocolActivationPolicy("socks").exposure, "private");
  assert.equal(protocolActivationPolicy("direct").group, "advanced");
});

test("one-click Shadowsocks activation reserves a port, opens TCP, publishes and probes", async () => {
  const { manager, events, profiles } = fixture("shadowsocks", { port: 18388 });

  const result = await manager.enable({
    hostId: "local",
    type: "shadowsocks",
    adminId: "admin-1"
  });

  const enabled = profiles.find((item) => item.type === "shadowsocks");
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.port, 18388);
  assert.equal(enabled.listen, "::");
  assert.equal(result.activation.state, "public-ready");
  assert.deepEqual(events.filter(([name]) => name === "firewall-open")[0], [
    "firewall-open",
    "tcp",
    18388
  ]);
  assert.equal(events.some(([name]) => name === "publish"), true);
  assert.equal(events.some(([name]) => name === "listening"), true);
  assert.equal(events.some(([name]) => name === "public-probe"), true);
});

test("one-click VLESS uses generated Reality material", async () => {
  const { manager, profiles } = fixture("vless");

  await manager.enable({ hostId: "local", type: "vless", adminId: "admin-1" });

  const enabled = profiles.find((item) => item.type === "vless");
  assert.equal(enabled.tls.mode, "reality");
  assert.equal(enabled.tls.privateKey, "private-key");
  assert.equal(enabled.tls.publicKey, "public-key");
  assert.equal(enabled.tls.shortId, "0011223344556677");
  assert.equal(enabled.tls.serverName, "www.microsoft.com");
});

test("one-click Hysteria 2 binds node domain to ACME and opens UDP", async () => {
  const { manager, events, profiles } = fixture("hysteria2");

  await manager.enable({ hostId: "local", type: "hysteria2", adminId: "admin-1" });

  const enabled = profiles.find((item) => item.type === "hysteria2");
  assert.equal(enabled.tls.mode, "acme");
  assert.equal(enabled.tls.serverName, "node.example.com");
  assert.equal(enabled.tls.acmeEmail, "ops@example.com");
  assert.deepEqual(events.filter(([name]) => name === "firewall-open"), [
    ["firewall-open", "udp", 8448],
    ["firewall-open", "tcp", 80],
    ["firewall-open", "tcp", 443]
  ]);
  assert.deepEqual(
    events.filter(([name]) => name === "protocol-probe"),
    [["protocol-probe", "hysteria2", 8448]]
  );
  assert.equal(events.some(([name]) => name === "public-probe"), false);
});

test("local Hysteria 2 stages a Caddy certificate before publishing", async () => {
  const { manager, profiles } = fixture("hysteria2", {
    certificateProvider: async () => ({
      serverName: "node.example.com",
      certificatePath: "/var/lib/caddy/private/node.crt",
      keyPath: "/var/lib/caddy/private/node.key",
      rollback: async () => {}
    }),
    certificateStager: async ({ domain, certificatePath, keyPath }) => {
      assert.equal(domain, "node.example.com");
      assert.equal(certificatePath, "/var/lib/caddy/private/node.crt");
      assert.equal(keyPath, "/var/lib/caddy/private/node.key");
      return {
        certificatePath: "/var/lib/raylink/sing-box/tls/node.crt",
        keyPath: "/var/lib/raylink/sing-box/tls/node.key",
        rollback: async () => {}
      };
    }
  });

  await manager.enable({ hostId: "local", type: "hysteria2", adminId: "admin-1" });

  const enabled = profiles.find((item) => item.type === "hysteria2");
  assert.equal(
    enabled.tls.certificatePath,
    "/var/lib/raylink/sing-box/tls/node.crt"
  );
  assert.equal(
    enabled.tls.keyPath,
    "/var/lib/raylink/sing-box/tls/node.key"
  );
});

test("failed local TLS activation rolls back both staged assets and Caddy", async () => {
  const rollbacks = [];
  const { manager, profiles, original } = fixture("hysteria2", {
    protocolProbeError: true,
    certificateProvider: async () => ({
      serverName: "node.example.com",
      certificatePath: "/var/lib/caddy/private/node.crt",
      keyPath: "/var/lib/caddy/private/node.key",
      rollback: async () => rollbacks.push("caddy")
    }),
    certificateStager: async () => ({
      certificatePath: "/var/lib/raylink/sing-box/tls/node.crt",
      keyPath: "/var/lib/raylink/sing-box/tls/node.key",
      rollback: async () => rollbacks.push("staged-assets")
    })
  });

  await assert.rejects(
    manager.enable({ hostId: "local", type: "hysteria2", adminId: "admin-1" }),
    /协议握手失败/
  );

  assert.deepEqual(
    profiles.find((item) => item.type === "hysteria2"),
    original
  );
  assert.deepEqual(rollbacks, ["staged-assets", "caddy"]);
});

test("advanced protocols cannot be one-click exposed", async () => {
  const { manager } = fixture("direct");

  await assert.rejects(
    manager.enable({ hostId: "local", type: "direct", adminId: "admin-1" }),
    (error) => error.code === "PROTOCOL_ADVANCED_ONLY"
  );
});

test("a remote port collision advances to the next candidate without reusing the failed port", async () => {
  const { manager, profiles } = fixture("vless", {
    kind: "remote",
    protocolActivations: [{
      type: "vless",
      state: "failed",
      errorCode: "PROTOCOL_PORT_OCCUPIED",
      port: 8444,
      suggestedPort: 8450
    }]
  });

  const result = await manager.enable({
    hostId: "local",
    type: "vless",
    adminId: "admin-1"
  });

  assert.equal(profiles.find((item) => item.type === "vless").port, 8450);
  assert.equal(result.activation.state, "deploying");
  assert.equal(result.activation.asynchronous, true);
});

test("failed public verification restores protocol config and firewall", async () => {
  const { manager, events, profiles, original } = fixture("shadowsocks", {
    publicError: true
  });

  await assert.rejects(
    manager.enable({ hostId: "local", type: "shadowsocks", adminId: "admin-1" }),
    /公网不可达/
  );

  assert.deepEqual(profiles.find((item) => item.type === "shadowsocks"), original);
  assert.equal(events.some(([name]) => name === "firewall-rollback"), true);
  assert.equal(
    events.some(([name, , state]) => name === "state" && state === "failed"),
    true
  );
  assert.equal(events.filter(([name]) => name === "publish").length, 2);
});

test("UFW activation preserves an equivalent rule that existed before RayLink", async () => {
  const commands = [];
  const firewall = new UfwFirewallManager({
    commandRunner: async (command, args) => {
      commands.push([command, ...args]);
      return {
        stdout: "Status: active\n\n8444/tcp ALLOW Anywhere\n",
        stderr: ""
      };
    }
  });

  const opened = await firewall.open({ port: 8444, network: "tcp" });
  await opened.rollback();

  assert.equal(opened.managed, false);
  assert.equal(opened.preexisting, true);
  assert.deepEqual(commands, [["ufw", "status"]]);
});
