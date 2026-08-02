export const ROUTE_POLICY_GROUPS = Object.freeze({
  proxy: Object.freeze({ tag: "raylink-auto", name: "RayLink 代理" }),
  ai: Object.freeze({ tag: "raylink-ai", name: "AI 网站代理" }),
  smart: Object.freeze({ tag: "raylink-smart", name: "RayLink 智能" }),
  tcp: Object.freeze({ tag: "raylink-tcp", name: "TCP 稳定" }),
  udp: Object.freeze({ tag: "raylink-udp", name: "UDP 高速" }),
  fallback: Object.freeze({ tag: "raylink-fallback", name: "故障回退" }),
  manual: Object.freeze({ tag: "raylink-manual", name: "手动选择" }),
  direct: Object.freeze({ tag: "direct", name: "DIRECT" })
});

export const DEFAULT_ROUTE_PROBE_URL = "https://www.gstatic.com/generate_204";

export const AI_DOMAIN_SUFFIXES = Object.freeze([
  "openai.com",
  "chatgpt.com",
  "oaistatic.com",
  "oaiusercontent.com",
  "anthropic.com",
  "claude.ai",
  "perplexity.ai",
  "poe.com",
  "x.ai",
  "grok.com",
  "gemini.google.com",
  "generativelanguage.googleapis.com"
]);

export const CHINA_FALLBACK_DOMAIN_SUFFIXES = Object.freeze([
  ".cn",
  "126.com",
  "163.com",
  "alipay.com",
  "aliyun.com",
  "baidu.com",
  "bilibili.com",
  "bytedance.com",
  "douyin.com",
  "huawei.com",
  "jd.com",
  "mi.com",
  "qq.com",
  "taobao.com",
  "tmall.com",
  "toutiao.com",
  "weibo.com",
  "xiaomi.com",
  "zhihu.com"
]);

function uniqueExisting(members, names) {
  const available = new Set(names);
  return [...new Set(members)].filter((name) => available.has(name));
}

export function createRoutePolicyCandidates({
  names,
  smart = [],
  tcp = [],
  udp = []
}) {
  const all = [...new Set(names)];
  const automatic = uniqueExisting(smart, all);
  const tcpCandidates = uniqueExisting(tcp, all);
  const udpCandidates = uniqueExisting(udp, all);
  const effectiveAutomatic = automatic.length ? automatic : all;
  const stable = [...new Set([
    ...(tcpCandidates.length ? tcpCandidates : effectiveAutomatic),
    ...udpCandidates
  ])];
  return {
    all,
    automatic: effectiveAutomatic,
    tcp: tcpCandidates.length ? tcpCandidates : effectiveAutomatic,
    udp: udpCandidates,
    stable,
    manual: [...new Set([...stable, ...all])],
    policyChoices: [
      ROUTE_POLICY_GROUPS.fallback.name,
      ROUTE_POLICY_GROUPS.smart.name,
      ROUTE_POLICY_GROUPS.tcp.name,
      ...(udpCandidates.length ? [ROUTE_POLICY_GROUPS.udp.name] : []),
      ROUTE_POLICY_GROUPS.manual.name
    ]
  };
}

export function routeProbeUrlFromConfig(config, fallback = DEFAULT_ROUTE_PROBE_URL) {
  const configured = (config?.outbounds || []).find((outbound) => (
    outbound?.type === "urltest"
    && outbound.tag === ROUTE_POLICY_GROUPS.smart.tag
    && typeof outbound.url === "string"
    && outbound.url.trim()
  ))?.url;
  return configured || fallback;
}
