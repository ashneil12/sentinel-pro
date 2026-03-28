/**
 * Fix Engine — git worktree isolation for safe patch application.
 *
 * Workflow:
 * 1. Create a git worktree on a fix branch (never touches main)
 * 2. Apply the diff via `git apply` or direct file write
 * 3. Track fix status: pending → approved → applying → applied | failed | rolled_back
 * 4. Rollback = delete the worktree branch
 *
 * Security boundaries:
 * - Read-only to main workspace by default
 * - All writes happen in an isolated worktree
 * - Fixes require explicit approval from the dashboard
 * - Gateway restart is a separate, gated action
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { SuggestedFix } from "./adapters/types.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "fix-engine" });

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type FixStatus =
  | "pending"     // Awaiting user approval
  | "approved"    // User approved, ready to apply
  | "applying"    // Currently being applied
  | "applied"     // Successfully applied
  | "failed"      // Apply failed
  | "rolled_back" // User rolled back
  | "rejected";   // User rejected

export interface FixRecord {
  id: string;
  /** The original suggested fix from analysis */
  fix: SuggestedFix;
  /** Which analysis report generated this fix */
  reportId: string;
  /** Current status */
  status: FixStatus;
  /** Timestamp of creation */
  createdAt: string;
  /** Timestamp of last status change */
  updatedAt: string;
  /** The git branch created for this fix */
  branch?: string;
  /** Error message if status is 'failed' */
  error?: string;
  /** Who approved/rejected (userId from dashboard) */
  actorId?: string;
}

