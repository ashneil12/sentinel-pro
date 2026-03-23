/**
 * CLI adapter barrel + factory.
 */

export * from "./types.js";
export { ClaudeCodeAdapter } from "./claude-code.js";
export { CodexCliAdapter } from "./codex.js";
export { parseFindings, parseFixes, classifySeverity } from "./parse-output.js";

import type { CliAdapter, CliProvider } from "./types.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexCliAdapter } from "./codex.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "adapter-factory" });

/**
 * Auto-detect which CLI is available and return the appropriate adapter.
 * Prefers Claude Code if both are installed.
 */
export async function createAdapter(preferred?: CliProvider): Promise<CliAdapter | null> {
  if (preferred === "codex") {
    const codex = new CodexCliAdapter();
    if (await codex.isInstalled()) {
      log.info("using Codex CLI adapter (user preference)");
      return codex;
    }
    log.warn("codex CLI not found, falling back to auto-detect");
  }

  if (preferred === "claude-code") {
    const cc = new ClaudeCodeAdapter();
    if (await cc.isInstalled()) {
      log.info("using Claude Code adapter (user preference)");
      return cc;
    }
    log.warn("claude CLI not found, falling back to auto-detect");
  }

  // Auto-detect: try Claude Code first, then Codex
  const cc = new ClaudeCodeAdapter();
  if (await cc.isInstalled()) {
    log.info("auto-detected Claude Code CLI");
    return cc;
  }

  const codex = new CodexCliAdapter();
  if (await codex.isInstalled()) {
    log.info("auto-detected Codex CLI");
    return codex;
  }

  log.error("no CLI adapter available — neither claude nor codex found");
  return null;
}
