/**
 * Tests for the log ingester — file reading, filtering, and context formatting.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ingestLogs, formatLogContext } from "../src/log-ingester.js";

describe("ingestLogs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-pro-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty window when logs directory is empty", () => {
    const result = ingestLogs({ logsDir: tmpDir, maxLogLines: 100 });
    expect(result.serverLogs).toHaveLength(0);
    expect(result.cacheTraceEvents).toHaveLength(0);
    expect(result.sentinelReports).toHaveLength(0);
    expect(result.totalLines).toBe(0);
  });

  it("reads openclaw log files sorted by date", () => {
    const today = new Date().toISOString().split("T")[0];
    const logFile = path.join(tmpDir, `openclaw-${today}.log`);
    const lines = [
      JSON.stringify({ _level: 1, message: "test error", time: new Date().toISOString() }),
      JSON.stringify({ _level: 3, message: "test info", time: new Date().toISOString() }),
      JSON.stringify({ _level: 2, message: "test warning", time: new Date().toISOString() }),
    ];
    fs.writeFileSync(logFile, lines.join("\n") + "\n");

    const result = ingestLogs({ logsDir: tmpDir, maxLogLines: 100 });
    // Default filtering: only errors and warnings
    expect(result.serverLogs.length).toBeGreaterThanOrEqual(2); // error + warning
  });

  it("reads cache trace JSONL", () => {
    const traceFile = path.join(tmpDir, "cache-trace.jsonl");
    const events = [
      { ts: new Date().toISOString(), stage: "session:loaded", runId: "r1" },
      { ts: new Date().toISOString(), stage: "prompt:before", runId: "r1" },
    ];
    fs.writeFileSync(traceFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const result = ingestLogs({ logsDir: tmpDir, maxLogLines: 100 });
    expect(result.cacheTraceEvents).toHaveLength(2);
    expect(result.cacheTraceEvents[0].stage).toBe("session:loaded");
  });

  it("reads sentinel history JSONL", () => {
    const historyFile = path.join(tmpDir, "sentinel-history.jsonl");
    const reports = [
      { timestamp: new Date().toISOString(), healthy: true, issueCount: 0 },
      { timestamp: new Date().toISOString(), healthy: false, issueCount: 3 },
    ];
    fs.writeFileSync(historyFile, reports.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const result = ingestLogs({ logsDir: tmpDir, maxLogLines: 100 });
    expect(result.sentinelReports).toHaveLength(2);
  });

  it("includes all lines when includeAll is true", () => {
    const today = new Date().toISOString().split("T")[0];
    const logFile = path.join(tmpDir, `openclaw-${today}.log`);
    const lines = [
      JSON.stringify({ _level: 3, message: "info line 1" }),
      JSON.stringify({ _level: 3, message: "info line 2" }),
      JSON.stringify({ _level: 3, message: "info line 3" }),
    ];
    fs.writeFileSync(logFile, lines.join("\n") + "\n");

    const result = ingestLogs({ logsDir: tmpDir, maxLogLines: 100, includeAll: true });
    expect(result.serverLogs).toHaveLength(3);
  });

  it("respects maxLogLines limit", () => {
    const today = new Date().toISOString().split("T")[0];
    const logFile = path.join(tmpDir, `openclaw-${today}.log`);
    const lines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ _level: 1, message: `error ${i}` }),
    );
    fs.writeFileSync(logFile, lines.join("\n") + "\n");

    const result = ingestLogs({ logsDir: tmpDir, maxLogLines: 10 });
    expect(result.serverLogs.length).toBeLessThanOrEqual(10);
  });

  it("handles non-existent logs directory gracefully", () => {
    const result = ingestLogs({ logsDir: "/nonexistent/path", maxLogLines: 100 });
    expect(result.serverLogs).toHaveLength(0);
    expect(result.totalLines).toBe(0);
  });
});

describe("formatLogContext", () => {
  it("formats a log window into readable context", () => {
    const window = {
      serverLogs: ['{"level":"error","message":"test error"}'],
      cacheTraceEvents: [{ ts: "2026-03-23T10:00:00Z", stage: "session:loaded" }],
      sentinelReports: [{ timestamp: "2026-03-23T10:00:00Z", healthy: false, issueCount: 1, remediationCount: 0, escalated: false }],
      from: new Date("2026-03-23T00:00:00Z"),
      to: new Date("2026-03-23T12:00:00Z"),
      totalLines: 3,
    };

    const context = formatLogContext(window);
    expect(context).toContain("Log Window");
    expect(context).toContain("Server Logs");
    expect(context).toContain("Cache Trace Events");
    expect(context).toContain("Sentinel Reports");
    expect(context).toContain("test error");
  });

  it("omits empty sections", () => {
    const window = {
      serverLogs: [],
      cacheTraceEvents: [],
      sentinelReports: [],
      from: new Date(),
      to: new Date(),
      totalLines: 0,
    };

    const context = formatLogContext(window);
    expect(context).not.toContain("Server Logs");
    expect(context).not.toContain("Cache Trace Events");
  });
});
