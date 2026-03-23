/**
 * Auth Manager for Sentinel Pro.
 *
 * Manages CLI authentication state for Claude Code and Codex CLI.
 * Supports:
 *   - Device code OAuth flow (for both CLIs)
 *   - API key auth (ANTHROPIC_API_KEY / OPENAI_API_KEY written to .env)
 *   - Status polling (checks credential files for each CLI)
 *
 * Auth credentials are stored in /data/auth/ (a Docker-named volume).
 * The device flow process is kept in memory and times out after 5 minutes.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const log = logger.child({ module: 'auth-manager' });

// ── Types ──────────────────────────────────────────────────────────────────

export type CliProvider = 'claude-code' | 'codex';
export type AuthMode = 'oauth' | 'api-key' | 'none';

export interface AuthStatus {
  provider: CliProvider;
  mode: AuthMode;
  authenticated: boolean;
  /** For api-key mode, whether a key is present (we never return the key itself) */
  hasApiKey?: boolean;
}

export interface DeviceFlowSession {
  provider: CliProvider;
  /** URL the user must visit */
  url: string;
  /** Code to enter at the URL */
  code: string;
  /** ISO timestamp when the session was started */
  startedAt: string;
  /** ISO timestamp when the session expires */
  expiresAt: string;
  /** Current phase */
  status: 'pending' | 'completed' | 'error' | 'timed_out';
  error?: string;
}

// ── Internal state (in-process, per sidecar instance) ─────────────────────

const activeSessions = new Map<CliProvider, {
  session: DeviceFlowSession;
  proc: ReturnType<typeof spawn>;
  timer: ReturnType<typeof setTimeout>;
}>();

// ── Credential file paths ──────────────────────────────────────────────────

// Claude Code stores credentials at ~/.claude/credentials.json (inside the container,
// home is /home/sentinel). We mount /data/auth as a persistent volume.
// Symlink /home/sentinel/.claude → /data/auth/claude at startup (handled by server.ts).
const CLAUDE_CRED_PATH   = '/data/auth/claude/credentials.json';
const CODEX_CRED_PATH    = '/data/auth/codex/auth.json';
const CLAUDE_KEY_PATH    = '/data/auth/claude-api-key';
const CODEX_KEY_PATH     = '/data/auth/codex-api-key';

// ── Status Helpers ─────────────────────────────────────────────────────────

function isFilePresent(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function getAuthStatus(provider: CliProvider): AuthStatus {
  if (provider === 'claude-code') {
    const hasOAuth  = isFilePresent(CLAUDE_CRED_PATH);
    const hasApiKey = isFilePresent(CLAUDE_KEY_PATH);
    return {
      provider,
      mode:          hasOAuth ? 'oauth' : hasApiKey ? 'api-key' : 'none',
      authenticated: hasOAuth || hasApiKey,
      hasApiKey,
    };
  } else {
    const hasOAuth  = isFilePresent(CODEX_CRED_PATH);
    const hasApiKey = isFilePresent(CODEX_KEY_PATH);
    return {
      provider,
      mode:          hasOAuth ? 'oauth' : hasApiKey ? 'api-key' : 'none',
      authenticated: hasOAuth || hasApiKey,
      hasApiKey,
    };
  }
}

// ── API Key Auth ───────────────────────────────────────────────────────────

/**
 * Store an API key for a provider. Returns the env var name to set as a hint.
 * The key is written to a dedicated file — the adapter reads it via env on
 * the next analysis run (we restart the adapter factory on next use).
 */
export function setApiKey(provider: CliProvider, apiKey: string): { envVar: string } {
  const keyPath = provider === 'claude-code' ? CLAUDE_KEY_PATH : CODEX_KEY_PATH;
  const envVar  = provider === 'claude-code' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';

  // Clear any existing OAuth credentials so we don't have conflicts
  if (provider === 'claude-code') {
    try { fs.rmSync(CLAUDE_CRED_PATH); } catch { /* ignore */ }
  } else {
    try { fs.rmSync(CODEX_CRED_PATH); } catch { /* ignore */ }
  }

  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, apiKey, { mode: 0o600 });

  // Also write to the adapter env so spawned processes pick it up immediately
  process.env[envVar] = apiKey;

  log.info({ provider, envVar }, 'API key stored');
  return { envVar };
}

export function clearAuth(provider: CliProvider): void {
  const keyPath  = provider === 'claude-code' ? CLAUDE_KEY_PATH  : CODEX_KEY_PATH;
  const credPath = provider === 'claude-code' ? CLAUDE_CRED_PATH : CODEX_CRED_PATH;
  const envVar   = provider === 'claude-code' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';

  try { fs.rmSync(keyPath); }  catch { /* ignore */ }
  try { fs.rmSync(credPath); } catch { /* ignore */ }
  delete process.env[envVar];

  // Cancel any active device session
  const active = activeSessions.get(provider);
  if (active) {
    clearTimeout(active.timer);
    try { active.proc.kill(); } catch { /* ignore */ }
    activeSessions.delete(provider);
  }

  log.info({ provider }, 'Auth cleared');
}

// ── OAuth Device Flow ──────────────────────────────────────────────────────

