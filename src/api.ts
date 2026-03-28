/**
 * Sentinel Pro API Server.
 *
 * Provides REST endpoints for status, reports, and manual analysis triggers,
 * plus a WebSocket endpoint for interactive dashboard chat.
 *
 * Gateway-independent: runs on its own port, works even when the
 * OpenClaw gateway is down.
 */

import Fastify, { type FastifyReply } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import type { CliAdapter } from "./adapters/types.js";
import type { SentinelProConfig } from "./config.js";
import { getCronState, runAnalysisCycle } from "./cron.js";
import { listReports, getReport } from "./report-store.js";
import {
  listFixes,
  getFix,
  approveFix,
  rejectFix,
  rollbackFix,
  restartGateway,
} from "./fix-engine.js";
import { SYSTEM_PROMPTS } from "./prompts/index.js";
import { logger } from "./logger.js";
import {
  getAuthStatus,
  setApiKey,
  clearAuth,
  startDeviceFlow,
  getDeviceFlowStatus,
  type CliProvider,
} from "./auth-manager.js";

const log = logger.child({ module: "api" });

export async function createServer(
  adapter: CliAdapter,
  config: SentinelProConfig,
) {
  const app = Fastify({ logger: false });

  await app.register(fastifyCors, {
    origin: true, // Allow dashboard origin
    credentials: true,
  });

  await app.register(fastifyWebsocket);

  // ═══════════════════════════════════════════════════════════════════════
  // Auth middleware
  // ═══════════════════════════════════════════════════════════════════════

  app.addHook("onRequest", async (request, reply) => {
    // Skip auth for health check
    if (request.url === "/healthz") return;

    const token =
      request.headers.authorization?.replace("Bearer ", "") ??
      (request.query as Record<string, string>)?.token;

    if (token !== config.authToken) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Health Check (unauthenticated)
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/healthz", async () => {
    return { ok: true, provider: adapter.provider };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Status
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/sentinel-pro/status", async () => {
    const identity = await adapter.getIdentity();
    const cron = getCronState();
    let gatewayHealthy = false;
    try {
      const resp = await fetch(`${config.gatewayUrl}/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      gatewayHealthy = resp.ok;
    } catch {
      // Gateway unreachable — that's fine, we're independent
    }

    return {
      cli: identity,
      cron: {
        running: !!cron.job,
        schedule: config.cronSchedule,
        lastRun: cron.lastRun?.toISOString() ?? null,
        totalRuns: cron.totalRuns,
        consecutiveFailures: cron.consecutiveFailures,
        isAnalyzing: cron.running,
      },
      gateway: {
        url: config.gatewayUrl,
        healthy: gatewayHealthy,
      },
      lastReport: cron.lastResult
        ? {
            id: cron.lastResult.id,
            timestamp: cron.lastResult.timestamp,
            severity: cron.lastResult.result.severity,
            findings: cron.lastResult.result.findings.length,
            fixes: cron.lastResult.result.fixes.length,
          }
        : null,
    };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Reports
  // ═══════════════════════════════════════════════════════════════════════

  app.get("/api/sentinel-pro/reports", async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    const reports = listReports(config.dataDir, {
      limit: parseInt(query.limit ?? "20", 10),
      offset: parseInt(query.offset ?? "0", 10),
    });
    return { reports };
  });

  app.get("/api/sentinel-pro/reports/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const report = getReport(config.dataDir, id);
    if (!report) {
      return reply.code(404).send({ error: "Report not found" });
    }
    return { report };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Manual Analysis Trigger
  // ═══════════════════════════════════════════════════════════════════════

  app.post("/api/sentinel-pro/analyze", async (_request, reply) => {
    const cron = getCronState();
    if (cron.running) {
      return reply.code(409).send({ error: "Analysis already in progress" });
    }

    // Fire and don't wait — return immediately
    const resultPromise = runAnalysisCycle(adapter, config, {
      trigger: "manual",
    });

    // But register a background handler
    resultPromise
      .then((report) => {
        log.info({ reportId: report.id }, "manual analysis complete");
      })
      .catch((err) => {
        log.error({ error: String(err) }, "manual analysis failed");
      });

    return { status: "started", message: "Analysis triggered" };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Fix Management
  // ═══════════════════════════════════════════════════════════════════════

  const VALID_FIX_STATUSES = new Set(["pending", "approved", "applying", "applied", "failed", "rolled_back", "rejected"]);
  const FIX_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

  app.get("/api/sentinel-pro/fixes", async (request) => {
    const query = request.query as { status?: string; limit?: string; offset?: string };
    const status = query.status && VALID_FIX_STATUSES.has(query.status)
      ? (query.status as Parameters<typeof listFixes>[1] extends { status?: infer S } ? S : never)
      : undefined;
    const result = listFixes(config.dataDir, {
      status,
      limit: Math.min(parseInt(query.limit ?? "20", 10) || 20, 100),
      offset: Math.max(parseInt(query.offset ?? "0", 10) || 0, 0),
    });
    return result;
  });

  app.get("/api/sentinel-pro/fixes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!FIX_ID_PATTERN.test(id)) return reply.code(400).send({ error: "Invalid fix ID" });
    const fix = getFix(config.dataDir, id);
    if (!fix) return reply.code(404).send({ error: "Fix not found" });
    return { fix };
  });

  app.post("/api/sentinel-pro/fixes/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!FIX_ID_PATTERN.test(id)) return reply.code(400).send({ error: "Invalid fix ID" });
    const body = request.body as { actorId?: string } | null;
    try {
      const result = await approveFix(
        config.dataDir,
        config.workspaceDir,
        id,
        body?.actorId,
      );
      return { fix: result };
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/sentinel-pro/fixes/:id/reject", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!FIX_ID_PATTERN.test(id)) return reply.code(400).send({ error: "Invalid fix ID" });
    const body = request.body as { actorId?: string } | null;
    try {
      const result = rejectFix(config.dataDir, id, body?.actorId);
      return { fix: result };
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/sentinel-pro/fixes/:id/rollback", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!FIX_ID_PATTERN.test(id)) return reply.code(400).send({ error: "Invalid fix ID" });
    try {
      const result = await rollbackFix(config.dataDir, config.workspaceDir, id);
      return { fix: result };
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/api/sentinel-pro/gateway/restart", async (_request) => {
    return await restartGateway(config.gatewayUrl);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Auth — CLI credential management
  //
  // Supports OAuth device flow and API key auth for both Claude Code and Codex.
  // Device flow: POST /auth/:provider/device-flow/start
  //              GET  /auth/:provider/device-flow/status
  // API key:     POST /auth/:provider/api-key
  // Misc:        GET  /auth/status  (all providers at once)
  //              DELETE /auth/:provider
  // ═══════════════════════════════════════════════════════════════════════

  const VALID_PROVIDERS = new Set<CliProvider>(['claude-code', 'codex']);

  function validateProvider(provider: string, reply: FastifyReply): provider is CliProvider {
    if (!VALID_PROVIDERS.has(provider as CliProvider)) {
      void reply.code(400).send({ error: 'Invalid provider. Must be "claude-code" or "codex"' });
      return false;
    }
    return true;
  }

  /** GET /api/sentinel-pro/auth/status — combined status for all providers */
  app.get('/api/sentinel-pro/auth/status', async () => {
    return {
      'claude-code': getAuthStatus('claude-code'),
      codex: getAuthStatus('codex'),
    };
  });

  /** POST /api/sentinel-pro/auth/:provider/device-flow/start — begin OAuth device flow */
  app.post('/api/sentinel-pro/auth/:provider/device-flow/start', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (!validateProvider(provider, reply)) return;

    try {
      const session = await startDeviceFlow(provider);
      return { session };
    } catch (err) {
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /** GET /api/sentinel-pro/auth/:provider/device-flow/status — poll device flow progress */
  app.get('/api/sentinel-pro/auth/:provider/device-flow/status', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (!validateProvider(provider, reply)) return;

    const session = getDeviceFlowStatus(provider);
    if (!session) {
      return reply.code(404).send({ error: 'No active device flow session' });
    }
    return { session };
  });

  /** POST /api/sentinel-pro/auth/:provider/api-key — store API key */
  app.post('/api/sentinel-pro/auth/:provider/api-key', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (!validateProvider(provider, reply)) return;

    const body = request.body as { apiKey?: string } | null;
    const apiKey = body?.apiKey?.trim();

    if (!apiKey || apiKey.length < 10) {
      return reply.code(400).send({ error: 'apiKey is required and must be at least 10 characters' });
    }

    const result = setApiKey(provider, apiKey);
    return { ok: true, envVar: result.envVar, status: getAuthStatus(provider) };
  });

  /** DELETE /api/sentinel-pro/auth/:provider — clear credentials */
  app.delete('/api/sentinel-pro/auth/:provider', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (!validateProvider(provider, reply)) return;

    clearAuth(provider);
    return { ok: true, status: getAuthStatus(provider) };
  });



  // ═══════════════════════════════════════════════════════════════════════
  // Interactive Chat (WebSocket)
  // ═══════════════════════════════════════════════════════════════════════

  app.get(
    "/api/sentinel-pro/chat",
    { websocket: true },
    async (socket, _request) => {
      log.info("chat session opened");

      let session: Awaited<ReturnType<CliAdapter["startSession"]>> | null = null;

      try {
        session = await adapter.startSession({
          systemPrompt: SYSTEM_PROMPTS.interactive,
          workdir: config.workspaceDir,
        });

        socket.send(
          JSON.stringify({
            type: "connected",
            sessionId: session.id,
            provider: adapter.provider,
          }),
        );
      } catch (err) {
        socket.send(
          JSON.stringify({
            type: "error",
            message: `Failed to start session: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
        socket.close();
        return;
      }

      socket.on("message", async (data) => {
        if (!session?.isAlive()) {
          socket.send(JSON.stringify({ type: "error", message: "Session ended" }));
          return;
        }

        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "message" && typeof msg.content === "string") {
            socket.send(JSON.stringify({ type: "thinking" }));

            for await (const chunk of session.send(msg.content)) {
              socket.send(
                JSON.stringify({ type: "chunk", content: chunk }),
              );
            }

            socket.send(JSON.stringify({ type: "done" }));
          }
        } catch (err) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      });

      socket.on("close", async () => {
        log.info("chat session closed");
        if (session) {
          await session.destroy();
        }
      });
    },
  );

  return app;
}
