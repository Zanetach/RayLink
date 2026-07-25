import {
  buildProtocolClientConfig,
  defaultProtocolConfigs
} from "./protocol-catalog.js";

export function buildUserClientConfig({ credential, server, port, protocols }) {
  return buildProtocolClientConfig({
    profiles: protocols || defaultProtocolConfigs(port),
    credential,
    server
  });
}
