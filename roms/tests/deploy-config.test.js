import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production Caddy entry point preserves private subscription URLs", async () => {
  const config = await readFile(
    new URL("../deploy/caddy-first-run.Caddyfile", import.meta.url),
    "utf8"
  );
  const installer = await readFile(
    new URL("../deploy/install-control-plane.sh", import.meta.url),
    "utf8"
  );
  const service = await readFile(
    new URL("../deploy/raylink.service", import.meta.url),
    "utf8"
  );
  const environmentExample = await readFile(
    new URL("../deploy/raylink.env.example", import.meta.url),
    "utf8"
  );

  assert.match(config, /https:\/\/__RAYLINK_PUBLIC_HOST__ \{/);
  assert.match(
    config,
    /tls \/etc\/caddy\/raylink\/control-plane\.crt \/etc\/caddy\/raylink\/control-plane\.key/
  );
  assert.match(config, /reverse_proxy 127\.0\.0\.1:4173/);
  assert.doesNotMatch(config, /^\s*log\s/m);
  assert.match(installer, /apt-get install -y .*caddy/);
  assert.match(installer, /65760C51EDEA2017CEA2CA15155B6D79CA56EA34/);
  assert.match(installer, /Caddyfile\.before-raylink/);
  assert.match(installer, /RAYLINK_SUBSCRIPTION_ORIGIN=\$\{public_origin\}/);
  assert.match(installer, /caddy validate --config "\$managed_root\/Caddyfile" --adapter caddyfile/);
  assert.match(installer, /systemctl enable --now caddy/);
  assert.doesNotMatch(installer, /systemctl enable --now nginx/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/raylink \/usr\/local\/bin/);
  assert.doesNotMatch(service, /ReadWritePaths=.*\/etc\/caddy(?:\s|$)/);
  assert.doesNotMatch(service, /ReadWritePaths=.*\/etc\/raylink(?:\s|$)/);
  assert.match(environmentExample, /RAYLINK_SUBSCRIPTION_ORIGIN=https:\/\/sub\.example\.com/);
  assert.match(environmentExample, /RAYLINK_PROXY_HOST=node\.example\.com/);
});
