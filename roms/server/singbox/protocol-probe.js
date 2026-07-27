const supportedTypes = new Set(["hysteria", "tuic", "hysteria2"]);

export const DEFAULT_PROTOCOL_PROBE_URL = "https://www.gstatic.com/generate_204";

export function buildUdpProtocolProbeConfig({
  type,
  address,
  port,
  serverConfig
}) {
  if (!supportedTypes.has(type)) {
    throw new Error(`协议 ${type} 不支持专用外部探针`);
  }
  const inbound = serverConfig.inbounds?.find((entry) => (
    entry.type === type && Number(entry.listen_port) === Number(port)
  ));
  if (!inbound) throw new Error(`找不到 ${type} 的已发布入站配置`);
  const user = inbound.users?.find((entry) => entry.name === "raylink-probe@internal")
    || inbound.users?.[0];
  if (!user) throw new Error(`${type} 外部探针需要至少一个有效用户`);
  const serverName = inbound.tls?.server_name;
  if (!serverName) throw new Error(`${type} 外部探针缺少 TLS 服务器名称`);

  const common = {
    type,
    tag: "raylink-probe",
    server: address,
    server_port: port
  };
  let outbound;
  if (type === "hysteria") {
    outbound = {
      ...common,
      auth_str: user.auth_str,
      up_mbps: inbound.up_mbps,
      down_mbps: inbound.down_mbps
    };
  } else if (type === "tuic") {
    outbound = {
      ...common,
      uuid: user.uuid,
      password: user.password,
      congestion_control: "bbr"
    };
  } else {
    outbound = { ...common, password: user.password };
  }
  outbound.tls = {
    enabled: true,
    server_name: serverName
  };

  return {
    log: { disabled: true },
    dns: {
      servers: [{ type: "local", tag: "raylink-probe-dns" }],
      final: "raylink-probe-dns",
      strategy: "prefer_ipv4"
    },
    outbounds: [outbound],
    route: {
      final: "raylink-probe",
      default_domain_resolver: "raylink-probe-dns"
    }
  };
}
