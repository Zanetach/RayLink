const generatedNodeTypes = new Set([
  "shadowsocks",
  "vmess",
  "vless",
  "trojan",
  "anytls",
  "hysteria",
  "hysteria2",
  "tuic"
]);

const mihomoCompatibleTypes = new Set(generatedNodeTypes);
const egernCompatibleTypes = new Set([
  "shadowsocks",
  "vmess",
  "vless",
  "trojan",
  "anytls",
  "hysteria2",
  "tuic"
]);

function scalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

function yamlLines(value, indent = 0) {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [`${prefix}[]`];
    return value.flatMap((item) => {
      if (item !== null && typeof item === "object") {
        const lines = yamlLines(item, indent + 2);
        return [`${prefix}- ${lines[0].trimStart()}`, ...lines.slice(1)];
      }
      return [`${prefix}- ${scalar(item)}`];
    });
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (!entries.length) return [`${prefix}{}`];
    return entries.flatMap(([key, item]) => {
      const safeKey = /^[A-Za-z0-9_-]+$/.test(key) ? key : scalar(key);
      if (item !== null && typeof item === "object") {
        const lines = yamlLines(item, indent + 2);
        return [`${prefix}${safeKey}:`, ...lines];
      }
      return [`${prefix}${safeKey}: ${scalar(item)}`];
    });
  }
  return [`${prefix}${scalar(value)}`];
}

export function stringifyYaml(value) {
  return `${yamlLines(value).join("\n")}\n`;
}

function nodeOutbounds(config) {
  return (config?.outbounds || []).filter((outbound) => generatedNodeTypes.has(outbound.type));
}

function groupMembers(config, tag, fallback = []) {
  const group = (config?.outbounds || []).find((outbound) => outbound.tag === tag);
  return Array.isArray(group?.outbounds) && group.outbounds.length
    ? group.outbounds
    : fallback;
}

function applyMihomoTls(proxy, outbound) {
  if (!outbound.tls?.enabled) return proxy;
  proxy.tls = true;
  if (outbound.tls.server_name) proxy.servername = outbound.tls.server_name;
  proxy["skip-cert-verify"] = false;
  if (outbound.tls.reality?.enabled) {
    proxy["reality-opts"] = {
      "public-key": outbound.tls.reality.public_key,
      "short-id": outbound.tls.reality.short_id || ""
    };
    proxy["client-fingerprint"] = outbound.tls.utls?.fingerprint || "chrome";
  }
  return proxy;
}

function applyMihomoTransport(proxy, outbound) {
  const transport = outbound.transport;
  if (!transport) return proxy;
  const type = transport.type === "httpupgrade" ? "httpupgrade" : transport.type;
  proxy.network = type;
  if (type === "ws") {
    proxy["ws-opts"] = {
      path: transport.path || "/"
    };
  } else if (type === "grpc") {
    proxy["grpc-opts"] = {
      "grpc-service-name": transport.service_name || ""
    };
  } else if (type === "http") {
    proxy["http-opts"] = {
      path: [transport.path || "/"]
    };
  } else if (type === "httpupgrade") {
    proxy["http-upgrade-opts"] = {
      path: transport.path || "/"
    };
  }
  return proxy;
}

