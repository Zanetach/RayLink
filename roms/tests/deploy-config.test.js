import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production reverse proxy excludes bearer subscription URLs from access logs", async () => {
  const config = await readFile(new URL("../deploy/nginx.conf.example", import.meta.url), "utf8");
  assert.match(config, /map \$uri \$raylink_loggable/);
  assert.match(config, /~\^\/sub\/\s+0;/);
  assert.match(config, /access_log .* if=\$raylink_loggable;/);
  assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:4173;/);
});