interface FixStoreData {
  fixes: FixRecord[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Fix Store (JSONL persistence)
// ═══════════════════════════════════════════════════════════════════════════

function getStoreFile(dataDir: string): string {
  return join(dataDir, "fixes", "fix-records.json");
}

function ensureDir(dataDir: string): void {
  const dir = join(dataDir, "fixes");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadStore(dataDir: string): FixStoreData {
  const file = getStoreFile(dataDir);
  if (!existsSync(file)) return { fixes: [] };
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return { fixes: [] };
  }
}

function saveStore(dataDir: string, store: FixStoreData): void {
  ensureDir(dataDir);
  writeFileSync(getStoreFile(dataDir), JSON.stringify(store, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register a suggested fix from an analysis report.
 * Creates a pending fix record awaiting user approval.
 */
export function registerFix(
  dataDir: string,
  fix: SuggestedFix,
  reportId: string,
): FixRecord {
  const store = loadStore(dataDir);
  const now = new Date().toISOString();

  const record: FixRecord = {
    id: nanoid(10),
    fix,
    reportId,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  store.fixes.push(record);
  saveStore(dataDir, store);
  log.info({ fixId: record.id, file: fix.filePath }, "fix registered");
  return record;
}

/**
 * Register all fixes from an analysis report at once.
 */
export function registerFixesFromReport(
  dataDir: string,
  reportId: string,
  fixes: SuggestedFix[],
): FixRecord[] {
  return fixes.map((fix) => registerFix(dataDir, fix, reportId));
}

/**
 * List all fix records, optionally filtered by status.
 */
export function listFixes(
  dataDir: string,
  opts?: { status?: FixStatus; limit?: number; offset?: number },
): { fixes: FixRecord[]; total: number } {
  const store = loadStore(dataDir);
  let filtered = store.fixes;

  if (opts?.status) {
    filtered = filtered.filter((f) => f.status === opts.status);
  }

  // Sort newest first
  filtered.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  const total = filtered.length;
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? 50;

  return {
    fixes: filtered.slice(offset, offset + limit),
    total,
  };
}

/**
 * Get a single fix record by ID.
 */
export function getFix(dataDir: string, fixId: string): FixRecord | null {
  const store = loadStore(dataDir);
  return store.fixes.find((f) => f.id === fixId) ?? null;
}

/**
 * Approve a pending fix and apply it in a git worktree.
 */
export async function approveFix(
  dataDir: string,
  workspaceDir: string,
  fixId: string,
  actorId?: string,
): Promise<FixRecord> {
  const store = loadStore(dataDir);
  const record = store.fixes.find((f) => f.id === fixId);

  if (!record) throw new Error(`Fix ${fixId} not found`);
  if (record.status !== "pending") {
    throw new Error(`Fix ${fixId} is ${record.status}, expected pending`);
  }

  record.status = "approved";
  record.actorId = actorId;
  record.updatedAt = new Date().toISOString();
  saveStore(dataDir, store);

  // Apply the fix
  return applyFix(dataDir, workspaceDir, record);
}

/**
 * Reject a pending fix.
 */
export function rejectFix(
  dataDir: string,
  fixId: string,
  actorId?: string,
): FixRecord {
  const store = loadStore(dataDir);
  const record = store.fixes.find((f) => f.id === fixId);

  if (!record) throw new Error(`Fix ${fixId} not found`);
  if (record.status !== "pending") {
    throw new Error(`Fix ${fixId} is ${record.status}, expected pending`);
  }

  record.status = "rejected";
  record.actorId = actorId;
  record.updatedAt = new Date().toISOString();
  saveStore(dataDir, store);
  log.info({ fixId }, "fix rejected");
  return record;
}

/**
 * Roll back an applied fix by deleting the worktree branch.
 */
export async function rollbackFix(
  dataDir: string,
  workspaceDir: string,
  fixId: string,
): Promise<FixRecord> {
  const store = loadStore(dataDir);
  const record = store.fixes.find((f) => f.id === fixId);

  if (!record) throw new Error(`Fix ${fixId} not found`);
  if (record.status !== "applied") {
    throw new Error(`Fix ${fixId} is ${record.status}, expected applied`);
  }

  try {
    if (record.branch) {
      // Remove worktree and branch
      const worktreePath = join(dataDir, "worktrees", record.id);
      try {
        await execAsync("git", ["worktree", "remove", worktreePath, "--force"], {
          cwd: workspaceDir,
          timeout: 10_000,
        });
      } catch {
        // Worktree may already be gone
      }
      try {
        await execAsync("git", ["branch", "-D", record.branch], {
          cwd: workspaceDir,
          timeout: 5_000,
        });
      } catch {
        // Branch may already be gone
      }
    }

    record.status = "rolled_back";
    record.updatedAt = new Date().toISOString();
    saveStore(dataDir, store);
    log.info({ fixId, branch: record.branch }, "fix rolled back");
    return record;
  } catch (err) {
    log.error({ fixId, error: String(err) }, "rollback failed");
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal — Git Worktree Operations
// ═══════════════════════════════════════════════════════════════════════════

async function applyFix(
  dataDir: string,
  workspaceDir: string,
  record: FixRecord,
): Promise<FixRecord> {
  const store = loadStore(dataDir);
  const idx = store.fixes.findIndex((f) => f.id === record.id);
  if (idx === -1) throw new Error("Record disappeared");

  store.fixes[idx].status = "applying";
  store.fixes[idx].updatedAt = new Date().toISOString();
  saveStore(dataDir, store);

  // Sanitize the fix ID for safe use in branch names (alphanumeric + hyphen/underscore only)
  const safeId = record.id.replace(/[^a-zA-Z0-9_-]/g, "");
  const branchName = `sentinel-pro/fix-${safeId}`;
  const worktreePath = join(dataDir, "worktrees", record.id);

  try {
    // Verify workspace is writable before attempting any git operations.
    // If /workspace is mounted :ro this fails immediately with a clear message
    // rather than a cryptic EROFS buried in git worktree output.
    const writeProbe = join(workspaceDir, ".sentinel-write-probe");
    try {
      writeFileSync(writeProbe, "");
      unlinkSync(writeProbe);
    } catch {
      throw new Error(
        "Workspace is mounted read-only — Sentinel Pro cannot apply fixes. " +
        "Remove ':ro' from the workspace volume mount in docker-compose.sentinel-pro.yml and redeploy.",
      );
    }

    // Ensure worktrees directory exists
    const worktreesDir = join(dataDir, "worktrees");
    if (!existsSync(worktreesDir)) mkdirSync(worktreesDir, { recursive: true });

    // Check if workspace is a git repo
    const isGit = existsSync(join(workspaceDir, ".git"));
    if (!isGit) {
      throw new Error("Workspace is not a git repository — cannot create worktree");
    }

    // Create a new worktree on a fix branch
    await execAsync("git", ["worktree", "add", "-b", branchName, worktreePath], {
      cwd: workspaceDir,
      timeout: 15_000,
    });

    // Write the diff to a temp file and apply it
    const diffFile = join(worktreePath, ".sentinel-fix.patch");
    writeFileSync(diffFile, record.fix.diff);

    try {
      await execAsync("git", ["apply", "--check", diffFile], {
        cwd: worktreePath,
        timeout: 10_000,
      });

      await execAsync("git", ["apply", diffFile], {
        cwd: worktreePath,
        timeout: 10_000,
      });
    } catch {
      // If git apply fails, try applying the patch directly to the file
      log.warn({ fixId: record.id }, "git apply failed, attempting direct file patch");
      applyDiffDirectly(worktreePath, record.fix);
    }

    // Commit the fix — sanitize title to prevent shell injection
    const safeTitle = record.fix.title
      .replace(/["'`$\\;|&(){}\n\r]/g, "")
      .slice(0, 100);
      
    await execAsync("git", ["add", "-A"], {
      cwd: worktreePath,
      timeout: 10_000,
    });
    
    await execAsync("git", ["commit", "-m", `sentinel-pro: ${safeTitle}`], {
      cwd: worktreePath,
      timeout: 10_000,
    });

    // Update record
    const reloadedStore = loadStore(dataDir);
    const reloadedIdx = reloadedStore.fixes.findIndex((f) => f.id === record.id);
    if (reloadedIdx !== -1) {
      reloadedStore.fixes[reloadedIdx].status = "applied";
      reloadedStore.fixes[reloadedIdx].branch = branchName;
      reloadedStore.fixes[reloadedIdx].updatedAt = new Date().toISOString();
      saveStore(dataDir, reloadedStore);
    }

    log.info({ fixId: record.id, branch: branchName }, "fix applied");
    return { ...record, status: "applied", branch: branchName };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ fixId: record.id, error: errMsg }, "fix apply failed");

    // Clean up failed worktree
    try {
      await execAsync("git", ["worktree", "remove", worktreePath, "--force"], {
        cwd: workspaceDir,
        timeout: 10_000,
      });
    } catch { /* ignore */ }
    try {
      await execAsync("git", ["branch", "-D", branchName], {
        cwd: workspaceDir,
        timeout: 5_000,
      });
    } catch { /* ignore */ }

    const reloadedStore = loadStore(dataDir);
    const reloadedIdx = reloadedStore.fixes.findIndex((f) => f.id === record.id);
    if (reloadedIdx !== -1) {
      reloadedStore.fixes[reloadedIdx].status = "failed";
      reloadedStore.fixes[reloadedIdx].error = errMsg;
      reloadedStore.fixes[reloadedIdx].updatedAt = new Date().toISOString();
      saveStore(dataDir, reloadedStore);
    }

    return { ...record, status: "failed", error: errMsg };
  }
}

/**
 * Fallback: apply diff by directly writing the new content to the file.
 * Used when `git apply` fails (e.g., fuzzy matching needed).
 */
function applyDiffDirectly(worktreePath: string, fix: SuggestedFix): void {
  const filePath = join(worktreePath, fix.filePath);
  if (!existsSync(filePath)) {
    throw new Error(`Target file not found: ${fix.filePath}`);
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const diffLines = fix.diff.split("\n");

  // Extract removed and added lines from the diff
  const removedLines: string[] = [];
  const addedLines: string[] = [];

  for (const dl of diffLines) {
    if (dl.startsWith("-") && !dl.startsWith("---")) {
      removedLines.push(dl.slice(1));
    } else if (dl.startsWith("+") && !dl.startsWith("+++")) {
      addedLines.push(dl.slice(1));
    }
  }

  // Try to find the removed lines in the file and replace them
  if (removedLines.length === 0) {
    throw new Error("Cannot apply diff: no removed lines to match");
  }

  const firstRemoved = removedLines[0].trim();
  let matchIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === firstRemoved) {
      // Verify subsequent lines match
      let allMatch = true;
      for (let j = 1; j < removedLines.length; j++) {
        if (i + j >= lines.length || lines[i + j].trim() !== removedLines[j].trim()) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        matchIndex = i;
        break;
      }
    }
  }

  if (matchIndex === -1) {
    throw new Error("Cannot apply diff: could not find matching lines in file");
  }

  // Replace the matched section
  lines.splice(matchIndex, removedLines.length, ...addedLines);
  writeFileSync(filePath, lines.join("\n"));
}

/**
 * Attempt to restart the gateway container.
 * This is a privileged operation — requires docker socket access.
 */
export async function restartGateway(gatewayUrl: string): Promise<{
  success: boolean;
  error?: string;
}> {
  // Validate the gateway URL to prevent command injection
  let validatedUrl: string;
  try {
    const parsed = new URL(gatewayUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { success: false, error: 'Invalid gateway URL protocol' };
    }
    validatedUrl = parsed.toString();
  } catch {
    return { success: false, error: 'Invalid gateway URL' };
  }

  try {
    // Try docker restart first (no user input in command)
    await execAsync("docker", ["restart", "openclaw-gateway"], {
      timeout: 30_000,
    });
    log.info("gateway restarted via docker");
    return { success: true };
  } catch {
    // Fallback: use fetch API instead of exec'd curl to avoid injection
    try {
      const resp = await fetch(`${validatedUrl}/admin/restart`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
         throw new Error(`HTTP error! status: ${resp.status}`);
      }
      log.info("gateway restarted via API");
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ error: msg }, "gateway restart failed");
      return { success: false, error: msg };
    }
  }
}
