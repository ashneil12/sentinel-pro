# Sentinel Pro — AI Debugging Sidecar

> AI-powered log analysis and bug fixing for MoltBot instances, using your own Claude Code or Codex CLI subscription.

## Overview

Sentinel Pro is a Docker sidecar that:

- **Reads your server logs** from shared Docker volumes
- **Analyzes issues** using Claude Code or Codex CLI (your subscription)
- **Suggests fixes** with diffs, applied in isolated git worktrees
- **Runs 24/7** — even when the main gateway is down
- **Integrates with the dashboard** via WebSocket chat and REST API

### Architecture

```
┌────────────────────────────────────┐
│           User's Browser           │
│   Dashboard → WS chat + REST API  │
└────────────┬───────────────────────┘
             │ auth'd WebSocket
┌────────────▼───────────────────────┐
│      Sentinel Pro Container        │
│                                    │
│  ┌──────────┐  ┌───────────────┐  │
│  │ Cron Jobs │  │ Chat Server   │  │
│  │ (analysis)│  │ (WebSocket)   │  │
│  └─────┬────┘  └───────┬───────┘  │
│        │               │          │
│  ┌─────▼───────────────▼───────┐  │
│  │      CLI Adapter Layer      │  │
│  │  (Claude Code / Codex CLI)  │  │
│  └─────┬───────────────┬──────┘  │
│        │               │          │
│  ┌─────▼────┐  ┌──────▼───────┐  │
│  │ Log Ingest│  │ Fix Engine   │  │
│  │ (read-only)│  │ (git worktree)│ │
│  └───────────┘  └──────────────┘  │
└────────────────────────────────────┘
```

## Quick Start

### 1. Deploy

```bash
# Add to your existing docker-compose stack
docker-compose -f docker-compose.yml -f docker-compose.sentinel-pro.yml up -d
```

### 2. Authenticate CLI

```bash
# Claude Code
docker exec -it sentinel-pro claude login

# OR Codex CLI
docker exec -it sentinel-pro codex auth
```

### 3. Connect Dashboard

In your MoltBot dashboard:
1. Go to instance **Settings → Sentinel Pro**
2. Enter sidecar URL (`http://sentinel-pro:18791`)
3. Enter the `SENTINEL_PRO_TOKEN` you set in your environment
4. Click **Test** to verify connectivity

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SENTINEL_PRO_TOKEN` | *(required in prod)* | Auth token for dashboard ↔ sidecar |
| `SENTINEL_PRO_CLI` | *(auto-detect)* | Preferred CLI: `claude-code` or `codex` |
| `CRON_SCHEDULE` | `0 8,14,20 * * *` | Analysis schedule (cron expression) |
| `SENTINEL_PRO_PORT` | `18791` | API server port |
| `OPENCLAW_GATEWAY_URL` | `http://openclaw-gateway:18789` | Gateway URL for health checks |
| `TZ` | `UTC` | Timezone for cron + display |
| `SENTINEL_PRO_MAX_LOG_LINES` | `500` | Max log lines per analysis |
| `SENTINEL_PRO_LOGS_DIR` | `/logs` | Log files mount path |
| `SENTINEL_PRO_WORKSPACE_DIR` | `/workspace` | Source code mount path |
| `SENTINEL_PRO_DATA_DIR` | `/data` | Persistent data path |

### Schedule Presets

| Preset | Schedule | Description |
|--------|----------|-------------|
| Light | `0 8 * * *` | 1× daily (morning sweep) |
| Standard | `0 8,14,20 * * *` | 3× daily |
| Intensive | `0 */4 * * *` | Every 4 hours |

## API Reference

All endpoints require `Authorization: Bearer <SENTINEL_PRO_TOKEN>`.

### Status & Reports

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/healthz` | Health check (unauthenticated) |
| GET | `/api/sentinel-pro/status` | Sidecar status + gateway health |
| GET | `/api/sentinel-pro/reports` | Paginated analysis reports |
| GET | `/api/sentinel-pro/reports/:id` | Single report detail |
| POST | `/api/sentinel-pro/analyze` | Trigger on-demand analysis |

### Fix Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sentinel-pro/fixes` | List fix records |
| GET | `/api/sentinel-pro/fixes/:id` | Fix detail |
| POST | `/api/sentinel-pro/fixes/:id/approve` | Apply fix (git worktree) |
| POST | `/api/sentinel-pro/fixes/:id/reject` | Dismiss fix |
| POST | `/api/sentinel-pro/fixes/:id/rollback` | Undo applied fix |
| POST | `/api/sentinel-pro/gateway/restart` | Restart gateway container |

### Interactive Chat

| Protocol | Endpoint | Description |
|----------|----------|-------------|
| WebSocket | `/api/sentinel-pro/chat?token=<token>` | Real-time debugging session |

**WebSocket Messages:**

```json
// Client → Server
{ "type": "message", "content": "Why is my bot crashing?" }

// Server → Client
{ "type": "connected", "sessionId": "...", "provider": "claude-code" }
{ "type": "thinking" }
{ "type": "chunk", "content": "Looking at your logs..." }
{ "type": "done" }
{ "type": "error", "message": "..." }
```

## Security

| Boundary | Implementation |
|----------|---------------|
| CLI credentials | Stored in container volume, never exposed to dashboard |
| Log access | Read-only Docker volume mount |
| Source code | Configurable: read-only or read-write |
| Fix isolation | Git worktree on `sentinel-pro/fix-*` branches |
| Dashboard auth | Separate token from gateway, validated per-request |
| Container | Runs as non-root, capped memory (2GB) |

## Billing Model

Sentinel Pro uses **BYOC (Bring Your Own CLI)** — you authenticate with your own Claude Code or Codex subscription. MoltBot charges only for the infrastructure:

- **Sidecar container**: ~$5-10/mo
- **Storage (reports, git)**: ~$1-2/mo
- **AI costs**: $0 (your subscription)

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type check
npm run typecheck

# Build
npm run build

# Dev server
npm run dev
```

### Project Structure

```
src/
├── server.ts           # Entry point
├── config.ts           # Environment config
├── logger.ts           # Pino logging
├── api.ts              # Fastify REST + WebSocket
├── cron.ts             # Scheduled analysis
├── log-ingester.ts     # Log file reader
├── report-store.ts     # JSONL report persistence
├── fix-engine.ts       # Git worktree fix management
├── prompts/index.ts    # System prompts for analysis
└── adapters/
    ├── types.ts        # CLI adapter interface
    ├── claude-code.ts  # Claude Code CLI adapter
    ├── codex.ts        # Codex CLI adapter
    ├── parse-output.ts # Finding/fix extraction
    └── index.ts        # Adapter factory
```
