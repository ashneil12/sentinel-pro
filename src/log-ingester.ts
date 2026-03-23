/**
 * Log Ingester — reads and tails OpenClaw log files.
 *
 * Supports both the main rolling log (openclaw-YYYY-MM-DD.log)
 * and the cache trace JSONL (cache-trace.jsonl).
 *
 * Gateway-independent: reads files directly from the shared volume,
 * works even when the gateway is down.
 */

import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

const log = logger.child({ module: "log-ingester" });

export interface LogWindow {
  /** Main server log lines (most recent N) */
  serverLogs: string[];
  /** Cache trace events (parsed JSON objects) */
  cacheTraceEvents: CacheTraceEvent[];
  /** Sentinel history reports (if available) */
  sentinelReports: SentinelHistoryEntry[];
  /** Timespan of the log window */
  from: Date;
  to: Date;
  /** Total lines read */
  totalLines: number;
}

export interface CacheTraceEvent {
  ts: string;
  stage: string;
  runId?: string;
  sessionId?: string;
  provider?: string;
  modelId?: string;
  error?: string;
  note?: string;
  messageCount?: number;
  [key: string]: unknown;
}

export interface SentinelHistoryEntry {
  timestamp: string;
  healthy: boolean;
  issueCount: number;
  remediationCount: number;
  escalated: boolean;
  [key: string]: unknown;
}

/**
 * Find the most recent OpenClaw log files in the logs directory.
 * Logs follow the pattern: openclaw-YYYY-MM-DD.log
 */
function findLogFiles(logsDir: string, maxFiles: number = 2): string[] {
  try {
    const entries = fs.readdirSync(logsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.startsWith("openclaw-") && e.name.endsWith(".log"))
      .map((e) => e.name)
      .sort()
      .reverse()
      .slice(0, maxFiles)
      .map((name) => path.join(logsDir, name));
  } catch (err) {
    log.warn({ logsDir, error: String(err) }, "failed to scan log directory");
    return [];
  }
}

/**
 * Read the last N lines from a file efficiently.
 * Uses a reverse-read approach for large files.
 */
function tailFile(filePath: string, maxLines: number): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];

    const stat = fs.statSync(filePath);
    if (stat.size === 0) return [];

    // For small files, just read the whole thing
    if (stat.size < 5 * 1024 * 1024) {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim());
      return lines.slice(-maxLines);
    }

    // For large files, read the last chunk
    const chunkSize = Math.min(stat.size, maxLines * 1024); // ~1KB per line estimate
    const buffer = Buffer.alloc(chunkSize);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buffer, 0, chunkSize, stat.size - chunkSize);
      const content = buffer.toString("utf8");
      const lines = content.split("\n").filter((l) => l.trim());
      return lines.slice(-maxLines);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    log.warn({ filePath, error: String(err) }, "failed to tail file");
    return [];
  }
}

/**
 * Parse JSONL file into typed objects.
 */
function readJsonlFile<T>(filePath: string, maxEntries: number): T[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = tailFile(filePath, maxEntries);
    const entries: T[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as T);
      } catch {
        // skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Filter log lines to only include errors, warnings, and notable events
 * to reduce noise in the analysis context.
 */
function filterNotableLines(lines: string[]): string[] {
  const notable: string[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const level = parsed._level ?? parsed.level ?? parsed[1] ?? "";
      const levelStr = typeof level === "number"
        ? (level <= 1 ? "error" : level === 2 ? "warn" : "info")
        : String(level).toLowerCase();

      if (
        levelStr === "error" ||
        levelStr === "fatal" ||
        levelStr === "warn" ||
        levelStr === "warning"
      ) {
        notable.push(line);
      }
    } catch {
      // Non-JSON lines — include if they look like errors
      const lower = line.toLowerCase();
      if (
        lower.includes("error") ||
        lower.includes("fatal") ||
        lower.includes("warn") ||
        lower.includes("exception") ||
        lower.includes("crash")
      ) {
        notable.push(line);
      }
    }
  }
  return notable;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main API
// ═══════════════════════════════════════════════════════════════════════════

export interface IngestOptions {
  logsDir: string;
  maxLogLines?: number;
  hoursBack?: number;
  /** If true, include ALL log lines, not just errors/warnings */
  includeAll?: boolean;
}

/**
 * Ingest log files from the shared volume and produce a structured LogWindow.
 *
 * This is the primary entry point for the cron scheduler and on-demand analysis.
 */
export function ingestLogs(opts: IngestOptions): LogWindow {
  const maxLines = opts.maxLogLines ?? 500;
  const now = new Date();

  log.info({ logsDir: opts.logsDir, maxLines }, "ingesting logs");

  // 1. Read main server logs
  const logFiles = findLogFiles(opts.logsDir);
  let allServerLines: string[] = [];
  for (const file of logFiles) {
    const lines = tailFile(file, maxLines);
    allServerLines = allServerLines.concat(lines);
  }

  // Filter to notable lines unless includeAll is set
  const serverLogs = opts.includeAll
    ? allServerLines.slice(-maxLines)
    : filterNotableLines(allServerLines).slice(-maxLines);

  // 2. Read cache trace events
  const cacheTracePath = path.join(opts.logsDir, "cache-trace.jsonl");
  const cacheTraceEvents = readJsonlFile<CacheTraceEvent>(cacheTracePath, 100);

  // 3. Read sentinel history
  const sentinelHistoryPath = path.join(opts.logsDir, "sentinel-history.jsonl");
  const sentinelReports = readJsonlFile<SentinelHistoryEntry>(sentinelHistoryPath, 50);

  // Determine time window
  const from = new Date(now.getTime() - (opts.hoursBack ?? 12) * 60 * 60_000);
  const totalLines = serverLogs.length + cacheTraceEvents.length + sentinelReports.length;

  log.info(
    {
      serverLogLines: serverLogs.length,
      cacheTraceEvents: cacheTraceEvents.length,
      sentinelReports: sentinelReports.length,
    },
    "log ingestion complete",
  );

  return {
    serverLogs,
    cacheTraceEvents,
    sentinelReports,
    from,
    to: now,
    totalLines,
  };
}

/**
 * Format a LogWindow into a string context for CLI analysis.
 */
export function formatLogContext(window: LogWindow): string {
  const sections: string[] = [];

  sections.push(`## Log Window: ${window.from.toISOString()} → ${window.to.toISOString()}`);
  sections.push(`Total events: ${window.totalLines}`);
  sections.push("");

  if (window.serverLogs.length > 0) {
    sections.push("### Server Logs (errors and warnings)");
    sections.push("```");
    sections.push(...window.serverLogs.slice(-200));
    sections.push("```");
    sections.push("");
  }

  if (window.cacheTraceEvents.length > 0) {
    sections.push("### Cache Trace Events");
    sections.push("```json");
    for (const event of window.cacheTraceEvents.slice(-20)) {
      sections.push(JSON.stringify(event));
    }
    sections.push("```");
    sections.push("");
  }

  if (window.sentinelReports.length > 0) {
    const unhealthy = window.sentinelReports.filter((r) => !r.healthy);
    if (unhealthy.length > 0) {
      sections.push("### Recent Sentinel Reports (unhealthy only)");
      sections.push("```json");
      for (const report of unhealthy.slice(-10)) {
        sections.push(JSON.stringify(report));
      }
      sections.push("```");
    }
  }

  return sections.join("\n");
}
