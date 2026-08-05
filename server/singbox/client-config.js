import {
  buildMultiHostProtocolClientConfig
} from "./protocol-catalog.js";

export function buildUserClientConfig({
  credential,
  hosts,
  ruleSetBaseUrl = null,
  probeUrl,
  routePolicy
}) {
  return buildMultiHostProtocolClientConfig({
    credential,
    hosts: hosts || [],
    ruleSetBaseUrl,
    probeUrl,
    routePolicy
  });
}
