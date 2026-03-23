/**
 * Fix Engine — unit tests.
 *
 * Tests the fix record store (register, list, get, reject)
 * without git worktree operations (those need a real git repo).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerFix,
  registerFixesFromReport,
  listFixes,
  getFix,
  rejectFix,
  approveFix,
  restartGateway,
} from "./fix-engine.js";
import type { SuggestedFix } from "./adapters/types.js";

function makeFix(overrides: Partial<SuggestedFix> = {}): SuggestedFix {
  return {
    id: "test-fix-1",
    title: "Fix memory leak",
    description: "Close event listeners on disconnect",
    filePath: "src/server.ts",
    diff: `--- a/src/server.ts\n+++ b/src/server.ts\n@@ -10,3 +10,4 @@\n socket.on("close", () => {\n+  listeners.clear();\n });\n`,
    confidence: "high",
    ...overrides,
  };
}

describe("fix-engine store", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sentinel-fix-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("registers a fix record with pending status", () => {
    const fix = makeFix();
    const record = registerFix(tempDir, fix, "report-1");

    expect(record.id).toBeTruthy();
    expect(record.status).toBe("pending");
    expect(record.reportId).toBe("report-1");
    expect(record.fix.title).toBe("Fix memory leak");
    expect(record.createdAt).toBeTruthy();
  });

  it("lists fixes in newest-first order", async () => {
    registerFix(tempDir, makeFix({ id: "fix-a", title: "First" }), "r1");
    await new Promise((r) => setTimeout(r, 10));
    registerFix(tempDir, makeFix({ id: "fix-b", title: "Second" }), "r2");

    const { fixes, total } = listFixes(tempDir);
    expect(total).toBe(2);
    expect(fixes[0].fix.title).toBe("Second");
    expect(fixes[1].fix.title).toBe("First");
  });

  it("filters by status", () => {
    const r1 = registerFix(tempDir, makeFix({ id: "fix-a" }), "r1");
    registerFix(tempDir, makeFix({ id: "fix-b" }), "r2");

    rejectFix(tempDir, r1.id);

    const pending = listFixes(tempDir, { status: "pending" });
    expect(pending.total).toBe(1);

    const rejected = listFixes(tempDir, { status: "rejected" });
    expect(rejected.total).toBe(1);
    expect(rejected.fixes[0].status).toBe("rejected");
  });

  it("gets a fix by ID", () => {
    const record = registerFix(tempDir, makeFix(), "r1");
    const found = getFix(tempDir, record.id);

    expect(found).not.toBeNull();
    expect(found!.id).toBe(record.id);
  });

  it("returns null for unknown fix ID", () => {
    expect(getFix(tempDir, "nonexistent")).toBeNull();
  });

  it("rejects a pending fix", () => {
    const record = registerFix(tempDir, makeFix(), "r1");
    const rejected = rejectFix(tempDir, record.id, "user-123");

    expect(rejected.status).toBe("rejected");
    expect(rejected.actorId).toBe("user-123");
  });

  it("throws when rejecting non-pending fix", () => {
    const record = registerFix(tempDir, makeFix(), "r1");
    rejectFix(tempDir, record.id);

    expect(() => rejectFix(tempDir, record.id)).toThrow("rejected");
  });

  it("registers multiple fixes from a report", () => {
    const fixes = [
      makeFix({ id: "f1", title: "Fix 1" }),
      makeFix({ id: "f2", title: "Fix 2" }),
      makeFix({ id: "f3", title: "Fix 3" }),
    ];

    const records = registerFixesFromReport(tempDir, "report-99", fixes);
    expect(records).toHaveLength(3);

    const { total } = listFixes(tempDir);
    expect(total).toBe(3);
  });

  it("supports pagination", () => {
    for (let i = 0; i < 5; i++) {
      registerFix(tempDir, makeFix({ id: `f${i}` }), "r1");
    }

    const page1 = listFixes(tempDir, { limit: 2, offset: 0 });
    expect(page1.fixes).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = listFixes(tempDir, { limit: 2, offset: 2 });
    expect(page2.fixes).toHaveLength(2);

    const page3 = listFixes(tempDir, { limit: 2, offset: 4 });
    expect(page3.fixes).toHaveLength(1);
  });

  it("throws on unknown fix ID for reject", () => {
    expect(() => rejectFix(tempDir, "nonexistent")).toThrow("not found");
  });

  it("persists data across load/save cycles", () => {
    registerFix(tempDir, makeFix({ id: "f1" }), "r1");
    registerFix(tempDir, makeFix({ id: "f2" }), "r2");

    // Reading from a "fresh" load should find both
    const { total } = listFixes(tempDir);
    expect(total).toBe(2);

    // Rejecting updates the persisted file
    const r = registerFix(tempDir, makeFix({ id: "f3" }), "r3");
    rejectFix(tempDir, r.id, "actor-1");

    const found = getFix(tempDir, r.id);
    expect(found?.status).toBe("rejected");
    expect(found?.actorId).toBe("actor-1");
  });

  it("handles empty data directory gracefully", () => {
    const { fixes, total } = listFixes(tempDir);
    expect(fixes).toEqual([]);
    expect(total).toBe(0);
    expect(getFix(tempDir, "anything")).toBeNull();
  });
});

describe("restartGateway", () => {
  it("rejects invalid gateway URL (command injection prevention)", () => {
    const result = restartGateway("not-a-valid-url");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid");
  });

  it("rejects non-http protocol URLs", () => {
    const result = restartGateway("ftp://evil.com");
    expect(result.success).toBe(false);
    expect(result.error).toContain("protocol");
  });
});

describe("approveFix — workspace writability guard", () => {
  let dataDir: string;
  let readOnlyWorkspace: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "sentinel-fix-data-"));
    readOnlyWorkspace = mkdtempSync(join(tmpdir(), "sentinel-workspace-"));
    // Make the workspace directory itself read-only so writeFileSync will fail
    chmodSync(readOnlyWorkspace, 0o444);
  });

  afterEach(() => {
    // Restore write permissions before cleanup so rmSync can delete it
    try { chmodSync(readOnlyWorkspace, 0o755); } catch { /* ignore */ }
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(readOnlyWorkspace, { recursive: true, force: true });
  });

  it("throws an actionable error message when workspace is read-only", async () => {
    const fix = {
      id: "test",
      title: "Test fix",
      description: "Test",
      filePath: "src/foo.ts",
      diff: "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n",
      confidence: "high" as const,
    };
    const record = registerFix(dataDir, fix, "report-1");

    // approveFix never rejects — it resolves with status:'failed' and an
    // actionable error message so the dashboard can surface it to the user.
    const result = await approveFix(dataDir, readOnlyWorkspace, record.id);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("read-only");
    expect(result.error).toContain("docker-compose.sentinel-pro.yml");

    // Verify the persisted record also reflects the failure
    const persisted = getFix(dataDir, record.id);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.error).toContain("read-only");
  });
});
