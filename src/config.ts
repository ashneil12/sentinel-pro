/**
 * Sentinel Pro configuration.
 *
 * Resolved from environment variables with sensible defaults.
 * Docker-first: all paths default to container mount points.
 */

import type { CliProvider } from "./adapters/types.js";

export interface SentinelProConfig {
  /** Port for the API server */
  port: number;
  /** Auth token for dashboard ↔ sidecar communication */
  authToken: string;
  /** Preferred CLI provider (auto-detect if not set) */
  preferredCli?: CliProvider;
  /** Cron schedule for automated analysis (cron expression) */
  cronSchedule: string;
  /** Path to OpenClaw log files (read-only mount) */
  logsDir: string;
  /** Path to OpenClaw config (read-only mount) */
  configDir: string;
  /** Path to persistent sidecar data (reports, auth, git) */
  dataDir: string;
  /** Path to source code workspace */
  workspaceDir: string;
  /** OpenClaw gateway URL (for health checks, may be down) */
  gatewayUrl: string;
  /** Max log lines to include in analysis context */
  maxLogLines: number;
  /** Time zone for cron and display */
  timezone: string;
}

export function loadConfig(): SentinelProConfig {
  const env = process.env;

  const authToken = env.SENTINEL_PRO_TOKEN ?? "";
  if (!authToken && env.NODE_ENV === "production") {
    throw new Error(
      "SENTINEL_PRO_TOKEN is required in production. " +
        "Set it in your docker-compose environment.",
    );
  }

  return {
    port: parseInt(env.SENTINEL_PRO_PORT ?? "18791", 10),
    authToken: authToken || "dev-token",
    preferredCli: parseCliProvider(env.SENTINEL_PRO_CLI),
    cronSchedule: env.CRON_SCHEDULE ?? "0 8,14,20 * * *",
    logsDir: env.SENTINEL_PRO_LOGS_DIR ?? "/logs",
    configDir: env.SENTINEL_PRO_CONFIG_DIR ?? "/config",
    dataDir: env.SENTINEL_PRO_DATA_DIR ?? "/data",
    workspaceDir: env.SENTINEL_PRO_WORKSPACE_DIR ?? "/workspace",
    gatewayUrl: env.OPENCLAW_GATEWAY_URL ?? "http://openclaw-gateway:18789",
    maxLogLines: parseInt(env.SENTINEL_PRO_MAX_LOG_LINES ?? "500", 10),
    timezone: env.TZ ?? "UTC",
  };
}

function parseCliProvider(value?: string): CliProvider | undefined {
  if (value === "claude-code" || value === "codex") return value;
  return undefined;
}
