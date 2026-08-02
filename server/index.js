import { createRayLinkApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await createRayLinkApp(config);

await app.listen({ host: config.host, port: config.port });

if (config.adminPassword === "Admin@2026") {
  console.warn("[RayLink] Development password is active. Set RAYLINK_ADMIN_PASSWORD before exposing this service.");
}
console.log(`[RayLink] Control plane listening on ${config.publicOrigin}`);
console.log(`[RayLink] sing-box runtime mode: ${config.runtimeMode}, config port: ${config.listenPort}`);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[RayLink] Received ${signal}, shutting down`);
  await app.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
