import {
  buildMultiHostProtocolClientConfig,
  buildProtocolClientConfig,
  defaultProtocolConfigs
} from "./protocol-catalog.js";

export function buildUserClientConfig({
  credential,
  server,
  hosts,
  port,
  protocols,
  ruleSetBaseUrl = null
}) {
  if (hosts?.length) {
    return buildMultiHostProtocolClientConfig({
      profiles: protocols || defaultProtocolConfigs(port),
      credential,
      hosts,
      ruleSetBaseUrl
    });
  }
  return buildProtocolClientConfig({
    profiles: protocols || defaultProtocolConfigs(port),
    credential,
    server,
    ruleSetBaseUrl
  });
}
