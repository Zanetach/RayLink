import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../web/protocol-health.js", import.meta.url),
  "utf8"
);

function loadPresenter() {
  const context = { window: {}, Intl, Date };
  vm.runInNewContext(source, context);
  return context.window.RayLinkProtocolHealth;
}

test("protocol health presentation exposes availability, connection time, jitter and check time", () => {
  const presenter = loadPresenter();
  const result = presenter.present({
    publicCheck: {
      availability: "available",
      reachable: true,
      latencyMs: 128,
      jitterMs: 14,
      checkedAt: "2026-07-28T12:19:49.365Z"
    }
  });

  assert.equal(result.availabilityLabel, "可用");
  assert.equal(result.latencyLabel, "128 ms");
  assert.equal(result.jitterLabel, "14 ms");
  assert.match(result.summary, /连接耗时 128 ms/);
  assert.match(result.summary, /抖动 14 ms/);
  assert.match(result.summary, /最近检测/);
});

test("protocol health presentation shows a pending recheck before the third failure", () => {
  const presenter = loadPresenter();
  const result = presenter.present({
    publicCheck: {
      availability: "degraded",
      reachable: true,
      latencyMs: 88,
      jitterMs: 7,
      consecutiveFailures: 2,
      checkedAt: "2026-07-28T12:19:49.365Z",
      lastSuccessAt: "2026-07-28T12:00:00.000Z",
      error: "connection timed out"
    }
  });

  assert.equal(result.label, "复检 2/3");
  assert.equal(result.availabilityLabel, "复检中");
  assert.equal(result.className, "warning");
  assert.match(result.summary, /最近成功 88 ms/);
  assert.doesNotMatch(result.summary, /^超时/);
});
