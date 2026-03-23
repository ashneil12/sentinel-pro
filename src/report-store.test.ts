/**
 * Tests for config loading and report store.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { storeReport, listReports, getReport } from "../src/report-store.js";
import type { AnalysisResult } from "../src/adapters/types.js";

describe("report-store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-pro-reports-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const mockResult: AnalysisResult = {
    success: true,
    output: "Everything looks healthy.",
    findings: [],
    fixes: [],
    severity: "healthy",
    durationMs: 1234,
  };

  it("stores and retrieves a report", () => {
    const report = storeReport(mockResult, "test", tmpDir);
    expect(report.id).toBeDefined();
    expect(report.timestamp).toBeDefined();
    expect(report.trigger).toBe("test");
    expect(report.result.success).toBe(true);

    const retrieved = getReport(tmpDir, report.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(report.id);
  });

  it("lists reports in reverse chronological order", async () => {
    // Create reports with small delays to ensure distinct timestamps
    storeReport(mockResult, "first", tmpDir);
    await new Promise((r) => setTimeout(r, 20));
    storeReport({ ...mockResult, severity: "warning" }, "second", tmpDir);
    await new Promise((r) => setTimeout(r, 20));
    storeReport({ ...mockResult, severity: "critical" }, "third", tmpDir);

    const reports = listReports(tmpDir);
    expect(reports).toHaveLength(3);
    // Newest first
    expect(reports[0].trigger).toBe("third");
    expect(reports[2].trigger).toBe("first");
  });

  it("respects limit and offset", () => {
    for (let i = 0; i < 10; i++) {
      storeReport(mockResult, `run-${i}`, tmpDir);
    }

    const page1 = listReports(tmpDir, { limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);

    const page2 = listReports(tmpDir, { limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);

    // No overlap
    const ids1 = new Set(page1.map((r) => r.id));
    for (const r of page2) {
      expect(ids1.has(r.id)).toBe(false);
    }
  });

  it("returns empty array for non-existent data dir", () => {
    const reports = listReports("/nonexistent/path");
    expect(reports).toHaveLength(0);
  });

  it("returns null for non-existent report ID", () => {
    const report = getReport(tmpDir, "nonexistent-id");
    expect(report).toBeNull();
  });

  it("stores reports with findings and fixes", () => {
    const resultWithFindings: AnalysisResult = {
      success: true,
      output: "Found issues",
      findings: [
        { id: "f1", severity: "critical", title: "Memory leak", description: "Heap growing" },
      ],
      fixes: [
        { id: "x1", title: "Fix leak", description: "Cleanup", filePath: "test.ts", diff: "-old\n+new", confidence: "high" },
      ],
      severity: "critical",
      durationMs: 5000,
    };

    const report = storeReport(resultWithFindings, "manual", tmpDir);
    const retrieved = getReport(tmpDir, report.id);
    expect(retrieved!.result.findings).toHaveLength(1);
    expect(retrieved!.result.findings[0].title).toBe("Memory leak");
    expect(retrieved!.result.fixes).toHaveLength(1);
    expect(retrieved!.result.fixes[0].confidence).toBe("high");
  });
});
