function deliveryError(status) {
  const error = new Error(`告警 Webhook 返回 HTTP ${status}`);
  error.code = "ALERT_WEBHOOK_FAILED";
  return error;
}

export class AlertWebhookDispatcher {
  constructor({
    webhookUrl = "",
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
    timeoutMs = 5_000
  } = {}) {
    this.webhookUrl = String(webhookUrl || "");
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.active = new Map();
    this.lastSuccessAt = null;
    this.lastError = null;
  }

  status() {
    return {
      enabled: Boolean(this.webhookUrl),
      active: this.active.size,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError
    };
  }

  async send(event, alert) {
    const response = await this.fetchImpl(this.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "RayLink-Alert-Webhook/1"
      },
      body: JSON.stringify({
        schemaVersion: 1,
        event,
        alert,
        sentAt: this.clock().toISOString()
      }),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) throw deliveryError(response.status);
  }

  async dispatch(alerts = []) {
    if (!this.webhookUrl) {
      return { enabled: false, opened: 0, resolved: 0, active: 0 };
    }
    const current = new Map(alerts.map((alert) => [alert.id, alert]));
    const opened = [...current.values()].filter((alert) => !this.active.has(alert.id));
    const resolved = [...this.active.values()].filter((alert) => !current.has(alert.id));
    try {
      for (const alert of opened) {
        await this.send("alert.opened", alert);
        this.active.set(alert.id, alert);
      }
      for (const alert of resolved) {
        await this.send("alert.resolved", {
          ...alert,
          resolvedAt: this.clock().toISOString()
        });
        this.active.delete(alert.id);
      }
      this.lastSuccessAt = this.clock().toISOString();
      this.lastError = null;
      return {
        enabled: true,
        opened: opened.length,
        resolved: resolved.length,
        active: this.active.size
      };
    } catch (error) {
      this.lastError = {
        message: String(error.message || "告警 Webhook 发送失败").slice(0, 300),
        at: this.clock().toISOString()
      };
      throw error;
    }
  }
}
