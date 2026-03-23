/**
 * Claude Code CLI adapter.
 *
 * Wraps the `claude` CLI binary for one-shot analysis and interactive
 * sessions. Auth is handled by the CLI itself (`claude login`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { nanoid } from "nanoid";
import type {
  CliAdapter,
  CliIdentity,
  AnalysisRequest,
  AnalysisResult,
  Finding,
  SuggestedFix,
  InteractiveSession,
} from "./types.js";
import { parseFindings, parseFixes, classifySeverity } from "./parse-output.js";
import { logger } from "../logger.js";

const CLI_BINARY = "claude";
const log = logger.child({ adapter: "claude-code" });

async function execCli(
  args: string[],
  opts?: { timeout?: number; stdin?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLI_BINARY, args, {
      timeout: opts?.timeout ?? 300_000, // 5 min default
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (opts?.stdin) {
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    }

    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ${CLI_BINARY}: ${err.message}`));
    });
  });
}

export class ClaudeCodeAdapter implements CliAdapter {
  readonly provider = "claude-code" as const;

  async isInstalled(): Promise<boolean> {
    try {
      const result = await execCli(["--version"], { timeout: 10_000 });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      // `claude --print-system-prompt` or a lightweight check
      const result = await execCli(["--help"], { timeout: 10_000 });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async getIdentity(): Promise<CliIdentity> {
    const installed = await this.isInstalled();
    if (!installed) {
      return { provider: "claude-code", authenticated: false };
    }
    const authenticated = await this.isAuthenticated();
    return {
      provider: "claude-code",
      authenticated,
      // Claude Code doesn't easily expose user/plan info via CLI
    };
  }

  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    const startMs = Date.now();
    log.info({ task: request.task.slice(0, 80) }, "starting analysis");

    try {
      const args = [
        "--print",         // non-interactive, print output
        "--model", "opus", // default to best model
      ];

      if (request.workdir) {
        args.push("--cwd", request.workdir);
      }

      if (request.systemPrompt) {
        args.push("--system-prompt", request.systemPrompt);
      }

      if (request.maxTokens) {
        args.push("--max-tokens", String(request.maxTokens));
      }

      // The task + context combined as the prompt
      const prompt = [
        request.task,
        "",
        "## Context",
        request.context,
      ].join("\n");

      args.push("--prompt", prompt);

      const result = await execCli(args, { timeout: 600_000 }); // 10 min for analysis
      const durationMs = Date.now() - startMs;

      if (result.exitCode !== 0) {
        log.warn({ exitCode: result.exitCode, stderr: result.stderr.slice(0, 200) }, "analysis failed");
        return {
          success: false,
          output: result.stderr || "Analysis failed",
          findings: [],
          fixes: [],
          severity: "info",
          durationMs,
          error: result.stderr.slice(0, 500),
        };
      }

      const output = result.stdout;
      const findings = parseFindings(output);
      const fixes = parseFixes(output);
      const severity = classifySeverity(findings);

      log.info(
        { findings: findings.length, fixes: fixes.length, severity, durationMs },
        "analysis complete",
      );

      return {
        success: true,
        output,
        findings,
        fixes,
        severity,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const error = err instanceof Error ? err.message : String(err);
      log.error({ error, durationMs }, "analysis threw");
      return {
        success: false,
        output: "",
        findings: [],
        fixes: [],
        severity: "info",
        durationMs,
        error,
      };
    }
  }

  async startSession(opts: {
    systemPrompt: string;
    workdir?: string;
  }): Promise<InteractiveSession> {
    const sessionId = nanoid();

    const args = ["--model", "opus"];
    if (opts.workdir) {
      args.push("--cwd", opts.workdir);
    }
    if (opts.systemPrompt) {
      args.push("--system-prompt", opts.systemPrompt);
    }

    const proc = spawn(CLI_BINARY, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.workdir,
    });

    let alive = true;
    proc.on("close", () => {
      alive = false;
    });
    proc.on("error", () => {
      alive = false;
    });

    log.info({ sessionId }, "interactive session started");

    return {
      id: sessionId,

      async *send(message: string): AsyncIterable<string> {
        if (!alive) {
          throw new Error("Session is no longer alive");
        }

        proc.stdin.write(message + "\n");

        // Stream stdout chunks until we detect a prompt marker or timeout
        const chunks: string[] = [];
        const reader = proc.stdout[Symbol.asyncIterator]();

        const timeoutMs = 120_000; // 2 min per response
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
          const readPromise = reader.next();
          const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), Math.max(deadline - Date.now(), 100)),
          );

          const result = await Promise.race([readPromise, timeoutPromise]);
          if (result.done) break;

          const text = result.value?.toString() ?? "";
          chunks.push(text);
          yield text;

          // If the output contains a prompt marker, we're done
          if (text.includes("❯") || text.includes("> ")) break;
        }
      },

      isAlive(): boolean {
        return alive;
      },

      async destroy(): Promise<void> {
        if (alive) {
          proc.kill("SIGTERM");
          alive = false;
          log.info({ sessionId }, "interactive session destroyed");
        }
      },
    };
  }
}
