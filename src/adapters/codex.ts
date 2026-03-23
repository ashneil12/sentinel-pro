/**
 * Codex CLI adapter.
 *
 * Wraps the `codex` CLI binary for one-shot analysis and interactive sessions.
 * Auth is handled via OpenAI OAuth or OPENAI_API_KEY env var.
 */

import { spawn } from "node:child_process";
import { nanoid } from "nanoid";
import type {
  CliAdapter,
  CliIdentity,
  AnalysisRequest,
  AnalysisResult,
  InteractiveSession,
} from "./types.js";
import { parseFindings, parseFixes, classifySeverity } from "./parse-output.js";
import { logger } from "../logger.js";

const CLI_BINARY = "codex";
const log = logger.child({ adapter: "codex" });

async function execCli(
  args: string[],
  opts?: { timeout?: number; stdin?: string },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLI_BINARY, args, {
      timeout: opts?.timeout ?? 300_000,
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

export class CodexCliAdapter implements CliAdapter {
  readonly provider = "codex" as const;

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
      // Codex uses OPENAI_API_KEY or OAuth session
      if (process.env.OPENAI_API_KEY) return true;
      const result = await execCli(["--help"], { timeout: 10_000 });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async getIdentity(): Promise<CliIdentity> {
    const installed = await this.isInstalled();
    if (!installed) {
      return { provider: "codex", authenticated: false };
    }
    const authenticated = await this.isAuthenticated();
    return {
      provider: "codex",
      authenticated,
    };
  }

  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    const startMs = Date.now();
    log.info({ task: request.task.slice(0, 80) }, "starting analysis");

    try {
      const args = [
        "--quiet",                   // non-interactive
        "--approval-mode", "never",  // full auto
      ];

      if (request.workdir) {
        args.push("--cwd", request.workdir);
      }

      // Codex takes the prompt as positional arg
      const prompt = [
        request.systemPrompt,
        "",
        request.task,
        "",
        "## Context",
        request.context,
      ].join("\n");

      args.push(prompt);

      const result = await execCli(args, { timeout: 600_000 });
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

    const args: string[] = [];
    if (opts.workdir) {
      args.push("--cwd", opts.workdir);
    }

    const proc = spawn(CLI_BINARY, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.workdir,
    });

    let alive = true;
    proc.on("close", () => { alive = false; });
    proc.on("error", () => { alive = false; });

    log.info({ sessionId }, "interactive session started");

    return {
      id: sessionId,

      async *send(message: string): AsyncIterable<string> {
        if (!alive) throw new Error("Session is no longer alive");

        proc.stdin.write(message + "\n");

        const timeoutMs = 120_000;
        const deadline = Date.now() + timeoutMs;
        const reader = proc.stdout[Symbol.asyncIterator]();

        while (Date.now() < deadline) {
          const readPromise = reader.next();
          const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), Math.max(deadline - Date.now(), 100)),
          );

          const result = await Promise.race([readPromise, timeoutPromise]);
          if (result.done) break;

          const text = result.value?.toString() ?? "";
          yield text;
          if (text.includes("❯") || text.includes("> ")) break;
        }
      },

      isAlive: () => alive,

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