function mihomoProxy(outbound) {
  const common = {
    name: outbound.tag,
    type: outbound.type === "shadowsocks" ? "ss" : outbound.type,
    server: outbound.server,
    port: outbound.server_port
  };
  if (outbound.type === "shadowsocks") {
    return {
      ...common,
      cipher: outbound.method,
      password: outbound.password,
      udp: true
    };
  }
  if (outbound.type === "vmess") {
    return applyMihomoTransport(applyMihomoTls({
      ...common,
      uuid: outbound.uuid,
      alterId: 0,
      cipher: outbound.security || "auto",
      udp: true
    }, outbound), outbound);
  }
  if (outbound.type === "vless") {
    return applyMihomoTransport(applyMihomoTls({
      ...common,
      uuid: outbound.uuid,
      ...(outbound.flow ? { flow: outbound.flow } : {}),
      udp: true
    }, outbound), outbound);
  }
  if (outbound.type === "tuic") {
    return applyMihomoTls({
      ...common,
      uuid: outbound.uuid,
      password: outbound.password,
      "congestion-controller": outbound.congestion_control || "bbr",
      "udp-relay-mode": "native",
      alpn: ["h3"],
      udp: true
    }, outbound);
  }
  if (outbound.type === "hysteria") {
    return applyMihomoTls({
      ...common,
      "auth-str": outbound.auth_str,
      up: `${outbound.up_mbps || 100} Mbps`,
      down: `${outbound.down_mbps || 100} Mbps`,
      udp: true
    }, outbound);
  }
  if (outbound.type === "hysteria2") {
    return applyMihomoTls({
      ...common,
      password: outbound.password,
      udp: true
    }, outbound);
  }
  return applyMihomoTransport(applyMihomoTls({
    ...common,
    password: outbound.password,
    udp: true
  }, outbound), outbound);
}

function uniqueExisting(members, names) {
  const available = new Set(names);
  return [...new Set(members)].filter((name) => available.has(name));
}

function buildMihomoConfig(singBoxConfig) {
  const proxies = nodeOutbounds(singBoxConfig)
    .filter((outbound) => mihomoCompatibleTypes.has(outbound.type))
    .map(mihomoProxy);
  if (!proxies.length) throw subscriptionError("NO_COMPATIBLE_NODES", "当前没有 Mihomo 可用节点");
  const names = proxies.map((proxy) => proxy.name);
  const smart = uniqueExisting(groupMembers(singBoxConfig, "raylink-smart", names), names);
  const tcp = uniqueExisting(groupMembers(singBoxConfig, "raylink-tcp"), names);
  const udp = uniqueExisting(groupMembers(singBoxConfig, "raylink-udp"), names);
  const automatic = smart.length ? smart : names;
  const proxyGroups = [
    {
      name: "RayLink 代理",
      type: "select",
      proxies: ["RayLink 智能", "TCP 稳定", ...(udp.length ? ["UDP 高速"] : []), "故障回退", "手动选择"]
    },
    {
      name: "RayLink 智能",
      type: "url-test",
      proxies: automatic,
      url: "https://www.gstatic.com/generate_204",
      interval: 180,
      tolerance: 80,
      lazy: true
    },
    {
      name: "TCP 稳定",
      type: "url-test",
      proxies: tcp.length ? tcp : automatic,
      url: "https://www.gstatic.com/generate_204",
      interval: 180,
      tolerance: 50,
      lazy: true
    },
    ...(udp.length ? [{
      name: "UDP 高速",
      type: "url-test",
      proxies: udp,
      url: "https://www.gstatic.com/generate_204",
      interval: 180,
      tolerance: 80,
      lazy: true
    }] : []),
    {
      name: "故障回退",
      type: "fallback",
      proxies: [...new Set([...(tcp.length ? tcp : automatic), ...udp])],
      url: "https://www.gstatic.com/generate_204",
      interval: 180,
      lazy: true
    },
    {
      name: "手动选择",
      type: "select",
      proxies: names
    }
  ];
  return {
    "mixed-port": 7890,
    "allow-lan": false,
    mode: "rule",
    "log-level": "info",
    ipv6: false,
    "unified-delay": true,
    "tcp-concurrent": true,
    profile: {
      "store-selected": true,
      "store-fake-ip": true
    },
    dns: {
      enable: true,
      ipv6: false,
      "enhanced-mode": "fake-ip",
      "fake-ip-range": "198.18.0.1/16",
      nameserver: [
        "https://223.5.5.5/dns-query",
        "https://1.1.1.1/dns-query"
      ],
      "proxy-server-nameserver": [
        "https://223.5.5.5/dns-query"
      ]
    },
    proxies,
    "proxy-groups": proxyGroups,
    rules: [
      "DOMAIN-SUFFIX,openai.com,RayLink 智能",
      "DOMAIN-SUFFIX,anthropic.com,RayLink 智能",
      "DOMAIN-SUFFIX,claude.ai,RayLink 智能",
      "DOMAIN-SUFFIX,google.com,RayLink 智能",
      "DOMAIN-SUFFIX,youtube.com,RayLink 智能",
      "GEOSITE,CN,DIRECT",
      "GEOIP,CN,DIRECT,no-resolve",
      "MATCH,RayLink 代理"
    ]
  };
}

