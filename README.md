# Xero MCP Bridge

Keep your Xero MCP connection alive in Claude Desktop and Claude Code despite Xero's 30-minute access-token rotations — and do it via OAuth 2.0 PKCE, so you don't need Xero's Custom Connections (which are only available to orgs in NZ / UK / US / Australia, leaving Canada, the EU, and elsewhere out in the cold).

This is a thin stdio proxy that wraps the official `@xeroapi/xero-mcp-server`, watches for token rotation, and transparently respawns the server with the new token. Claude never sees a disconnection.

## How it works

Xero access tokens live 30 minutes. Claude Desktop and Claude Code don't respawn stdio MCP servers when they die — so naïvely rotating the token in the config file doesn't help a running MCP process. It keeps using the stale token until the app is manually restarted.

This folder solves that with four moving parts:

1. **`xero-auth.mjs`** — one-time PKCE browser flow to get an access token + refresh token.
2. **`xero-refresh.mjs`** — refreshes the access token into `xero-tokens.json` and points both Claude configs at the wrapper (idempotent).
3. **`xero-mcp-wrapper.mjs`** — stdio proxy. Claude apps spawn this *instead* of the raw Xero MCP server. It holds the long-lived stdio connection to Claude, forks `@xeroapi/xero-mcp-server` as a child, watches `xero-tokens.json`, and transparently respawns the child with the new token on every rotation. The `initialize` handshake is cached and replayed so the client never notices.
4. **launchd agent** — runs `xero-refresh.mjs` every 20 minutes (and catches up after sleep).

```
Claude Desktop / Code ─stdio─▶ xero-mcp-wrapper.mjs ─stdio─▶ xero-mcp-server (child, restarted on token rotation)
                                       │
                                       └─ watches ─▶ xero-tokens.json ◀─ written by ─ xero-refresh.mjs ◀─ fired by ─ launchd
```

The bearer token is **never** written into a Claude config. Only the wrapper ever reads it, from the token file, at each child spawn.

## Files

| File | Purpose |
|---|---|
| `xero-auth.mjs` | Full PKCE auth flow (browser login). Run for initial setup or when refresh token dies. |
| `xero-refresh.mjs` | Refreshes access token into `xero-tokens.json` and ensures Claude configs point at the wrapper. Run by launchd. |
| `xero-mcp-wrapper.mjs` | Stdio proxy that keeps Claude's MCP connection alive across token rotations by forking/respawning the Xero MCP child. |
| `xero-tokens.json` | Auto-generated. Stores current access + refresh tokens. |

## Prerequisites

- **macOS.** The launchd agent and the Claude Desktop config paths are macOS-specific. The scripts themselves are portable; adapt to systemd / Task Scheduler on other OSes.
- **Node 18+.** Tested with Node 24 via `nvm`. The `xero-auth.mjs` script uses built-in `fetch`.
- **A Xero organisation** you can sign into, plus a developer account at <https://developer.xero.com/>.
- **Claude Desktop** and/or **Claude Code** installed — that's the consumer of the MCP server.

## Setup walkthrough

### 1. Create the Xero app (one-time, ~2 min)

1. Sign in at <https://developer.xero.com/app/manage/> with the same account that accesses your Xero org.
2. Click **New app**.
3. Fill in:
   - **App name** — anything (e.g. `My MCP Server`).
   - **Integration type** — select **Web app**. (Not Mobile/Desktop — we need PKCE with a redirect, and "Web app" supports that with the "Auth Code with PKCE" grant.)
   - **Company or application URL** — anything valid (e.g. your personal site, or `https://example.com`).
   - **Redirect URI** — exactly `http://localhost:8765/callback`. Note: This port must match what `xero-auth.mjs` listens on.
4. Accept the terms, click **Create app**.
5. On the app page, find the **Client id** (the long hex string). **Copy it** — you'll use it as `XERO_CLIENT_ID` below. There is no client secret in PKCE — you can ignore that section.
6. Under **Configuration → Scopes**, confirm the app has at minimum: `accounting.transactions`, `accounting.contacts`, `accounting.reports.read`, and `offline_access` (the last one is required to get a refresh token). Add any other scopes your use case needs.

