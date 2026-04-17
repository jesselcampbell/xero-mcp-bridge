# Xero MCP Bridge

Keep your Xero MCP connection alive in Claude Desktop and Claude Code despite Xero's 30-minute access-token rotations — and do it via OAuth 2.0 PKCE, so you don't need Xero's Custom Connections (which are only available to orgs in NZ / UK / US / Australia, leaving Canada, the EU, and elsewhere out in the cold).

This is a thin stdio proxy that wraps the official `@xeroapi/xero-mcp-server`, watches for token rotation, and transparently respawns the server with the new token. Claude never sees a disconnection.

## Key Features

- **Stdio proxy wrapper** — holds the long-lived connection to Claude Desktop / Claude Code, forks the official Xero MCP server as a short-lived child, transparently respawns it on every token rotation with the `initialize` handshake replayed.
- **PKCE auth, no client secret** — works for any Xero org worldwide, including regions excluded from Custom Connections.
- **Hands-off token lifecycle** — a launchd agent refreshes the 30-minute access token every 20 minutes, survives sleep/wake, and renews the 60-day refresh token indefinitely.
- **Zero bearer tokens in configs** — the wrapper reads the token from a gitignored file at each child spawn. Claude config files contain only a path to the wrapper.
- **Self-healing** — the wrapper recovers from unexpected child exits; the refresh script is idempotent and writes the wrapper entry into Claude configs if it's missing or stale.
- **Full MCP tool surface** — exposes all 51 tools from `@xeroapi/xero-mcp-server` (accounting, payroll, reports, etc.) unchanged.

## Contents

- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
  - [1. Create the Xero app](#1-create-the-xero-app-one-time-2-min)
  - [2. Clone this repo](#2-clone-this-repo-and-put-your-client-id-somewhere-you-wont-lose-it)
  - [3. Initial auth](#3-initial-auth)
  - [4. Install the launchd agent](#4-install-the-launchd-agent)
  - [5. Wire up the Claude clients](#5-wire-up-the-claude-clients)
- [Architecture](#architecture)
  - [Why a wrapper is necessary](#why-a-wrapper-is-necessary)
  - [Process model](#process-model)
  - [Token rotation flow](#token-rotation-flow)
  - [MCP handshake replay](#mcp-handshake-replay)
- [Project structure](#project-structure)
- [Environment variables](#environment-variables)
- [Commands reference](#commands-reference)
- [Day-to-day usage](#day-to-day-usage)
- [Verifying the installation](#verifying-the-installation)
- [Troubleshooting](#troubleshooting)
  - [Quick health check](#quick-health-check)
  - [Symptom → cause → fix](#symptom--cause--fix)
  - [Manual commands](#manual-commands)
  - [Where to find logs](#where-to-find-logs)
- [Token lifecycle and maintenance](#token-lifecycle-and-maintenance)
  - [Lifetimes](#lifetimes)
  - [When the refresh token dies](#when-the-refresh-token-dies)
  - [Re-auth steps](#re-auth-steps)
  - [Preventing expiry](#preventing-expiry)
- [Managing the launchd agent](#managing-the-launchd-agent)
- [Contributing](#contributing)
- [License](#license)

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 18+ (tested on 24 via `nvm`) | Built-in `fetch`, `node:child_process`, `node:fs.watch` — no dependencies |
| Dependencies | **Zero runtime dependencies** in this repo | The wrapper shells out to `npx @xeroapi/xero-mcp-server@latest`; npm fetches that on first run |
| Scheduler | macOS `launchd` | Catches up missed `StartCalendarInterval` fires after sleep — cron does not |
| Auth | Xero OAuth 2.0 with PKCE (RFC 7636) | The only Xero grant type that works for non-AU/NZ/UK/US orgs |
| Downstream MCP server | [`@xeroapi/xero-mcp-server`](https://www.npmjs.com/package/@xeroapi/xero-mcp-server) | Official Xero MCP implementation; reads `XERO_CLIENT_BEARER_TOKEN` from env at spawn |
| Upstream protocol | Model Context Protocol over stdio (JSON-RPC 2.0) | What Claude Desktop / Claude Code speak to MCP servers |
| Clients | Claude Desktop, Claude Code | Either or both; the wrapper is agnostic |
| Platform | macOS (Apple Silicon or Intel) | launchd + Claude Desktop config paths are macOS-specific; scripts are portable to Linux with systemd user units |

## Prerequisites

- **macOS.** The launchd agent and the Claude Desktop config paths are macOS-specific. The scripts themselves are portable; adapt to systemd / Task Scheduler on other OSes.
- **Node 18+.** Tested with Node 24 via `nvm`. The `xero-auth.mjs` script uses built-in `fetch`. Confirm with `node --version`.
- **A Xero organisation** you can sign into, plus a developer account at <https://developer.xero.com/>.
- **Claude Desktop** and/or **Claude Code** installed — that's the consumer of the MCP server.

## Getting started

### 1. Create the Xero app (one-time, ~2 min)

1. Sign in at <https://developer.xero.com/app/manage/> with the same account that accesses your Xero org.
2. Click **New app**.
3. Fill in:
   - **App name** — anything (e.g. `My MCP Server`).
   - **Integration type** — select **Web app**. Not Mobile/Desktop — we need PKCE with a redirect URI, and "Web app" is where Xero's UI surfaces the "Auth Code with PKCE" grant.
   - **Company or application URL** — anything valid (e.g. your personal site, or `https://example.com`).
   - **Redirect URI** — exactly `http://localhost:8765/callback`. This port must match what `xero-auth.mjs` listens on.
4. Accept the terms and click **Create app**.
5. On the app page, find the **Client id** (the long hex string). **Copy it** — you'll use it as `XERO_CLIENT_ID` below. There is no client secret in PKCE — you can ignore that section.
6. Under **Configuration → Scopes**, enable every scope `xero-auth.mjs` requests. If you enable fewer scopes in the Xero app than the script asks for, Xero rejects the authorization request with `invalid_scope`. As of this writing the script asks for:

   ```
   openid  profile  email  offline_access
   accounting.invoices            accounting.invoices.read
   accounting.payments            accounting.payments.read
   accounting.banktransactions    accounting.banktransactions.read
   accounting.manualjournals      accounting.manualjournals.read
   accounting.reports.aged.read
   accounting.reports.balancesheet.read
   accounting.reports.profitandloss.read
   accounting.reports.trialbalance.read
   accounting.contacts            accounting.settings
   payroll.settings               payroll.employees   payroll.timesheets
   ```

   The authoritative source is the `SCOPES` constant at the top of `xero-auth.mjs` — if you want a narrower blast radius, trim that array before running the script (and enable only the matching scopes in Xero).

   `offline_access` is the critical one — without it you won't get a refresh token, and the whole auto-rotation machinery falls apart.

### 2. Clone this repo and put your client id somewhere you won't lose it

```bash
git clone https://github.com/jesselcampbell/xero-mcp-bridge ~/AI/scripts/xero-mcp-bridge
cd ~/AI/scripts/xero-mcp-bridge
```

Stash your client id in your shell for the setup steps (or paste it inline each time):

```bash
export XERO_CLIENT_ID=YOUR_CLIENT_ID_HERE
```

### 3. Initial auth

```bash
cd ~/AI/scripts/xero-mcp-bridge
node xero-auth.mjs
```

What happens, step by step:

1. The script generates a PKCE code verifier + challenge and a random `state` token (CSRF protection).
2. It starts a tiny HTTP server on `localhost:8765` listening for the OAuth callback.
3. It opens your default browser to Xero's consent page with your client id, scopes, and the code challenge.
4. You log in to Xero and pick which organisation(s) to connect.
5. Xero redirects to `http://localhost:8765/callback?code=...&state=...`. The script verifies the state, grabs the code, and POSTs it to `https://identity.xero.com/connect/token` along with the original code verifier to exchange it for an access token + refresh token.
6. Tokens are written to `xero-tokens.json` (gitignored).
7. The script calls `https://api.xero.com/connections` to list connected tenants and prints them.

Expected output:

```
🚀 Starting Xero PKCE auth flow...
🌐 Callback server listening on http://localhost:8765
📱 Opening browser for Xero login...
🔄 Exchanging authorization code for tokens...
✅ Tokens saved to /Users/you/AI/scripts/xero-mcp-bridge/xero-tokens.json
🔍 Fetching connected Xero tenants...
📌 Connected tenants:
   1. Your Company Name (ORGANISATION)
```

If you see your org name, you're good to continue.

### 4. Install the launchd agent

Save this as `~/Library/LaunchAgents/com.YOUR_USERNAME.xero-mcp-bridge-refresh.plist`, replacing both placeholders (`YOUR_USERNAME` and `YOUR_CLIENT_ID`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.YOUR_USERNAME.xero-mcp-bridge-refresh</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/.nvm/versions/node/v24.14.1/bin/node</string>
        <string>/Users/YOUR_USERNAME/AI/scripts/xero-mcp-bridge/xero-refresh.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USERNAME/AI/scripts/xero-mcp-bridge</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>XERO_CLIENT_ID</key>
        <string>YOUR_CLIENT_ID</string>
    </dict>
    <key>StartCalendarInterval</key>
    <array>
        <dict><key>Minute</key><integer>0</integer></dict>
        <dict><key>Minute</key><integer>20</integer></dict>
        <dict><key>Minute</key><integer>40</integer></dict>
    </array>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>/tmp/xero-refresh.log</string>
    <key>StandardErrorPath</key><string>/tmp/xero-refresh.log</string>
</dict>
</plist>
```

Tips:

- The **`node` path** must be absolute and must be the same Node you used in step 3. launchd has no `PATH`. Get yours with `which node`.
- The **`WorkingDirectory`** must be the folder containing `xero-tokens.json`.
- **`RunAtLoad`** fires the script once immediately on load — that's how Claude configs get wired up in step 5.
- **`StartCalendarInterval`** fires at `:00`, `:20`, `:40` every hour. Unlike cron, launchd catches up missed fires after the Mac wakes from sleep.

Validate, load, confirm:

```bash
plutil -lint ~/Library/LaunchAgents/com.YOUR_USERNAME.xero-mcp-bridge-refresh.plist
launchctl load ~/Library/LaunchAgents/com.YOUR_USERNAME.xero-mcp-bridge-refresh.plist

# Second column should be "0" (last exit status)
launchctl list | grep xero-mcp-bridge-refresh

# Confirm first run succeeded
tail /tmp/xero-refresh.log
```

### 5. Wire up the Claude clients

The first run of `xero-refresh.mjs` (triggered by `RunAtLoad` above) refreshes the token into `xero-tokens.json` and writes the wrapper entry into both Claude configs. Each entry looks like this:

```json
{
  "command": "/Users/YOUR_USERNAME/.nvm/versions/node/v24.14.1/bin/node",
  "args": ["/Users/YOUR_USERNAME/AI/scripts/xero-mcp-bridge/xero-mcp-wrapper.mjs"],
  "type": "stdio"
}
```

No bearer token in the config — the wrapper reads it from `xero-tokens.json` at each child spawn and rotates it live.

#### Claude Desktop (easy — auto-wires)

The script writes `mcpServers.Xero` into `~/Library/Application Support/Claude/claude_desktop_config.json`. Desktop reads this at launch.

- **Quit Claude Desktop** (`Cmd+Q`) and reopen it. It spawns the wrapper and you're done.
- Verify: open a new chat and ask "list my Xero organisations." A tool-use confirmation should appear.

#### Claude Code (takes one more step)

The script writes `mcpServers.xero` into `~/.claude.json`, which is the user-scoped location. This works in current Claude Code, but the *canonical* command — if your version ignores the direct edit, or if you'd rather not trust a script to touch `~/.claude.json` — is:

```bash
claude mcp add xero \
  --scope user \
  -- /Users/YOUR_USERNAME/.nvm/versions/node/v24.14.1/bin/node \
     /Users/YOUR_USERNAME/AI/scripts/xero-mcp-bridge/xero-mcp-wrapper.mjs
```

Either way:

1. **Start a new Claude Code session** — existing sessions won't pick up the new server.
2. Run `/mcp` in the session — you should see `xero` listed.
3. The first tool call will prompt you to trust/enable the server. Approve it. Tools show up on the next request.

If `xero` doesn't appear:

```bash
# See exactly what Claude Code sees
claude mcp list

# If nothing Xero-related → re-run the `claude mcp add` command above
# If it's listed but tools don't work → the wrapper can't find xero-tokens.json
#   pgrep -fl xero-mcp-wrapper.mjs
#   cat /tmp/xero-refresh.log
```

After both clients are wired, **token rotations are transparent** — no more manual intervention.

## Architecture

### Why a wrapper is necessary

Three separate constraints combine to make this harder than it should be:

1. **Xero access tokens live 30 minutes** (hard-coded by Xero — not configurable via any scope, app setting, or grant type).
2. **`@xeroapi/xero-mcp-server` reads `XERO_CLIENT_BEARER_TOKEN` once at module import** (`dist/clients/xero-client.js:8`). The token is baked into the `BearerTokenXeroClient` instance; there's no hot-reload path, no file watcher, no refresh hook.
3. **Claude Desktop and Claude Code do not respawn stdio MCP servers when they die.** Desktop in particular has no watchdog — if a server exits, the client marks it disconnected until you manually quit and reopen the app.

The naïve approaches all fail:

| Approach | Why it fails |
|---|---|
| Rotate the token in the Claude config file | Desktop reads config only at launch; running MCP server has the old token in memory |
| Kill the MCP server to force a respawn | Desktop doesn't respawn on its own — kill just breaks Xero tools until manual restart |
| Fork and patch `@xeroapi/xero-mcp-server` to re-read the env | Maintenance burden on every upstream release |
| HTTPS MITM proxy to inject fresh tokens per request | Requires local CA cert and TLS interception — far more invasive |

**The wrapper is the only shape that works** without user intervention: stay alive on stdio (so Claude's connection is stable), fork the official MCP server as a short-lived child, watch the token file, and transparently respawn the child on every rotation. Replay the cached `initialize` handshake so the new child is immediately ready for tool calls.

### Process model

```
┌──────────────────────┐          ┌──────────────────────┐
│   Claude Desktop /   │  stdio   │ xero-mcp-wrapper.mjs │
│   Claude Code        │◀────────▶│   (long-lived)       │
└──────────────────────┘          └──────────┬───────────┘
                                             │ stdio
                                             ▼
                                  ┌──────────────────────┐
                                  │ @xeroapi/xero-mcp-   │
                                  │  server (child)      │  ← replaced on
                                  │  ≤ 30 min lifetime   │    every rotation
                                  └──────────────────────┘
                                             ▲
                                             │ spawned with
                                             │ XERO_CLIENT_BEARER_TOKEN
                                             │
                                  ┌──────────┴───────────┐
                                  │   xero-tokens.json   │
                                  │   (gitignored,       │
                                  │    fs.watch'd)       │
                                  └──────────▲───────────┘
                                             │ written by
                                             │
                                  ┌──────────┴───────────┐          ┌──────────┐
                                  │ xero-refresh.mjs     │◀─────────│ launchd  │
                                  │ (every 20 min)       │  fires   │  agent   │
                                  └──────────────────────┘          └──────────┘
```

### Token rotation flow

1. **launchd fires** at `:00`, `:20`, or `:40` — or on wake if the Mac was asleep.
2. **`xero-refresh.mjs` runs.** If the current access token has >5 min remaining, it's a no-op and exits. Otherwise it POSTs the refresh token to `https://identity.xero.com/connect/token`, receives a new access + refresh token pair, and atomically rewrites `xero-tokens.json`.
3. **`xero-mcp-wrapper.mjs` detects the file change** via `fs.watch` (debounced 300ms to coalesce write events).
4. **The wrapper kills its current child's process group** with `SIGTERM` (the child was spawned with `detached: true` so the whole process group — npx → npm exec → node — goes down cleanly).
5. **The wrapper spawns a fresh child** with the new `XERO_CLIENT_BEARER_TOKEN` in its env.
6. **The wrapper replays the cached `initialize` request** to the new child and swallows the response (the parent client already has one from the original handshake).
7. **Subsequent `tools/call` requests flow through normally.** Any request that was in-flight at respawn time gets a JSON-RPC error response so the client doesn't hang; a simple retry succeeds.

Total user-visible disruption per rotation: **zero**, under normal load. If you happen to fire a tool call during the <1s respawn window, you get one retryable error.

### MCP handshake replay

The MCP protocol requires a specific handshake before tool calls work:

1. Client → server: `initialize` request (protocol version, capabilities, client info).
2. Server → client: `initialize` response (server capabilities, tool list metadata).
3. Client → server: `notifications/initialized` (no response).
4. Then: `tools/list`, `tools/call`, etc.

When the wrapper respawns its child mid-session, the **client doesn't re-send** `initialize` — as far as the client knows, nothing happened. So the wrapper has to:

- **Cache the original `initialize` line** the first time the client sends it (captured in `onClientLine`).
- **After spawning the new child**, write the cached line to the new child's stdin.
- **Swallow the new child's `initialize` response** — the `id` matches the cached request, and the response would confuse the client (it already has one).

This means the new child is fully ready to handle `tools/call` the moment it finishes starting, and the client is blissfully unaware.

## Project structure

```
xero-mcp-bridge/
├── .gitignore              ← Ignores xero-tokens.json, .DS_Store, *.log
├── README.md               ← This file
├── xero-auth.mjs           ← One-time PKCE browser flow, ~300 lines
├── xero-refresh.mjs        ← Token refresher + config sync, ~170 lines
├── xero-mcp-wrapper.mjs    ← Stdio proxy, ~185 lines
└── xero-tokens.json        ← [gitignored] access_token, refresh_token, expiry
```

Per-file detail:

| File | Run by | What it does |
|---|---|---|
| `xero-auth.mjs` | You, manually (first-time setup or re-auth) | Full PKCE browser flow. Generates code verifier/challenge + CSRF state, starts a local callback server on `:8765`, opens the browser to Xero's consent page, exchanges the returned auth code for access + refresh tokens, saves them to `xero-tokens.json`, prints connected tenants. |
| `xero-refresh.mjs` | launchd, every 20 min | Refreshes the access token if <5 min remaining, otherwise no-op. Idempotently writes the wrapper entry into both Claude configs (Claude Desktop's `claude_desktop_config.json` and Claude Code's `~/.claude.json`). |
| `xero-mcp-wrapper.mjs` | Claude Desktop / Claude Code | Stdio proxy. Forks `@xeroapi/xero-mcp-server` as a child with the current bearer token, pipes JSON-RPC bidirectionally, watches `xero-tokens.json` for changes, respawns the child with the new token and replays the initialize handshake. |
| `xero-tokens.json` | auto-generated | Single source of truth for the current tokens. Gitignored; never committed. |

## Environment variables

All environment variables are set either by you (interactively or in the launchd plist) or by the scripts themselves. No `.env` file is loaded.

| Variable | Required by | Default | Purpose |
|---|---|---|---|
| `XERO_CLIENT_ID` | `xero-auth.mjs`, `xero-refresh.mjs` | — | Your Xero app's client id. 32-character hex string from the Xero developer portal. Required for both initial auth and each refresh. |
| `XERO_TOKEN_FILE` | `xero-refresh.mjs` (optional) | `./xero-tokens.json` (relative to `cwd`) | Absolute path to the token file. Override only if you want to store tokens somewhere other than the project folder. |
| `XERO_CLIENT_BEARER_TOKEN` | `@xeroapi/xero-mcp-server` (set by the wrapper at spawn) | — | **Do not set this yourself.** The wrapper derives it from `xero-tokens.json` and injects it into the child's env at spawn time. |

## Commands reference

There's no package.json — everything runs under `node` directly.

| Command | When to run | Effect |
|---|---|---|
| `node xero-auth.mjs` | First-time setup, or after the refresh token dies | Full PKCE browser flow. Writes `xero-tokens.json`. |
| `node xero-auth.mjs --refresh` | Manual one-off refresh without going through launchd | Refreshes the access token using the saved refresh token. Writes `xero-tokens.json`. |
| `node xero-refresh.mjs` | Manual force-refresh + config sync | Same as `--refresh` above, plus rewrites the Claude configs to point at the wrapper. Requires `XERO_CLIENT_ID` in env. |
| `node xero-mcp-wrapper.mjs` | Never run directly; spawned by Claude | Proxies stdio between Claude and `@xeroapi/xero-mcp-server`. Running it manually does nothing useful (no client connected to stdin). |
| `launchctl kickstart -k gui/$(id -u)/com.YOUR_USERNAME.xero-mcp-bridge-refresh` | Force launchd to fire now | Same effect as waiting for the next scheduled minute. Useful after editing the plist or troubleshooting. |
| `touch xero-tokens.json` | Force the wrapper to respawn its child | Triggers the `fs.watch` handler even though the file content is unchanged — useful for simulating a rotation. |

## Day-to-day usage

**Nothing to do.** launchd refreshes the access token every 20 minutes into `xero-tokens.json`; the wrapper picks up the change and respawns the Xero MCP child transparently. Claude's end of the connection stays alive indefinitely.

You only interact with this project again if:

- You add another Mac (repeat the setup on that machine).
- Your refresh token dies from 60+ days of inactivity (re-run `xero-auth.mjs`).
- You add Xero scopes (edit `SCOPES` in `xero-auth.mjs`, enable them in the Xero app, re-run `xero-auth.mjs`).
- You want to uninstall (unload the launchd agent, delete the folder, remove the Claude config entries).

## Verifying the installation

After setup, confirm everything is wired up end-to-end:

```bash
# 1. launchd agent alive, last run exited 0
launchctl list | grep xero-mcp-bridge-refresh
# Expected: "-  0  com.YOUR_USERNAME.xero-mcp-bridge-refresh"

# 2. Recent token (saved within the last ~20 minutes)
python3 -c "import json,datetime; t=json.load(open('xero-tokens.json')); s=datetime.datetime.fromisoformat(t['saved_at'].replace('Z','+00:00')); print((datetime.datetime.now(datetime.timezone.utc)-s).total_seconds(), 'seconds old')"
# Expected: < 1200

# 3. Refresh log shows a clean first run
tail /tmp/xero-refresh.log
# Expected lines: "✅ Updated Claude Desktop config → wrapper", "✅ Updated Claude Code config → wrapper", plus "⏳ Token still valid" or "✅ New token saved"

# 4. Bearer token actually authenticates against Xero
TOKEN=$(python3 -c "import json; print(json.load(open('xero-tokens.json'))['access_token'])")
curl -s -o /dev/null -w "HTTP %{http_code}\n" -H "Authorization: Bearer $TOKEN" https://api.xero.com/connections
# Expected: HTTP 200

# 5. Wrapper is running under Claude (only when Claude Desktop/Code is open)
pgrep -fl xero-mcp-wrapper.mjs
# Expected: one or more lines referencing xero-mcp-wrapper.mjs
```

In Claude Desktop or Claude Code, ask:

> "Using the Xero MCP, list my connected Xero organisations."

You should see a tool confirmation followed by your org name(s).

To verify the rotation machinery specifically, simulate a token change:

```bash
touch ~/AI/scripts/xero-mcp-bridge/xero-tokens.json
```

Then immediately invoke a Xero tool again. It should still work — the wrapper will have SIGTERMed the child, spawned a fresh one, replayed the handshake, and resumed forwarding. Check the Claude Desktop log (`~/Library/Logs/Claude/mcp*.log`) for the wrapper's `respawning child` message.

## Troubleshooting

### Quick health check

Run this first — it hits every layer of the stack in one shot:

```bash
# 1. launchd agent alive, last run exited 0
launchctl list | grep xero-mcp-bridge-refresh

# 2. Token file fresh and non-empty (saved_at within last ~20 min)
python3 -c "import json,datetime; t=json.load(open(\"$HOME/AI/scripts/xero-mcp-bridge/xero-tokens.json\")); s=datetime.datetime.fromisoformat(t['saved_at'].replace('Z','+00:00')); print('saved', (datetime.datetime.now(datetime.timezone.utc)-s).total_seconds(), 'seconds ago')"

# 3. Refresh log — look for a recent successful rotation, not errors
tail -30 /tmp/xero-refresh.log

# 4. Bearer token actually works against Xero
TOKEN=$(python3 -c "import json; print(json.load(open(\"$HOME/AI/scripts/xero-mcp-bridge/xero-tokens.json\"))['access_token'])")
curl -s -o /dev/null -w "Xero /connections: HTTP %{http_code}\n" -H "Authorization: Bearer $TOKEN" https://api.xero.com/connections

# 5. Wrapper running under Claude (only when Claude Desktop/Code is active)
pgrep -fl xero-mcp-wrapper.mjs
```

Expect: exit status `0`, `saved <1200 seconds ago`, recent log lines with `✅` or `⏳`, HTTP `200`, at least one wrapper process when Claude apps are open.

### Symptom → cause → fix

| Symptom | Most likely cause | Fix |
|---|---|---|
| Xero tools fail in Claude Desktop/Code with auth errors | Client still holds an old MCP connection with a stale token (common right after first wrapper install) | Quit Claude Desktop (`Cmd+Q`) and reopen; start a fresh Claude Code session |
| Xero tools disappear entirely from Claude's tool list | Wrapper process died, client marked MCP disconnected | `pkill -f xero-mcp-wrapper.mjs`, restart the Claude app |
| Refresh log shows `Refresh failed (400): invalid_grant` | Refresh token expired or revoked — see **[When the refresh token dies](#when-the-refresh-token-dies)** | Re-run `xero-auth.mjs` |
| Refresh log shows `Token file not found` | launchd `WorkingDirectory` is wrong | `plutil -p ~/Library/LaunchAgents/com.YOUR_USERNAME.xero-mcp-bridge-refresh.plist` — confirm it points at `~/AI/scripts/xero-mcp-bridge` |
| `launchctl list` shows a non-zero exit | Usually `XERO_CLIENT_ID` missing or wrong Node path | `cat /tmp/xero-refresh.log`; check `EnvironmentVariables` and `ProgramArguments[0]` in the plist |
| Manual `node xero-refresh.mjs` hangs | Your Mac has no internet, or Xero identity service is down | `curl -I https://identity.xero.com/` |
| Wrapper logs `xero-mcp-wrapper: token rotated mid-request` | You caught a refresh during an in-flight tool call — expected, recoverable | Retry the tool call once |
| Wrapper keeps logging `unexpected current-child exit, recovering` in a loop | Something is killing the child (OOM, corrupt npm cache) | `rm -rf ~/.npm/_npx/*xero*` to force a clean re-download on next spawn |
| `invalid_scope` error during initial auth | Xero app doesn't have every scope `xero-auth.mjs` requests enabled | Open the app in the Xero developer portal → Configuration → Scopes → enable the full list from [step 1](#1-create-the-xero-app-one-time-2-min) |

### Manual commands

```bash
# Force a refresh + config sync right now
cd ~/AI/scripts/xero-mcp-bridge
XERO_CLIENT_ID=$YOUR_CLIENT_ID node xero-refresh.mjs

# Force launchd to fire the scheduled job immediately
launchctl kickstart -k gui/$(id -u)/com.YOUR_USERNAME.xero-mcp-bridge-refresh

# Force the wrapper to respawn its child (simulate a rotation)
touch ~/AI/scripts/xero-mcp-bridge/xero-tokens.json
```

### Where to find logs

```bash
# launchd refresh log — token rotation history
cat /tmp/xero-refresh.log

# Wrapper stderr — child pid, rotations, errors. Captured by Claude:
#   Claude Desktop: ~/Library/Logs/Claude/mcp*.log
#   Claude Code:    run `/mcp` in-session to inspect the live server
```

## Token lifecycle and maintenance

### Lifetimes

| Token | Lifespan | Renewal |
|---|---|---|
| Access token | 30 minutes (hard-coded by Xero, non-configurable) | Auto-refreshed by launchd every 20 min; wrapper respawns the MCP child on each rotation |
| Refresh token | 60 days if unused | Renewed each time it's used for a refresh — so under normal operation the chain is indefinite |

### When the refresh token dies

The refresh token only expires in these scenarios:

- Your Mac was **off or unable to reach Xero for 60+ days straight** (the laptop sat in a drawer, extended travel with no power/network).
- You **revoked the Xero app's connection** at <https://login.xero.com/identity/Connections>.
- Xero **rotated their OAuth keys** server-side (rare, but has happened).
- The `xero-tokens.json` file was **deleted or corrupted**.

You'll know because:

- `/tmp/xero-refresh.log` shows `Refresh failed (400): invalid_grant`
- Claude tools return auth errors that persist through a full Claude restart + wrapper respawn
- Step 4 of the [quick health check](#quick-health-check) returns HTTP `401`

### Re-auth steps

```bash
cd ~/AI/scripts/xero-mcp-bridge
XERO_CLIENT_ID=$YOUR_CLIENT_ID node xero-auth.mjs
```

This:

1. Starts a local listener on `http://localhost:8765/callback`
2. Opens Xero's consent page in your default browser
3. You log in and authorize the app again
4. Xero redirects back → script captures the code → exchanges for a fresh access + refresh token pair
5. Writes the new tokens to `xero-tokens.json`

Verify and nudge the wrapper:

```bash
# Verify the new tokens work
XERO_CLIENT_ID=$YOUR_CLIENT_ID node xero-refresh.mjs
tail /tmp/xero-refresh.log

# Nudge the wrapper to pick up the new token file (if Claude is already running)
touch xero-tokens.json
```

If Claude Desktop was open during re-auth, quit and reopen it to be safe — some MCP clients get stuck after a long auth failure.

**If you run this on multiple machines**, each machine has its own `xero-tokens.json`. Under normal operation each machine refreshes independently on its own launchd schedule, so both stay alive. If both were offline >60 days, re-auth on one machine and scp `xero-tokens.json` to the other.

### Preventing expiry

The only defense against 60-day expiry is keeping at least one machine online and refreshing. If you plan to be away for 2+ months, either leave a Mac powered-on and connected, or plan to re-auth when you're back — it's a 30-second task.

## Managing the launchd agent

```bash
# Unload (stop the agent)
launchctl unload ~/Library/LaunchAgents/com.YOUR_USERNAME.xero-mcp-bridge-refresh.plist

# Reload after editing the plist (launchd caches the parsed version)
launchctl unload ~/Library/LaunchAgents/com.YOUR_USERNAME.xero-mcp-bridge-refresh.plist
launchctl load ~/Library/LaunchAgents/com.YOUR_USERNAME.xero-mcp-bridge-refresh.plist

# Force a run right now (without waiting for the next scheduled minute)
launchctl kickstart -k gui/$(id -u)/com.YOUR_USERNAME.xero-mcp-bridge-refresh

# Remove completely
launchctl unload ~/Library/LaunchAgents/com.YOUR_USERNAME.xero-mcp-bridge-refresh.plist
rm ~/Library/LaunchAgents/com.YOUR_USERNAME.xero-mcp-bridge-refresh.plist
```

If you switch Node versions (new `nvm` install), update the absolute `node` path in `ProgramArguments` — launchd doesn't inherit your shell's `PATH`.

## Contributing

This is a personal utility I've published in case others hit the same wall. PRs welcome for:

- Fixes to setup instructions that didn't work for you
- Support for other schedulers (systemd user units for Linux, Task Scheduler for Windows)
- A forked MCP server that re-reads the token per request (making the wrapper unnecessary) — this would be the cleanest long-term fix but requires forking `@xeroapi/xero-mcp-server` and maintaining it

Please don't send PRs that add runtime dependencies — the "three files, Node stdlib only" shape is deliberate.

## License

MIT. Use it, fork it, improve it. No warranty — you're running untrusted (your own) OAuth token storage locally. Good luck out there.
