import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sessionSource = await readFile(
  new URL("../web/subscription-session.js", import.meta.url),
  "utf8"
);
const quickSource = await readFile(
  new URL("../web/subscription-quick.js", import.meta.url),
  "utf8"
);

function loadHelpers() {
  const context = { window: {} };
  vm.runInNewContext(sessionSource, context);
  vm.runInNewContext(quickSource, context);
  return {
    quick: context.window.RayLinkSubscriptionQuick,
    session: context.window.RayLinkSubscriptionSession
  };
}

function createPanel() {
  const result = { hidden: true };
  const input = { value: "" };
  const qr = { rendered: "" };
  const fields = new Map([
    ["[data-user-subscription-result]", result],
    ["#user-subscription-url", input],
    ["[data-user-subscription-qr]", qr]
  ]);
  const panel = { querySelector: (selector) => fields.get(selector) || null };
  return { panel, result, input, qr };
}

test("quick subscription controller reveals and rehydrates a generated QR link", () => {
  const { quick, session } = loadHelpers();
  const first = createPanel();
  const url = "https://sub.example.com/private-token";
  const qrRenderer = (container, value) => {
    container.rendered = value;
    return true;
  };

  assert.equal(quick.reveal({
    panel: first.panel,
    userId: "user-1",
    url,
    session,
    qrRenderer
  }), true);
  assert.equal(first.result.hidden, false);
  assert.equal(first.input.value, url);
  assert.equal(first.qr.rendered, url);

  const reopened = createPanel();
  assert.equal(quick.hydrate({
    scope: { querySelector: () => reopened.panel },
    userId: "user-1",
    session,
    qrRenderer
  }), true);
  assert.equal(reopened.result.hidden, false);
  assert.equal(reopened.input.value, url);
  assert.equal(reopened.qr.rendered, url);
});

test("quick subscription controller clears bearer URLs on logout", () => {
  const { quick, session } = loadHelpers();
  session.remember("user-1", "https://sub.example.com/private-token");

  quick.clear(session);

  assert.equal(session.get("user-1"), "");
});
