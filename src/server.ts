/**
 * Sentinel Pro — entry point.
 *
 * Bootstraps the sidecar: loads config, detects/creates CLI adapter,
 * starts the cron scheduler, and launches the API server.
 */

import { loadConfig } from "./config.js";
import { createAdapter } from "./adapters/index.js";
import { startCron } from "./cron.js";
import { createServer } from "./api.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "main" });

async function main() {
  log.info("╔══════════════════════════════════════╗");
  log.info("║     Sentinel Pro — AI Debugging      ║");
  log.info("║     Gateway-independent sidecar       ║");
  log.info("╚══════════════════════════════════════╝");

  // 1. Load configuration
  const config = loadConfig();
  log.info(
    {
      port: config.port,
      cron: config.cronSchedule,
      logsDir: config.logsDir,
      preferredCli: config.preferredCli ?? "auto",
    },
    "configuration loaded",
  );

  // 2. Detect and create CLI adapter
  const adapter = await createAdapter(config.preferredCli);
  if (!adapter) {
    log.fatal(
      "No CLI adapter available. Install Claude Code (`npm i -g @anthropic-ai/claude-code`) " +
        "or Codex CLI (`npm i -g @openai/codex`) and authenticate.",
    );
    process.exit(1);
  }

  const identity = await adapter.getIdentity();
  log.info(
    { provider: identity.provider, authenticated: identity.authenticated },
    "CLI adapter ready",
  );

  if (!identity.authenticated) {
    log.warn(
      "CLI is installed but not authenticated. " +
        "Cron analysis will fail until you authenticate. " +
        "Run `claude login` or set OPENAI_API_KEY in the container.",
    );
  }

  // 3. Start cron scheduler
  startCron(adapter, config);

  // 4. Start API server
  const server = await createServer(adapter, config);

  await server.listen({
    port: config.port,
    host: "0.0.0.0", // Bind to all interfaces for Docker networking
  });

  log.info({ port: config.port }, "API server listening");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.fatal({ error: String(err) }, "failed to start");
  process.exit(1);
});
