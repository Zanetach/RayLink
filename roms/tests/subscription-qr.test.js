import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../web/subscription-qr.js", import.meta.url),
  "utf8"
);

function containerDouble() {
  const classes = new Set();
  return {
    textContent: "",
    replaceChildren() {
      this.textContent = "";
    },
    classList: {
      add(value) {
        classes.add(value);
      },
      remove(value) {
        classes.delete(value);
      },
      contains(value) {
        return classes.has(value);
      }
    }
  };
}

test("subscription QR helper reports success after rendering locally", () => {
  const window = {};
  let renderedValue = "";
  function QRCode(_container, options) {
    renderedValue = options.text;
  }
  QRCode.CorrectLevel = { M: 0 };
  vm.runInNewContext(source, { window, QRCode });
  const container = containerDouble();

  assert.equal(
    window.RayLinkSubscriptionQr.render(container, "https://sub.example.com/token"),
    true
  );
  assert.equal(renderedValue, "https://sub.example.com/token");
  assert.equal(container.classList.contains("unavailable"), false);
});

test("subscription QR failure leaves a visible copy-link fallback", () => {
  const window = {};
  function QRCode() {
    throw new Error("canvas unavailable");
  }
  QRCode.CorrectLevel = { M: 0 };
  vm.runInNewContext(source, { window, QRCode });
  const container = containerDouble();

  assert.equal(
    window.RayLinkSubscriptionQr.render(container, "https://sub.example.com/token"),
    false
  );
  assert.equal(container.classList.contains("unavailable"), true);
  assert.match(container.textContent, /复制下方订阅链接/);
});
