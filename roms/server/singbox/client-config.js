import {
  buildMultiHostProtocolClientConfig
} from "./protocol-catalog.js";

export function buildUserClientConfig({
  credential,
  hosts,
  ruleSetBaseUrl = null
}) {
  return buildMultiHostProtocolClientConfig({
    credential,
    hosts: hosts || [],
    ruleSetBaseUrl
  });
}
