import assert from "node:assert/strict";
import test from "node:test";

import {
  protectSubscriptionSecret,
  revealSubscriptionSecret
} from "../server/security.js";

test("subscription bearer credentials are recoverable without storing plaintext", () => {
  const secret = "private-subscription-bearer";
  const envelope = protectSubscriptionSecret(
    secret,
    "separate-encryption-key",
    "public-user-id"
  );

  assert.doesNotMatch(envelope, /private-subscription-bearer/);
  assert.equal(
    revealSubscriptionSecret(
      envelope,
      "separate-encryption-key",
      "public-user-id"
    ),
    secret
  );
  assert.throws(() => revealSubscriptionSecret(
    envelope,
    "wrong-key",
    "public-user-id"
  ));
  const [version, iv, tag, ciphertext] = envelope.split(".");
  assert.throws(() => revealSubscriptionSecret(
    [version, iv, tag.slice(0, 6), ciphertext].join("."),
    "separate-encryption-key",
    "public-user-id"
  ));
});
