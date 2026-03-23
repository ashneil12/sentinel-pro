/**
 * Output parser — extracts structured findings and fixes from CLI output.
 *
 * Both Claude Code and Codex produce freeform text. This module applies
 * heuristic parsing to extract actionable findings and fix suggestions.
 */

import { nanoid } from "nanoid";
import type { Finding, SuggestedFix } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Finding Extraction
// ═══════════════════════════════════════════════════════════════════════════

const SEVERITY_KEYWORDS: Record<string, Finding["severity"]> = {
  critical: "critical",
  error: "critical",
  fatal: "critical",
  crash: "critical",
  "data loss": "critical",
  warning: "warning",
  warn: "warning",
  degraded: "warning",
  slow: "warning",
  timeout: "warning",
  info: "info",
  notice: "info",
  suggestion: "info",
  minor: "info",
};

/**
 * Parse findings from freeform CLI output.
 *
 * Looks for structured patterns like:
 * - "## Finding: ..." or "### Issue: ..."
 * - Numbered lists with severity indicators
 * - Lines containing ERROR, WARNING, CRITICAL keywords
 */
export function parseFindings(output: string): Finding[] {
  const findings: Finding[] = [];
  const lines = output.split("\n");

  // Pattern 1: Markdown headings with "Finding", "Issue", "Problem", "Error"
  const headingPattern = /^#{1,4}\s+(?:Finding|Issue|Problem|Error|Warning|Bug):\s*(.+)/i;

  // Pattern 2: Numbered items with severity
  const numberedPattern = /^\s*\d+\.\s+\*?\*?(?:\[?(CRITICAL|ERROR|WARNING|INFO)\]?\s*:?\s*\*?\*?)\s*(.+)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Try heading pattern
    const headingMatch = line.match(headingPattern);
    if (headingMatch) {
      const title = headingMatch[1].trim();
      const description = collectDescription(lines, i + 1);
      const severity = inferSeverity(title + " " + description);
      findings.push({
        id: nanoid(8),
        severity,
        title,
        description,
        source: extractSource(description),
        action: extractAction(description),
      });
      continue;
    }

    // Try numbered pattern
    const numberedMatch = line.match(numberedPattern);
    if (numberedMatch) {
      const severityStr = numberedMatch[1].toLowerCase();
      const title = numberedMatch[2].trim();
      const description = collectDescription(lines, i + 1);
      findings.push({
        id: nanoid(8),
        severity: SEVERITY_KEYWORDS[severityStr] ?? "info",
        title,
        description,
        source: extractSource(title + " " + description),
        action: extractAction(description),
      });
    }
  }

  return findings;
}

function collectDescription(lines: string[], startIndex: number): string {
  const parts: string[] = [];
  for (let i = startIndex; i < Math.min(startIndex + 5, lines.length); i++) {
    const line = lines[i].trim();
    // Stop at next heading, numbered item, or empty line after content
    if (line.startsWith("#") || /^\d+\.\s/.test(line)) break;
    if (line === "" && parts.length > 0) break;
    if (line) parts.push(line);
  }
  return parts.join(" ");
}

function inferSeverity(text: string): Finding["severity"] {
  const lower = text.toLowerCase();
  for (const [keyword, severity] of Object.entries(SEVERITY_KEYWORDS)) {
    if (lower.includes(keyword)) return severity;
  }
  return "info";
}

function extractSource(text: string): string | undefined {
  // Look for file paths or log references
  const fileMatch = text.match(/(?:in |at |file |path )([/\w.-]+\.\w{1,4}(?::\d+)?)/i);
  if (fileMatch) return fileMatch[1];

  // Look for line references like "line 42" or "L42"
  const lineMatch = text.match(/(?:line |L)(\d+)/i);
  if (lineMatch) return `line ${lineMatch[1]}`;

  return undefined;
}

function extractAction(text: string): string | undefined {
  // Look for "fix:", "action:", "suggested:", "recommend:" patterns
  const actionMatch = text.match(/(?:fix|action|suggest(?:ed)?|recommend(?:ation)?|resolution):\s*(.+)/i);
  return actionMatch ? actionMatch[1].trim() : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Fix Extraction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse suggested fixes from CLI output.
 *
 * Looks for diff blocks (```diff ... ```) and associates them with
 * file paths mentioned nearby.
 */
export function parseFixes(output: string): SuggestedFix[] {
  const fixes: SuggestedFix[] = [];
  const diffBlockPattern = /```diff\n([\s\S]*?)```/g;

  let match: RegExpExecArray | null;
  while ((match = diffBlockPattern.exec(output)) !== null) {
    const diff = match[1].trim();
    const startIdx = match.index;

    // Look backwards from the diff block for a file path and title
    const before = output.slice(Math.max(0, startIdx - 300), startIdx);
    const filePath = extractFilePath(before, diff);
    const title = extractFixTitle(before);

    fixes.push({
      id: nanoid(8),
      title: title || "Suggested fix",
      description: extractFixDescription(before),
      filePath: filePath || "unknown",
      diff,
      confidence: inferConfidence(before + diff),
    });
  }

  return fixes;
}

function extractFilePath(context: string, diff: string): string | undefined {
  // Check diff header lines first (--- a/foo.ts, +++ b/foo.ts)
  const diffHeader = diff.match(/^(?:---|\+\+\+)\s+[ab]\/(.+)/m);
  if (diffHeader) return diffHeader[1];

  // Look in surrounding context for file paths
  const pathMatch = context.match(/(?:file|path|in)\s+[`"]?([/\w.-]+\.\w{1,4})[`"]?/i);
  return pathMatch ? pathMatch[1] : undefined;
}

function extractFixTitle(context: string): string {
  const lines = context.split("\n").reverse();
  for (const line of lines) {
    const heading = line.match(/^#{1,4}\s+(.+)/);
    if (heading) return heading[1].trim();
    const bold = line.match(/\*\*(.+?)\*\*/);
    if (bold) return bold[1].trim();
  }
  return "Suggested fix";
}

function extractFixDescription(context: string): string {
  const lines = context.split("\n").filter((l) => l.trim()).slice(-3);
  return lines.join(" ").trim().slice(0, 200);
}

function inferConfidence(text: string): SuggestedFix["confidence"] {
  const lower = text.toLowerCase();
  if (lower.includes("confident") || lower.includes("straightforward") || lower.includes("simple fix")) {
    return "high";
  }
  if (lower.includes("might") || lower.includes("could") || lower.includes("possibly")) {
    return "low";
  }
  return "medium";
}

// ═══════════════════════════════════════════════════════════════════════════
// Severity Classification
// ═══════════════════════════════════════════════════════════════════════════

export function classifySeverity(
  findings: Finding[],
): "critical" | "warning" | "info" | "healthy" {
  if (findings.length === 0) return "healthy";
  if (findings.some((f) => f.severity === "critical")) return "critical";
  if (findings.some((f) => f.severity === "warning")) return "warning";
  return "info";
}