### 2. Clone this repo and put your client id somewhere you won't lose it

```bash
git clone <this-repo-url> ~/AI/scripts/xero-mcp-bridge
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

What happens:

1. The script generates a PKCE challenge, starts a tiny HTTP server on `localhost:8765`, and opens your browser to Xero's consent page.
2. You log in to Xero and pick which organisation(s) to connect.
3. Xero redirects to `http://localhost:8765/callback?code=...` — the script grabs the code and exchanges it for an access token + refresh token.
4. Tokens are written to `xero-tokens.json` (gitignored).
5. The script prints a summary of the connected tenant(s).

If you see `Connected to: <your org name>`, you're good.

### 4. Install the launchd agent

Save this as `~/Library/LaunchAgents/com.yourname.xero-mcp-bridge-refresh.plist`, replacing both placeholders (`YOUR_USERNAME` and `YOUR_CLIENT_ID`):

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

Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.yourname.xero-mcp-bridge-refresh.plist

# Confirm: second column should be "0" (last exit status)
launchctl list | grep xero-mcp-bridge-refresh

# Confirm first run succeeded
tail /tmp/xero-refresh.log
```

### 5. Let the refresh script wire Claude up

The first run of `xero-refresh.mjs` (triggered by `RunAtLoad` above) already:

- Refreshed your access token into `xero-tokens.json`
- Wrote the wrapper entry into both Claude configs:
  - **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` → `mcpServers.Xero`
  - **Claude Code**: `~/.claude.json` → `mcpServers.xero`

Each entry looks like this (paths will use your own username):

```json
{
  "command": "/Users/YOUR_USERNAME/.nvm/versions/node/v24.14.1/bin/node",
  "args": ["/Users/YOUR_USERNAME/AI/scripts/xero-mcp-bridge/xero-mcp-wrapper.mjs"],
  "type": "stdio"
}
```

No bearer token is stored in the config — the wrapper reads it from `xero-tokens.json` at each child spawn and rotates it live.

**Restart Claude Desktop and start a new Claude Code session** so they spawn the wrapper. After that, token rotations are transparent.

### Managing the launchd agent later

```bash
# Unload (stop the agent)
launchctl unload ~/Library/LaunchAgents/com.yourname.xero-mcp-bridge-refresh.plist

# Force a run right now (without waiting for the next scheduled minute)
launchctl kickstart -k gui/$(id -u)/com.yourname.xero-mcp-bridge-refresh
```

After editing the plist, **`unload` then `load`** — launchd caches the parsed version.

If you switch Node versions (e.g. new nvm install), update the absolute `node` path in `ProgramArguments` — launchd doesn't inherit your shell's `PATH`.

## Day-to-Day Usage

**Nothing to do.** launchd refreshes the access token every 20 minutes into `xero-tokens.json`; the wrapper picks up the change and respawns the Xero MCP child transparently. Claude's end of the connection stays alive indefinitely.

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
| Xero tools fail in Claude Desktop/Code with auth errors | Client still holds the old MCP connection with a stale token (common right after first wrapper install) | Quit Claude Desktop (Cmd+Q) and reopen; start a fresh Claude Code session |
| Xero tools disappear entirely from Claude's tool list | Wrapper process died, client marked MCP disconnected | `pkill -f xero-mcp-wrapper.mjs`, restart the Claude app |
| Refresh log shows `Refresh failed (400): invalid_grant` | Refresh token expired or revoked — see **"When the refresh token dies"** below | Re-run `xero-auth.mjs` |
| Refresh log shows `Token file not found` | launchd `WorkingDirectory` is wrong | `plutil -p ~/Library/LaunchAgents/com.yourname.xero-mcp-bridge-refresh.plist` — confirm it points at `~/AI/scripts/xero-mcp-bridge` |
| `launchctl list` shows a non-zero exit | Usually `XERO_CLIENT_ID` missing or wrong Node path | `cat /tmp/xero-refresh.log`; check `EnvironmentVariables` and `ProgramArguments[0]` in the plist |
| Manual `node xero-refresh.mjs` hangs | Your Mac has no internet, or Xero identity service is down | `curl -I https://identity.xero.com/` |
| Wrapper logs `xero-mcp-wrapper: token rotated mid-request` | You caught a refresh during an in-flight tool call — expected, recoverable | Retry the tool call once |
| Wrapper keeps logging `unexpected current-child exit, recovering` in a loop | Something is killing the child (OOM, corrupt npm cache) | `rm -rf ~/.npm/_npx/*xero*` to force a clean re-download on next spawn |

