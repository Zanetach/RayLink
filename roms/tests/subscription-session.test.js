import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../web/subscription-session.js", import.meta.url),
  "utf8"
);

function loadSubscriptionSession() {
  const context = { window: {} };
  vm.runInNewContext(source, context);
  return context.window.RayLinkSubscriptionSession;
}

test("generated subscription URLs remain available only in the current browser session", () => {
  const currentSession = loadSubscriptionSession();
  currentSession.remember("user-1", "https://sub.example.com/private-token");

  assert.equal(
    currentSession.get("user-1"),
    "https://sub.example.com/private-token"
  );
  assert.equal(
    loadSubscriptionSession().get("user-1"),
    "",
    "a page refresh creates a new in-memory session without the bearer URL"
  );
});

test("logging out clears every generated subscription URL from memory", () => {
  const currentSession = loadSubscriptionSession();
  currentSession.remember("user-1", "https://sub.example.com/token-1");
  currentSession.remember("user-2", "https://sub.example.com/token-2");

  currentSession.clear();

  assert.equal(currentSession.get("user-1"), "");
  assert.equal(currentSession.get("user-2"), "");
});
