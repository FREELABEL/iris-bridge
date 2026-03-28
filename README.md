# Coding Agent Bridge

A lightweight local Node.js server that connects coding agents (Claude Code, OpenCode) and messaging platforms (Telegram, Discord) to the IRIS dashboard.

## Quick Start

```bash
cd fl-docker-dev/coding-agent-bridge
npm install
npm start
```

The bridge starts on `http://localhost:3200` by default.

## Architecture

```
IRIS Dashboard (localhost:9300)
    |
    |--- GET /health              --> Bridge status + messaging status
    |--- GET /api/environment     --> Installed component detection
    |--- POST/DELETE /api/providers/telegram  --> Start/stop Telegram bot
    |--- POST/DELETE /api/providers/discord   --> Start/stop Discord bot
    |--- GET/POST /api/sessions/* --> Coding agent session management
    |
Coding Agent Bridge (localhost:3200)
    |
    |--- Claude Code CLI (~/.claude/)
    |--- OpenCode CLI (~/.local/share/opencode/)
    |--- Telegram Bot API --> IRIS API /api/v6/channels/telegram
    |--- Discord Gateway  --> IRIS API /api/v6/channels/discord
```

## Features

### Coding Agent Sessions

Discovers and manages sessions from locally installed coding agents:

- **Claude Code** — reads session JSONL from `~/.claude/projects/`
- **OpenCode** — reads session JSON from `~/.local/share/opencode/storage/`

Sessions can be listed, viewed with full history, and resumed via the CLI.

### Environment Detection

`GET /api/environment` checks for installed IRIS components:

| Component | Detection Path |
|-----------|---------------|
| IRIS CLI | `~/.iris/bin/iris` |
| IRIS SDK | `~/.iris/sdk/package.json` |
| Desktop App | `/Applications/IRIS.app` or `~/Applications/IRIS.app` |
| Agent Bridge | Always `true` (self-reports version from package.json) |

### Messaging Bridges

Telegram and Discord bots can be started/stopped from the dashboard UI or via REST API. Messages are forwarded to the IRIS API using the same payload format as the standalone bridge services.

#### Governance Model

Both platforms follow the same routing rules:

- **Private/DM messages** → GOD MODE (full user access via General Agent)
- **Group/Server messages** → PROJECT MODE (Bloq-scoped, requires @mention)

#### Telegram

```bash
# Start
curl -X POST http://localhost:3200/api/providers/telegram \
  -H 'Content-Type: application/json' \
  -d '{"token": "123456:ABC-DEF...", "api_base_url": "http://localhost:8000"}'

# Response: {"status": "running", "bot_username": "my_bot"}

# Stop
curl -X DELETE http://localhost:3200/api/providers/telegram
# Response: {"status": "stopped"}
```

Messages are forwarded to `{api_base_url}/api/v6/channels/telegram` with the standard Telegram update payload.

#### Discord

```bash
# Start
curl -X POST http://localhost:3200/api/providers/discord \
  -H 'Content-Type: application/json' \
  -d '{"token": "MTIz...", "api_base_url": "http://localhost:8000"}'

# Response: {"status": "running", "bot_username": "MyBot#1234"}

# Stop
curl -X DELETE http://localhost:3200/api/providers/discord
# Response: {"status": "stopped"}
```

Messages are forwarded to `{api_base_url}/api/v6/channels/discord` with the `MESSAGE_CREATE` event payload.

### Token Persistence

Bot tokens are saved to `~/.iris/bridge/.env` so they auto-start when the bridge restarts:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_API_BASE_URL=http://localhost:8000
DISCORD_BOT_TOKEN=MTIz...
DISCORD_API_BASE_URL=http://localhost:8000
```

Delete the file or use the `DELETE` endpoints to remove saved tokens.

## API Reference

### Health & Status

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Bridge status, available providers, messaging bot status |
| `GET` | `/api/environment` | Installed IRIS component detection |

### Messaging Providers

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `POST` | `/api/providers/telegram` | `{token, api_base_url?}` | Start Telegram bot |
| `DELETE` | `/api/providers/telegram` | — | Stop Telegram bot |
| `POST` | `/api/providers/discord` | `{token, api_base_url?}` | Start Discord bot |
| `DELETE` | `/api/providers/discord` | — | Stop Discord bot |

### Coding Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/discover` | List all sessions across providers |
| `GET` | `/api/sessions/claude-code` | List Claude Code sessions |
| `POST` | `/api/sessions/claude-code` | Create new Claude Code session |
| `POST` | `/api/sessions/claude-code/:id/message` | Send message to session |
| `GET` | `/api/sessions/claude-code/:id/history` | Get session history |
| `GET` | `/api/sessions/opencode` | List OpenCode sessions |
| `POST` | `/api/sessions/opencode` | Create new OpenCode session |
| `POST` | `/api/sessions/opencode/:id/message` | Send message to session |
| `GET` | `/api/sessions/opencode/:id/history` | Get session history |
| `POST` | `/api/sessions/open-terminal` | Open session in Terminal.app |

## Dashboard Integration

The IRIS dashboard (Board.vue → A2A Bridge → Config tab) provides a UI for all bridge features:

1. **Bridge Status** — connection health check to localhost:3200
2. **Installed Components** — 2x2 grid showing CLI, SDK, Desktop, Bridge status
3. **Coding Agent Providers** — Claude Code, OpenCode, OpenClaw connection status
4. **Messaging Bridges** — Telegram and Discord with:
   - Status indicator (Running/Stopped)
   - Bot username display
   - Connect button with token input
   - Stop button for running bots
5. **How It Works** — overview of the session discovery flow

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `BRIDGE_PORT` | `3200` | Server port |
| `CLAUDE_BIN` | `/opt/homebrew/bin/claude` | Path to Claude Code CLI |
| `OPENCODE_BIN` | `/opt/homebrew/bin/opencode` | Path to OpenCode CLI |

## Replaces

This unified bridge absorbs the standalone services:

- `fl-docker-dev/telegram-bridge/` — Telegram forwarding now built-in
- `fl-iris-api/discord-bridge/` — Discord forwarding now built-in

The forwarding payloads and API endpoints are identical, so the IRIS API backend requires no changes.