function egernReality(tls) {
  if (!tls?.reality?.enabled) return undefined;
  return {
    public_key: tls.reality.public_key,
    short_id: tls.reality.short_id || ""
  };
}

function egernTransport(outbound) {
  const tls = outbound.tls?.enabled ? outbound.tls : null;
  const reality = egernReality(tls);
  const transport = outbound.transport;
  if (!transport) {
    if (!tls) return undefined;
    return {
      tls: {
        sni: tls.server_name || outbound.server,
        skip_tls_verify: false,
        ...(reality ? { reality } : {})
      }
    };
  }
  if (transport.type === "grpc") {
    return {
      grpc: {
        service_name: transport.service_name || "",
        sni: tls?.server_name || outbound.server,
        skip_tls_verify: false,
        ...(reality ? { reality } : {})
      }
    };
  }
  const type = transport.type === "ws" && tls ? "wss" : transport.type;
  return {
    [type]: {
      ...(transport.path ? { path: transport.path } : {}),
      ...(tls ? {
        sni: tls.server_name || outbound.server,
        skip_tls_verify: false
      } : {}),
      ...(reality ? { reality } : {})
    }
  };
}

function egernProxy(outbound) {
  const common = {
    name: outbound.tag,
    server: outbound.server,
    port: outbound.server_port
  };
  if (outbound.type === "shadowsocks") {
    return {
      shadowsocks: {
        ...common,
        method: outbound.method,
        password: outbound.password,
        udp_relay: true
      }
    };
  }
  if (outbound.type === "vmess") {
    return {
      vmess: {
        ...common,
        user_id: outbound.uuid,
        security: outbound.security || "auto",
        legacy: false,
        udp_relay: true,
        ...(egernTransport(outbound) ? { transport: egernTransport(outbound) } : {})
      }
    };
  }
  if (outbound.type === "vless") {
    return {
      vless: {
        ...common,
        user_id: outbound.uuid,
        ...(outbound.flow ? { flow: outbound.flow } : {}),
        udp_relay: true,
        ...(egernTransport(outbound) ? { transport: egernTransport(outbound) } : {})
      }
    };
  }
  if (outbound.type === "hysteria2") {
    return {
      hysteria2: {
        ...common,
        auth: outbound.password,
        sni: outbound.tls?.server_name || outbound.server,
        skip_tls_verify: false
      }
    };
  }
  if (outbound.type === "tuic") {
    return {
      tuic: {
        ...common,
        uuid: outbound.uuid,
        password: outbound.password,
        udp_relay_mode: "native",
        alpn: ["h3"],
        sni: outbound.tls?.server_name || outbound.server,
        skip_tls_verify: false
      }
    };
  }
  const reality = egernReality(outbound.tls);
  return {
    [outbound.type]: {
      ...common,
      password: outbound.password,
      sni: outbound.tls?.server_name || outbound.server,
      udp_relay: true,
      skip_tls_verify: false,
      ...(reality ? { reality } : {}),
      ...(outbound.transport ? { transport: egernTransport(outbound) } : {})
    }
  };
}

function egernProxies(singBoxConfig) {
  return nodeOutbounds(singBoxConfig)
    .filter((outbound) => egernCompatibleTypes.has(outbound.type))
    .map(egernProxy);
}

function egernProxyNames(proxies) {
  return proxies.map((entry) => Object.values(entry)[0].name);
}

