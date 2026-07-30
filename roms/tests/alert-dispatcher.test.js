import assert from "node:assert/strict";
import test from "node:test";

import { AlertWebhookDispatcher } from "../server/alert-dispatcher.js";

test("alert webhook sends opened and resolved transitions without repeating stable state", async () => {
  const deliveries = [];
  const dispatcher = new AlertWebhookDispatcher({
    webhookUrl: "https://alerts.example.com/raylink",
    fetchImpl: async (url, options) => {
      deliveries.push({ url, payload: JSON.parse(options.body) });
      return { ok: true, status: 204 };
    },
    clock: () => new Date("2026-07-30T12:00:00.000Z")
  });
  const alert = {
    id: "alert-1",
    code: "HOST_OFFLINE",
    severity: "critical",
    title: "Singapore 节点离线",
    message: "超过 60 秒未收到有效节点指标。",
    resourceType: "host",
    resourceId: "sg-01",
    createdAt: "2026-07-30T11:59:00.000Z"
  };

  assert.deepEqual(await dispatcher.dispatch([alert]), {
    enabled: true,
    opened: 1,
    resolved: 0,
    active: 1
  });
  assert.equal(deliveries[0].payload.event, "alert.opened");
  await dispatcher.dispatch([alert]);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(await dispatcher.dispatch([]), {
    enabled: true,
    opened: 0,
    resolved: 1,
    active: 0
  });
  assert.equal(deliveries[1].payload.event, "alert.resolved");
  assert.equal(deliveries[1].payload.alert.id, "alert-1");
});

test("failed webhook delivery remains retryable", async () => {
  let attempts = 0;
  const dispatcher = new AlertWebhookDispatcher({
    webhookUrl: "https://alerts.example.com/raylink",
    fetchImpl: async () => {
      attempts += 1;
      return { ok: attempts > 1, status: attempts > 1 ? 204 : 503 };
    }
  });
  const alert = {
    id: "alert-1",
    code: "HOST_OFFLINE",
    severity: "critical",
    title: "Node offline",
    message: "offline",
    resourceType: "host",
    resourceId: "sg-01",
    createdAt: new Date().toISOString()
  };

  await assert.rejects(() => dispatcher.dispatch([alert]), /503/);
  assert.equal(dispatcher.status().active, 0);
  await dispatcher.dispatch([alert]);
  assert.equal(attempts, 2);
  assert.equal(dispatcher.status().active, 1);
});