const DEVICE_FLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Parse URL and user code from CLI device-flow output.
 * Both CLIs print something like:
 *   "Visit: https://anthropic.com/device\nEnter code: ABCD-1234"
 *   "Go to https://platform.openai.com/device and enter user code: ABCD-1234"
 */
function parseDeviceFlowOutput(stdout: string): { url: string; code: string } | null {
  // Match URL (https://...)
  const urlMatch = stdout.match(/https?:\/\/\S+/);
  // Match code — typically 4 alpha chars, hyphen, 4 alphanumeric OR short word codes
  const codeMatch = stdout.match(/(?:code|enter)[:\s]+([A-Z0-9]{4,8}[-–][A-Z0-9]{4,8})/i)
    ?? stdout.match(/\b([A-Z]{4,6}-[A-Z0-9]{4,6})\b/);

  if (!urlMatch || !codeMatch) return null;
  return { url: urlMatch[0].replace(/[,.]$/, ''), code: codeMatch[1] };
}

/**
 * Starts the device-code OAuth flow for the given CLI.
 * Returns immediately with a session object (or throws if already running).
 */
export async function startDeviceFlow(provider: CliProvider): Promise<DeviceFlowSession> {
  // If there's already an active session, return it (idempotent)
  const existing = activeSessions.get(provider);
  if (existing && existing.session.status === 'pending') {
    // Check it hasn't been fulfilled in the meantime
    const status = getAuthStatus(provider);
    if (status.authenticated) {
      existing.session.status = 'completed';
      activeSessions.delete(provider);
    }
    return existing.session;
  }

  // Clean up any stale session
  if (existing) {
    clearTimeout(existing.timer);
    try { existing.proc.kill(); } catch { /* ignore */ }
    activeSessions.delete(provider);
  }

  const binary = provider === 'claude-code' ? 'claude' : 'codex';
  const args   = provider === 'claude-code'
    ? ['login', '--device-auth']
    : ['login', '--device-auth'];   // @openai/codex uses same flag

  const now      = new Date();
  const expiresAt = new Date(now.getTime() + DEVICE_FLOW_TIMEOUT_MS);

  const session: DeviceFlowSession = {
    provider,
    url:       '',
    code:      '',
    startedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    status:    'pending',
  };

  log.info({ provider, binary, args }, 'Starting device flow');

  // Spawn the CLI — collect stdout until we find the URL+code
  const proc = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  });

  let collected = '';

  const tryParse = (): boolean => {
    const parsed = parseDeviceFlowOutput(collected);
    if (parsed) {
      session.url  = parsed.url;
      session.code = parsed.code;
      log.info({ provider, url: parsed.url, code: parsed.code }, 'Device flow URL/code captured');
      return true;
    }
    return false;
  };

  proc.stdout?.on('data', (chunk: Buffer) => {
    collected += chunk.toString();
    tryParse();
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    collected += chunk.toString();
    tryParse();
  });

  proc.on('close', (code) => {
    const entry = activeSessions.get(provider);
    if (!entry) return;
    if (code === 0) {
      entry.session.status = 'completed';
      log.info({ provider }, 'Device flow completed successfully');
    } else if (entry.session.status === 'pending') {
      entry.session.status = 'error';
      entry.session.error  = `CLI exited with code ${code}: ${collected.slice(-200)}`;
      log.warn({ provider, code }, 'Device flow process exited with error');
    }
  });

  proc.on('error', (err) => {
    session.status = 'error';
    session.error  = err.message;
    log.error({ provider, error: err.message }, 'Failed to spawn device flow CLI');
  });

  // Timeout watchdog
  const timer = setTimeout(() => {
    const entry = activeSessions.get(provider);
    if (entry?.session.status === 'pending') {
      entry.session.status = 'timed_out';
      entry.session.error  = 'Device flow timed out after 5 minutes';
      try { entry.proc.kill(); } catch { /* ignore */ }
      log.warn({ provider }, 'Device flow timed out');
    }
  }, DEVICE_FLOW_TIMEOUT_MS);

  activeSessions.set(provider, { session, proc, timer });

  // Wait up to 15s for the URL+code to appear before returning
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (session.url && session.code) break;
    if (session.status !== 'pending') break;
    await new Promise(r => setTimeout(r, 250));
  }

  if (!session.url || !session.code) {
    // Still no URL — return partial session, client will poll for it
    log.warn({ provider, collected: collected.slice(0, 500) }, 'Could not extract URL/code after 15s, returning partial session');
  }

  return session;
}

/**
 * Poll the current status of a device flow session.
 */
export function getDeviceFlowStatus(provider: CliProvider): DeviceFlowSession | null {
  const entry = activeSessions.get(provider);
  if (!entry) {
    // Maybe it completed and we cleaned up — check credential files
    const status = getAuthStatus(provider);
    if (status.authenticated) {
      return {
        provider,
        url:       '',
        code:      '',
        startedAt: '',
        expiresAt: '',
        status:    'completed',
      };
    }
    return null;
  }

  // Check if credentials appeared (CLI may have completed but listener missed the close event)
  if (entry.session.status === 'pending') {
    const status = getAuthStatus(provider);
    if (status.authenticated && status.mode === 'oauth') {
      entry.session.status = 'completed';
      clearTimeout(entry.timer);
      activeSessions.delete(provider);
    }
  }

  return entry.session;
}
