import { lookup as nodeLookup } from "node:dns/promises";

import {
  normalizeRoutingPolicy,
  routingDecisionForDomain,
  ROUTE_POLICY_GROUPS
} from "./policy.js";

function outboundForAction(action) {
  if (action === "direct") return ROUTE_POLICY_GROUPS.direct.tag;
  if (action === "ai") return ROUTE_POLICY_GROUPS.ai.tag;
  if (action === "block") return "reject";
  return ROUTE_POLICY_GROUPS.proxy.tag;
}

function explained(result, domain, addresses = []) {
  const explanations = {
    custom: "命中管理员自定义规则",
    mode: "由当前全局路由模式决定",
    ai: "命中 RayLink 内置 AI 服务规则",
    geosite: "命中国内域名规则",
    "geosite-cn": "命中完整国内域名规则集",
    "geoip-cn": "解析得到的全部 IP 均命中国内 IP 规则集",
    "geoip-mixed": "解析结果包含境外或无法确认的 IP，保守使用代理",
    fallback: "规则集暂不可用于诊断，按未知域名回退到代理"
  };
  return {
    domain,
    addresses,
    action: result.action,
    outbound: outboundForAction(result.action),
    source: result.source,
    ruleId: result.ruleId || null,
    dns: result.dns,
    explanation: explanations[result.source] || "由统一路由策略决定",
    checkedAt: new Date().toISOString()
  };
}

export async function diagnoseRoutingDomain({
  domain,
  policy: inputPolicy,
  lookup = nodeLookup,
  matchRuleSet = null
}) {
  const policy = normalizeRoutingPolicy(inputPolicy);
  const initial = routingDecisionForDomain(policy, domain);
  const normalizedDomain = String(domain).trim().toLowerCase().replace(/\.$/, "");
  if (initial.action !== "resolve") {
    return explained(initial, normalizedDomain);
  }
  if (matchRuleSet && await matchRuleSet("geosite-geolocation-cn.srs", normalizedDomain)) {
    return explained({
      action: "direct",
      source: "geosite-cn",
      dns: "domestic"
    }, normalizedDomain);
  }
  let resolved;
  try {
    resolved = await lookup(normalizedDomain, { all: true, verbatim: true });
  } catch (cause) {
    const error = new Error("域名解析失败，请检查域名或 DNS 状态");
    error.code = "DOMAIN_RESOLUTION_FAILED";
    error.statusCode = 422;
    error.cause = cause;
    throw error;
  }
  const addresses = [...new Map(
    (Array.isArray(resolved) ? resolved : [resolved])
      .filter((entry) => entry?.address)
      .map((entry) => [
        entry.address,
        { address: entry.address, family: Number(entry.family) || null }
      ])
  ).values()].slice(0, 8);
  if (!matchRuleSet || !addresses.length) {
    return explained({
      action: "proxy",
      source: "fallback",
      dns: "remote"
    }, normalizedDomain, addresses);
  }
  const matches = await Promise.all(
    addresses.map(({ address }) => matchRuleSet("geoip-cn.srs", address))
  );
  if (matches.some((match) => match === null)) {
    return explained({
      action: "proxy",
      source: "fallback",
      dns: "remote"
    }, normalizedDomain, addresses);
  }
  const allChina = matches.length > 0 && matches.every(Boolean);
  return explained({
    action: allChina ? "direct" : "proxy",
    source: allChina ? "geoip-cn" : "geoip-mixed",
    dns: allChina ? "domestic" : "remote"
  }, normalizedDomain, addresses);
}
