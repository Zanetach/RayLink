export function buildUserClientConfig({ credential, server, port }) {
  return {
    log: {
      level: "warn",
      timestamp: true
    },
    inbounds: [{
      type: "mixed",
      tag: "mixed-in",
      listen: "127.0.0.1",
      listen_port: 2080
    }],
    outbounds: [
      {
        type: "shadowsocks",
        tag: "raylink",
        server,
        server_port: port,
        method: "2022-blake3-aes-128-gcm",
        password: `${credential.serverPassword}:${credential.runtimePassword}`
      },
      {
        type: "direct",
        tag: "direct"
      }
    ],
    route: {
      final: "raylink"
    }
  };
}
