/**
 * Cron Scheduler — runs automated log analysis at configured intervals.
 *
 * Supports configurable schedules (default: 3× daily at 08:00, 14:00, 20:00).
 * Each run ingests recent logs, passes them to the CLI adapter for analysis,
 * and stores the results as a report.
 */

import { CronJob } from "cron";
import type { CliAdapter, AnalysisResult } from "./adapters/types.js";
import type { SentinelProConfig } from "./config.js";
import { ingestLogs, formatLogContext } from "./log-ingester.js";
import { storeReport, type StoredReport } from "./report-store.js";
import { approveFix, restartGateway, registerFixesFromReport } from "./fix-engine.js";
import { SYSTEM_PROMPTS } from "./prompts/index.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "cron" });

export interface CronState {
  job: CronJob | null;
  running: boolean;
  lastRun: Date | null;
  lastResult: StoredReport | null;
  totalRuns: number;
  consecutiveFailures: number;
}

const state: CronState = {
  job: null,
  running: false,
  lastRun: null,
  lastResult: null,
  totalRuns: 0,
  consecutiveFailures: 0,
};

/**
 * Run a single analysis cycle.
 *
 * This is the core loop:
 * 1. Ingest logs from the shared volume
 * 2. Build context string
 * 3. Pass to CLI adapter for analysis
 * 4. Store the report
 * 5. Return the result
 */
export async function runAnalysisCycle(
  adapter: CliAdapter,
  config: SentinelProConfig,
  opts?: { hoursBack?: number; trigger?: "cron" | "manual" },
): Promise<StoredReport> {
  const trigger = opts?.trigger ?? "cron";
  log.info({ trigger }, "starting analysis cycle");

  state.running = true;
  const startMs = Date.now();

  try {
    // 1. Ingest logs
    const logWindow = ingestLogs({
      logsDir: config.logsDir,
      maxLogLines: config.maxLogLines,
      hoursBack: opts?.hoursBack ?? 12,
      includeAll: config.autopilotMode, // In autopilot, see full context
    });

    if (logWindow.totalLines === 0) {
      log.info("no log data found — skipping analysis");
      const report = storeReport(
        {
          success: true,
          output: "No log data found to analyze.",
          findings: [],
          fixes: [],
          severity: "healthy",
          durationMs: Date.now() - startMs,
        },
        trigger,
        config.dataDir,
      );
      state.lastResult = report;
      state.lastRun = new Date();
      state.totalRuns++;
      state.consecutiveFailures = 0;
      state.running = false;
      return report;
    }

    // 2. Build context
    const context = formatLogContext(logWindow);

    // 3. Choose the right system prompt based on time of day
    const hour = new Date().getHours();
    const promptKey = hour < 12 ? "morning" : hour < 18 ? "midday" : "evening";
    const systemPrompt = SYSTEM_PROMPTS[promptKey];

    // 4. Run analysis
    const result = await adapter.analyze({
      systemPrompt,
      context,
      task: buildTaskDescription(trigger, logWindow),
      workdir: config.workspaceDir,
    });

    // 5. Build report & register fixes
    const report = storeReport(result, trigger, config.dataDir);
    const registeredFixes = registerFixesFromReport(config.dataDir, report.id, result.fixes);

    if (config.autopilotMode && registeredFixes.length > 0) {
      log.info({ fixes: registeredFixes.length }, "autopilot mode enabled — applying fixes automatically");
      
      let restartNeeded = false;
      for (const fix of registeredFixes) {
        try {
          await approveFix(config.dataDir, config.workspaceDir, fix.id, "autopilot");
          restartNeeded = true;
        } catch (err) {
          log.error({ fixId: fix.id, error: String(err) }, "autopilot failed to apply fix");
        }
      }

      if (restartNeeded) {
        log.info("autopilot restarting gateway to apply fixes");
        restartGateway(config.gatewayUrl);
      }
    }

    state.lastResult = report;
    state.lastRun = new Date();
    state.totalRuns++;
    state.consecutiveFailures = result.success ? 0 : state.consecutiveFailures + 1;
    state.running = false;

    log.info(
      {
        success: result.success,
        findings: result.findings.length,
        fixes: result.fixes.length,
        severity: result.severity,
        durationMs: result.durationMs,
      },
      "analysis cycle complete",
    );

    return report;
  } catch (err) {
    state.running = false;
    state.consecutiveFailures++;
    const error = err instanceof Error ? err.message : String(err);
    log.error({ error, consecutiveFailures: state.consecutiveFailures }, "analysis cycle failed");

    const report = storeReport(
      {
        success: false,
        output: "",
        findings: [],
        fixes: [],
        severity: "info",
        durationMs: Date.now() - startMs,
        error,
      },
      trigger,
      config.dataDir,
    );
    state.lastResult = report;
    state.lastRun = new Date();
    state.totalRuns++;
    return report;
  }
}

function buildTaskDescription(
  trigger: string,
  logWindow: { totalLines: number; from: Date; to: Date },
): string {
  return [
    `Analyze the server logs from the last ${Math.round((logWindow.to.getTime() - logWindow.from.getTime()) / 3_600_000)} hours.`,
    `Total log events: ${logWindow.totalLines}.`,
    `Trigger: ${trigger}.`,
    "",
    "Look for:",
    "1. Recurring errors or exceptions — identify root causes",
    "2. Performance degradation — slow responses, timeouts, high latency",
    "3. Memory/resource issues — leaks, excessive consumption",
    "4. Channel connectivity problems — disconnections, auth failures",
    "5. Cache behavior anomalies — unexpected misses, stale data",
    "6. Security concerns — unusual access patterns, auth failures",
    "",
    "For each issue found, provide:",
    "- Severity (CRITICAL / WARNING / INFO)",
    "- Clear description of what's happening and why",
    "- Source file and line if identifiable",
    "- Suggested fix (with diff if possible)",
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Cron Job Management
// ═══════════════════════════════════════════════════════════════════════════

export function startCron(
  adapter: CliAdapter,
  config: SentinelProConfig,
): void {
  if (state.job) {
    log.warn("cron already running, stopping first");
    stopCron();
  }

  log.info({ schedule: config.cronSchedule, tz: config.timezone }, "starting cron scheduler");

  state.job = CronJob.from({
    cronTime: config.cronSchedule,
    onTick: () => {
      if (state.running) {
        log.warn("skipping cron tick — previous analysis still running");
        return;
      }
      runAnalysisCycle(adapter, config, { trigger: "cron" }).catch((err) => {
        log.error({ error: String(err) }, "cron tick unhandled error");
      });
    },
    timeZone: config.timezone,
    start: true,
  });

  log.info("cron scheduler started");
}

export function stopCron(): void {
  if (state.job) {
    state.job.stop();
    state.job = null;
    log.info("cron scheduler stopped");
  }
}

export function getCronState(): Readonly<CronState> {
  return { ...state };
}