function buildEgernProfile(singBoxConfig) {
  const proxies = egernProxies(singBoxConfig);
  if (!proxies.length) throw subscriptionError("NO_COMPATIBLE_NODES", "当前没有 Egern 可用节点");
  const names = egernProxyNames(proxies);
  const smart = uniqueExisting(groupMembers(singBoxConfig, "raylink-smart", names), names);
  const tcp = uniqueExisting(groupMembers(singBoxConfig, "raylink-tcp"), names);
  const udp = uniqueExisting(groupMembers(singBoxConfig, "raylink-udp"), names);
  const smartNames = smart.length ? smart : names;
  return {
    ipv6: false,
    close_connections_on_policy_change: true,
    hijack_dns: ["*"],
    dns: {
      bootstrap: ["system", "223.5.5.5"],
      upstreams: {
        domestic: ["https://223.5.5.5/dns-query"],
        overseas: [
          "https://1.1.1.1/dns-query",
          "https://8.8.8.8/dns-query"
        ]
      },
      forward: [
        { domain_suffix: { match: "cn", value: "domestic" } },
        { domain_wildcard: { match: "*", value: "overseas" } }
      ],
      proxy_nameservers: ["https://223.5.5.5/dns-query"],
      skip_tls_verify: false
    },
    proxies,
    policy_groups: [
      {
        smart: {
          name: "RayLink 智能",
          policies: smartNames,
          priorities: {
            "(?i)VLESS|TROJAN|ANYTLS|VMESS": 0.85,
            "(?i)HYSTERIA2|TUIC": 1
          },
          latency_test_url: "https://www.gstatic.com/generate_204"
        }
      },
      {
        auto_test: {
          name: "TCP 稳定",
          policies: tcp.length ? tcp : smartNames,
          interval: 300,
          tolerance: 100,
          timeout: 5
        }
      },
      ...(udp.length ? [{
        auto_test: {
          name: "UDP 高速",
          policies: udp,
          interval: 300,
          tolerance: 120,
          timeout: 5
        }
      }] : []),
      {
        fallback: {
          name: "故障回退",
          policies: [...new Set([...(tcp.length ? tcp : smartNames), ...udp])],
          interval: 300,
          timeout: 5
        }
      },
      {
        select: {
          name: "手动选择",
          policies: ["RayLink 智能", "TCP 稳定", ...(udp.length ? ["UDP 高速"] : []), ...names]
        }
      }
    ],
    rules: [
      { domain_suffix: { match: "openai.com", policy: "RayLink 智能" } },
      { domain_suffix: { match: "anthropic.com", policy: "RayLink 智能" } },
      { domain_suffix: { match: "claude.ai", policy: "RayLink 智能" } },
      { domain_suffix: { match: "google.com", policy: "RayLink 智能" } },
      { domain_suffix: { match: "youtube.com", policy: "RayLink 智能" } },
      { domain_suffix: { match: "cn", policy: "DIRECT" } },
      { geoip: { match: "CN", policy: "DIRECT", no_resolve: true } },
      { default: { policy: "RayLink 智能" } }
    ]
  };
}

export function buildSubscriptionArtifact({ format, singBoxConfig }) {
  if (format === "singbox") {
    return {
      contentType: "application/json; charset=utf-8",
      filename: "raylink-sing-box.json",
      body: JSON.stringify(singBoxConfig)
    };
  }
  if (format === "mihomo") {
    return {
      contentType: "application/yaml; charset=utf-8",
      filename: "raylink-mihomo.yaml",
      body: stringifyYaml(buildMihomoConfig(singBoxConfig))
    };
  }
  if (format === "egern") {
    const proxies = egernProxies(singBoxConfig);
    if (!proxies.length) throw subscriptionError("NO_COMPATIBLE_NODES", "当前没有 Egern 可用节点");
    return {
      contentType: "application/yaml; charset=utf-8",
      filename: "raylink-egern.yaml",
      body: stringifyYaml({ proxies })
    };
  }
  if (format === "egern-profile") {
    return {
      contentType: "application/yaml; charset=utf-8",
      filename: "raylink-egern-profile.yaml",
      body: stringifyYaml(buildEgernProfile(singBoxConfig))
    };
  }
  throw subscriptionError("SUBSCRIPTION_FORMAT_UNSUPPORTED", "订阅格式不受支持", 400);
}

function subscriptionError(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export const subscriptionCompatibility = Object.freeze({
  mihomo: [...mihomoCompatibleTypes],
  egern: [...egernCompatibleTypes],
  singbox: [...generatedNodeTypes, "naive"]
});
