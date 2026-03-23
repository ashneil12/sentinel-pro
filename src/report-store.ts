/**
 * Report Store — persists analysis results as JSONL with metadata.
 */

import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { AnalysisResult } from "./adapters/types.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "report-store" });

const REPORTS_FILE = "reports.jsonl";
const MAX_REPORTS = 500;

export interface StoredReport {
  id: string;
  timestamp: string;
  trigger: string;
  result: AnalysisResult;
}

export function storeReport(
  result: AnalysisResult,
  trigger: string,
  dataDir: string,
): StoredReport {
  const report: StoredReport = {
    id: nanoid(12),
    timestamp: new Date().toISOString(),
    trigger,
    result,
  };

  const reportsDir = path.join(dataDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });

  const filePath = path.join(reportsDir, REPORTS_FILE);

  try {
    fs.appendFileSync(filePath, JSON.stringify(report) + "\n", "utf8");
  } catch (err) {
    log.error({ error: String(err) }, "failed to write report");
  }

  return report;
}

export function listReports(
  dataDir: string,
  opts?: { limit?: number; offset?: number },
): StoredReport[] {
  const filePath = path.join(dataDir, "reports", REPORTS_FILE);
  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());

    const reports: StoredReport[] = [];
    for (const line of lines) {
      try {
        reports.push(JSON.parse(line) as StoredReport);
      } catch {
        // skip malformed lines
      }
    }

    // Sort newest first
    reports.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 20;
    return reports.slice(offset, offset + limit);
  } catch {
    return [];
  }
}

export function getReport(dataDir: string, id: string): StoredReport | null {
  const reports = listReports(dataDir, { limit: MAX_REPORTS });
  return reports.find((r) => r.id === id) ?? null;
}
