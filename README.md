# IRIS Daemon

Turns any machine into a sovereign Hive compute node. Executes tasks, runs scripts, manages local schedules, and connects to the IRIS mesh network.

## Install

```bash
curl -fsSL https://heyiris.io/install-daemon | bash
```

Or with the full IRIS CLI installer (includes daemon):
```bash
curl -fsSL https://heyiris.io/install-code | bash
```

## What It Does

```
┌─────────────────────────────────────────────────┐
│  IRIS Daemon (Node.js)                          │
│                                                 │
│  Core:                                          │
│  ├── Task Executor    — run any script/command  │
│  ├── Cloud Client     — hub auth + API          │
│  ├── Pusher Client    — real-time task dispatch  │
│  ├── Schedule Registry — local cron (offline)   │
│  ├── Resource Monitor — CPU/memory/battery      │
│  ├── Heartbeat        — node health reporting   │
│  └── IRIS SDK (Node)  — API wrapper for scripts │
│                                                 │
│  Mesh:                                          │
│  ├── Peer Discovery   — mDNS LAN networking    │
│  ├── Peer Dispatch    — offload tasks to peers  │
│  └── Mesh Energy      — capacity-aware routing  │
│                                                 │
│  Extras:                                        │
│  ├── Session Bridge   — Claude/OpenCode/Ollama  │
│  ├── Bot Channels     — Telegram, Discord       │
│  ├── Browser Agent    — Playwright automation   │
│  └── SSH Sharing      — remote peer access      │
│                                                 │
│  HTTP API on :3200                              │
└─────────────────────────────────────────────────┘
```

## CLI

```bash
iris-daemon start|stop|status|register

# Scripts
iris hive script push ./my-script.sh
iris hive script list
iris hive script exec my-script.sh

# Local schedules (runs offline)
iris hive schedule add my-script.sh --cron "*/5 * * * *"
iris hive schedule list
iris hive schedule pause|resume|rm <id>

# Diagnostics
iris hive doctor
iris hive queue
iris hive tasks
```

## Writing Scripts with @iris/sdk

```javascript
const IRIS = require('./daemon/iris-sdk.js')
const iris = new IRIS()  // reads ~/.iris/sdk/.env

const leads = await iris.leads.list({ type: 'competitor' })
const brand = await iris.tools.invoke('websiteBrandExtractor', { url: 'https://example.com' })
await iris.leads.addNote(123, 'Brand extracted successfully')
```

## Structure

```
iris-daemon/
├── daemon.js              # Main entrypoint
├── daemon/
│   ├── index.js           # Daemon orchestrator
│   ├── task-executor.js   # 40+ task types
│   ├── cloud-client.js    # Hub communication (failover)
│   ├── pusher-client.js   # Real-time WebSocket
│   ├── schedule-registry.js # Local cron (node-cron)
│   ├── iris-sdk.js        # Node.js SDK for scripts
│   ├── heartbeat.js       # Health reporting
│   ├── resource-monitor.js # CPU/memory/battery
│   ├── hardware-profile.js # System capability detection
│   ├── workspace-manager.js # Task isolation
│   ├── mesh-discovery.js  # mDNS peer finding
│   ├── mesh-dispatch.js   # Peer task routing
│   ├── mesh-registry.js   # Known peers
│   ├── mesh-auth.js       # Peer authentication
│   ├── mesh-energy.js     # Capacity monitoring
│   ├── mesh-chat.js       # Peer messaging
│   └── ssh-share.js       # Remote access
├── index.js               # HTTP server (bridge)
├── production.js          # Production entrypoint
├── doctor.js              # Diagnostics
├── channels/              # Bot bridges (Telegram, Discord, iMessage)
├── drivers/               # CLI wrappers (Claude, OpenCode, Ollama)
├── browser-agent/         # Playwright automation
├── scripts/               # Utility scripts
├── installers/            # OS-specific installers
└── lib/                   # Shared utilities
```

## Task Types

The daemon executes 40+ task types via `task-executor.js`:

- **Scripts**: `sandbox_execute`, `test_run`, `execute_file`
- **Browser**: `browser`, `custom_playwright`
- **Code Gen**: `code_generation`, `claude_code`, `opencode`, `local_llm`
- **Social**: `som`, `som_batch`, `discover`, `linkedin`, `twitter`, `instagram`, `email`
- **Content**: `remotion`, `social_feed_sync`
- **Compute**: `artisan`, `peer_exec`, `deploy_project`, `scaffold_workspace`

## Environment

Reads config from `~/.iris/config.json`:
```json
{
  "node_api_key": "node_live_xxx",
  "api_url": "https://heyiris.io",
  "user_id": 193
}
```

SDK reads from `~/.iris/sdk/.env`:
```
IRIS_API_KEY=your_key
IRIS_USER_ID=193
```