### Manual commands

```bash
# Force a refresh + config sync right now
cd ~/AI/scripts/xero-mcp-bridge
XERO_CLIENT_ID=$YOUR_CLIENT_ID node xero-refresh.mjs

# Force launchd to fire the scheduled job immediately
launchctl kickstart -k gui/$(id -u)/com.yourname.xero-mcp-bridge-refresh

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

## When the refresh token dies

Xero refresh tokens expire **60 days after their last use**. Every time `xero-refresh.mjs` runs against a live refresh token it gets a new one (with a fresh 60-day clock), so under normal operation the refresh chain never expires — launchd fires every 20 minutes.

### When it actually happens

The refresh token only dies in these scenarios:

- Your Mac was **off or unable to reach Xero for 60+ days straight** (the laptop sat in a drawer, extended travel with no power/network).
- You **revoked the Xero app's connection** at https://login.xero.com/identity/Connections.
- Xero **rotated their OAuth keys** server-side (rare, but has happened).
- The `xero-tokens.json` file was **deleted or corrupted**.

### How you'll know

One of:

- `/tmp/xero-refresh.log` shows `Refresh failed (400): invalid_grant`
- Claude tools return auth errors that persist through a full Claude restart + wrapper respawn
- Step 4 of the quick health check returns HTTP `401`

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

Then:

```bash
# Verify the new tokens work
XERO_CLIENT_ID=$YOUR_CLIENT_ID node xero-refresh.mjs
tail /tmp/xero-refresh.log

# Nudge the wrapper to pick up the new token file (if Claude is already running)
touch xero-tokens.json
```

If Claude Desktop was open during re-auth, quit and reopen it to be safe — some MCP clients get stuck after a long auth failure.

**Do this on both the MacBook and the Mac Mini** if both were down >60 days, since each machine has its own `xero-tokens.json`. (Under normal operation only one needs re-auth — whichever hit the refresh window first — and you'd then copy `xero-tokens.json` to the other.)

### Preventing it

The only defense against 60-day expiry is keeping at least one machine online and refreshing. If you plan to be away for 2+ months, either leave a Mac powered-on and connected, or plan to re-auth when you're back — it's a 30-second task.

## Token Lifecycle

| Token | Lifespan | Renewal |
|---|---|---|
| Access token | 30 minutes (hard-coded by Xero, non-configurable) | Auto-refreshed by launchd every 20 min; wrapper respawns the MCP child on each rotation |
| Refresh token | 60 days if unused | Renewed each time it's used for a refresh |

### Why the wrapper exists

`@xeroapi/xero-mcp-server` reads `XERO_CLIENT_BEARER_TOKEN` once at module load and bakes it into the `XeroClient` instance. It has no hot-reload path. Combined with Xero's 30-minute access-token ceiling and Claude Desktop's lack of an MCP-server watchdog, naïve approaches (rotating the config, killing the child) all fail.

The wrapper is the only shape that actually works without user intervention: stay alive on stdio, respawn the child internally, replay `initialize`, keep going.

## License

MIT. Use it, fork it, improve it. No warranty — you're running untrusted (your own) OAuth token storage locally. Good luck out there.