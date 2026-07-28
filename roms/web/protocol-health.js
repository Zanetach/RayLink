window.RayLinkProtocolHealth = (() => {
  function checkedTime(value) {
    if (!value) return "尚未检测";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(date);
  }

  function finiteMilliseconds(value) {
    return Number.isFinite(Number(value))
      ? `${Math.max(0, Math.round(Number(value)))} ms`
      : "—";
  }

  function present(activation) {
    const check = activation?.publicCheck;
    if (!check?.checkedAt) {
      return {
        label: "待检测",
        availabilityLabel: "待检测",
        latencyLabel: "—",
        jitterLabel: "—",
        checkedLabel: "尚未检测",
        className: "neutral",
        summary: "尚未执行协议连接测试",
        title: "尚未执行协议连接测试"
      };
    }
    const checkedLabel = checkedTime(check.checkedAt);
    if (check.unsupported) {
      const reason = check.reason || "该协议不提供独立连接检测";
      return {
        label: "不适用",
        availabilityLabel: "不适用",
        latencyLabel: "—",
        jitterLabel: "—",
        checkedLabel,
        className: "neutral",
        summary: `${reason} · 最近检测 ${checkedLabel}`,
        title: `${reason} · 最近检测 ${checkedLabel}`
      };
    }

    const probeLabel = check.probe === "sing-box-tools-fetch"
      ? "完整协议握手与外部访问"
      : check.probe === "tcp-connect"
        ? "TCP 连接"
        : "协议连接";
    const latencyLabel = finiteMilliseconds(check.latencyMs);
    const jitterLabel = finiteMilliseconds(check.jitterMs);
    const legacyUnconfirmedFailure = check.reachable === false
      && check.availability === undefined
      && check.consecutiveFailures === undefined;
    const failures = legacyUnconfirmedFailure
      ? 1
      : Math.min(3, Math.max(0, Number(check.consecutiveFailures || 0)));

    if ((check.availability === "degraded" || legacyUnconfirmedFailure) && failures > 0) {
      const summary = `复检中 ${failures}/3 · 最近成功 ${latencyLabel} · 抖动 ${jitterLabel} · 最近检测 ${checkedLabel}`;
      return {
        label: `复检 ${failures}/3`,
        availabilityLabel: "复检中",
        latencyLabel,
        jitterLabel,
        checkedLabel,
        className: "warning",
        summary,
        title: `${summary} · ${check.error || "本轮连接失败"}`
      };
    }

    if (check.reachable === true && latencyLabel !== "—") {
      const latencyMs = Math.max(0, Math.round(Number(check.latencyMs)));
      const summary = `可用 · 连接耗时 ${latencyLabel} · 抖动 ${jitterLabel} · 最近检测 ${checkedLabel}`;
      return {
        label: latencyLabel,
        availabilityLabel: "可用",
        latencyLabel,
        jitterLabel,
        checkedLabel,
        className: latencyMs <= 120 ? "good" : "warning",
        summary,
        title: `${probeLabel} · ${summary}`
      };
    }

    const timedOut = /tim(?:e|ed)[ -]?out|超时/i.test(String(check.error || ""));
    const label = timedOut ? "超时" : "不可达";
    const lastSuccess = latencyLabel === "—" ? "" : ` · 最近成功 ${latencyLabel}`;
    const lastJitter = jitterLabel === "—" ? "" : ` · 抖动 ${jitterLabel}`;
    const summary = `${label}${lastSuccess}${lastJitter} · 连续失败 ${failures}/3 · 最近检测 ${checkedLabel}`;
    return {
      label,
      availabilityLabel: "不可用",
      latencyLabel,
      jitterLabel,
      checkedLabel,
      className: "danger",
      summary,
      title: `${summary} · ${check.error || "协议连接测试失败"}`
    };
  }

  return Object.freeze({ present });
})();
