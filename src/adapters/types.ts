/**
 * CLI Adapter — unified interface for Claude Code and Codex CLI backends.
 *
 * The adapter pattern lets Sentinel Pro work with whichever CLI the user
 * has authenticated, providing a consistent API for analysis, chat, and
 * fix operations.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type CliProvider = "claude-code" | "codex";

export interface CliIdentity {
  provider: CliProvider;
  user?: string;
  plan?: string;
  authenticated: boolean;
}

export interface AnalysisRequest {
  /** System prompt tuned for the analysis task */
  systemPrompt: string;
  /** Log snippets, error context, sentinel reports */
  context: string;
  /** What to investigate/do */
  task: string;
  /** Working directory for source-aware analysis */
  workdir?: string;
  /** Max tokens for the response */
  maxTokens?: number;
}

export interface AnalysisResult {
  /** Whether the analysis completed successfully */
  success: boolean;
  /** The AI's analysis output */
  output: string;
  /** Structured findings extracted from the output */
  findings: Finding[];
  /** Suggested fixes (if any) */
  fixes: SuggestedFix[];
  /** Severity of the most critical finding */
  severity: "critical" | "warning" | "info" | "healthy";
  /** Token usage for cost tracking */
  usage?: TokenUsage;
  /** Duration of the analysis in ms */
  durationMs: number;
  /** Error message if the analysis failed */
  error?: string;
}

export interface Finding {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  /** Source file/log line where the issue was found */
  source?: string;
  /** Suggested action */
  action?: string;
}

export interface SuggestedFix {
  id: string;
  title: string;
  description: string;
  /** File to modify */
  filePath: string;
  /** Unified diff of the proposed change */
  diff: string;
  /** Confidence level */
  confidence: "high" | "medium" | "low";
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Interactive Session
// ═══════════════════════════════════════════════════════════════════════════

export interface InteractiveSession {
  /** Unique session ID */
  id: string;
  /** Send a message and get a streamed response */
  send(message: string): AsyncIterable<string>;
  /** Whether the session is still active */
  isAlive(): boolean;
  /** Terminate the session */
  destroy(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI Adapter Interface
// ═══════════════════════════════════════════════════════════════════════════

export interface CliAdapter {
  /** Which CLI backend this adapter uses */
  readonly provider: CliProvider;

  /** Check if the CLI binary exists on the system */
  isInstalled(): Promise<boolean>;

  /** Check if the CLI is authenticated and ready to use */
  isAuthenticated(): Promise<boolean>;

  /** Get identity info (provider, user, plan) */
  getIdentity(): Promise<CliIdentity>;

  /** Run a one-shot analysis task */
  analyze(request: AnalysisRequest): Promise<AnalysisResult>;

  /** Start an interactive session for dashboard chat */
  startSession(opts: {
    systemPrompt: string;
    workdir?: string;
  }): Promise<InteractiveSession>;
}
