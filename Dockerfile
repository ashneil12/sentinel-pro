# Sentinel Pro — AI Debugging Sidecar for MoltBot
#
# Multi-stage build:
# 1. Build TypeScript
# 2. Install CLIs (Claude Code + Codex)
# 3. Production image

# ── Stage 1: Build ──────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ── Stage 2: Production ────────────────────────────────────────────────
FROM node:22-slim

# Security: run as non-root
RUN groupadd -r sentinel && useradd -r -g sentinel -m sentinel

# Install git (needed for auto-fix engine)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code and Codex CLIs globally
# Users will authenticate via `claude login` or OPENAI_API_KEY
RUN npm install -g @anthropic-ai/claude-code @openai/codex 2>/dev/null || true

WORKDIR /app

# Copy built output + production dependencies
COPY --from=builder /build/package.json ./
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist

# Create data directories
RUN mkdir -p /data/reports /data/auth /data/git /data/sessions \
    && chown -R sentinel:sentinel /app /data

USER sentinel

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:18791/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

EXPOSE 18791

CMD ["node", "dist/server.js"]
