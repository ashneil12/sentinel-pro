/**
 * Cron — unit tests.
 *
 * Checks that the Autopilot behavior invokes the right functions
 * sequentially, properly handling the promises.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAnalysisCycle } from "./cron.js";
import type { CliAdapter } from "./adapters/types.js";
import type { SentinelProConfig } from "./config.js";

// Mock dependencies
import * as fixEngine from "./fix-engine.js";
vi.mock("./fix-engine.js", () => ({
  registerFixesFromReport: vi.fn(),
  approveFix: vi.fn(),
  restartGateway: vi.fn(),
}));

import * as reportStore from "./report-store.js";
vi.mock("./report-store.js", () => ({
  storeReport: vi.fn(),
}));

import * as logIngester from "./log-ingester.js";
vi.mock("./log-ingester.js", () => ({
  ingestLogs: vi.fn(),
  formatLogContext: vi.fn(),
}));

// Setup fake config and adapter
const mockConfig: SentinelProConfig = {
  port: 8888,
  dataDir: "/tmp/data",
  workspaceDir: "/tmp/workspace",
  gatewayUrl: "http://gateway.local",
  logsDir: "/tmp/logs",
  maxLogLines: 1000,
  cronSchedule: "* * * * *",
  timezone: "UTC",
  authToken: "secret",
  autopilotMode: true,
};

const mockAdapter: CliAdapter = {
  provider: "claude-code",
  getIdentity: vi.fn().mockResolvedValue({ id: "agent" }),
  analyze: vi.fn(),
  startSession: vi.fn(),
};

describe("cron analysis cycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exits early if no logs found", async () => {
    vi.mocked(logIngester.ingestLogs).mockReturnValue({
      totalLines: 0,
      lines: [],
      from: new Date(),
      to: new Date(),
    });

    vi.mocked(reportStore.storeReport).mockReturnValue({
      id: "report-123",
      timestamp: new Date().toISOString(),
      trigger: "manual",
      success: true,
      output: "None",
      result: {
        success: true,
        output: "None",
        findings: [],
        fixes: [],
        severity: "healthy",
        durationMs: 10,
      },
    });

    const report = await runAnalysisCycle(mockAdapter, mockConfig, { trigger: "manual" });
    expect(report.id).toBe("report-123");
    expect(mockAdapter.analyze).not.toHaveBeenCalled();
  });

  it("applies fixes and restarts gateway in autopilot mode", async () => {
    vi.mocked(logIngester.ingestLogs).mockReturnValue({
      totalLines: 10,
      lines: ["error"],
      from: new Date(),
      to: new Date(),
    });

    vi.mocked(mockAdapter.analyze).mockResolvedValue({
      success: true,
      output: "Analysis complete",
      findings: [],
      fixes: [{
        id: "fix-123",
        title: "Fix issue",
        description: "Fixing",
        filePath: "app.ts",
        diff: "...",
        confidence: "high"
      }],
      severity: "warning",
      durationMs: 100,
    });

    vi.mocked(reportStore.storeReport).mockReturnValue({
      id: "report-1",
      timestamp: new Date().toISOString(),
      trigger: "cron",
      success: true,
      output: "...",
      result: {
        success: true,
        output: "...",
        findings: [],
        fixes: [], // structure doesn't matter here
        severity: "warning",
        durationMs: 100,
      },
    });

    // Mock registered fixes
    vi.mocked(fixEngine.registerFixesFromReport).mockReturnValue([{
      id: "fix-1",
      reportId: "report-1",
      fix: {} as any,
      status: "pending",
      createdAt: "",
      updatedAt: ""
    }]);

    await runAnalysisCycle(mockAdapter, { ...mockConfig, autopilotMode: true }, { trigger: "cron" });

    // Ensure it was approved and restarted
    expect(fixEngine.approveFix).toHaveBeenCalledWith(
      mockConfig.dataDir, mockConfig.workspaceDir, "fix-1", "autopilot"
    );
    expect(fixEngine.restartGateway).toHaveBeenCalledWith(mockConfig.gatewayUrl);
  });
});
