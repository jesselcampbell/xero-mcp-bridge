#!/usr/bin/env node

/**
 * Xero MCP Wrapper — stdio proxy with hot-reload of bearer token.
 *
 * Why this exists:
 *   The official @xeroapi/xero-mcp-server reads XERO_CLIENT_BEARER_TOKEN
 *   once at module import. Xero access tokens live 30 minutes. Claude
 *   Desktop and Claude Code do not respawn stdio MCP servers when they
 *   die, so rotating the token in the config file doesn't help a running
 *   MCP process — it just keeps using the stale token until the app is
 *   manually restarted.
 *
 * What this does:
 *   - Holds the stdio connection to the Claude client.
 *   - Spawns @xeroapi/xero-mcp-server as a child with the current token.
 *   - Pipes JSON-RPC between client and child.
 *   - Watches xero-tokens.json. On change, SIGTERMs the child and spawns
 *     a fresh one with the new token, replaying the cached `initialize`
 *     handshake so the client never notices.
 *
 * Usage (via Claude config):
 *   "xero": {
 *     "type": "stdio",
 *     "command": "/path/to/node",
 *     "args": ["/path/to/xero-mcp-wrapper.mjs"]
 *   }
 *
 * Logs to stderr (visible in Claude Desktop's MCP log, or /tmp/xero-mcp-wrapper.log
 * if stderr is redirected).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(HERE, "xero-tokens.json");
const CHILD_CMD = "npx";
const CHILD_ARGS = ["-y", "@xeroapi/xero-mcp-server@latest"];

function log(...args) {
  const ts = new Date().toISOString();
  process.stderr.write(`[xero-wrapper ${ts}] ${args.join(" ")}\n`);
}

function readToken() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, "utf-8");
    return JSON.parse(raw).access_token;
  } catch (err) {
    log("FATAL: could not read token file:", err.message);
    process.exit(1);
  }
}

// ─── State ───────────────────────────────────────────────────────────────
let child = null;
let childStdoutRl = null;
let cachedInitLine = null;        // raw JSON line of the client's `initialize` request
let cachedInitId = null;          // id field from that request (for swallow-match)
let swallowReplayResponse = false;
let pendingRequestIds = new Set();
let shuttingDown = false;

// ─── Child lifecycle ─────────────────────────────────────────────────────
function spawnChild() {
  const token = readToken();
  const me = spawn(CHILD_CMD, CHILD_ARGS, {
    env: { ...process.env, XERO_CLIENT_BEARER_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true, // new process group, so we can kill the whole tree
  });
  child = me;
  log(`spawned child pid=${me.pid} (token ends …${token.slice(-12)})`);

  me.stderr.on("data", (d) => {
    const s = d.toString().trimEnd();
    if (s) process.stderr.write(`[xero-child ${me.pid}] ${s}\n`);
  });

  const rl = readline.createInterface({ input: me.stdout });
  rl.on("line", onChildLine);
  childStdoutRl = rl;

  me.on("exit", (code, signal) => {
    log(`child pid=${me.pid} exited code=${code} signal=${signal}`);
    // If we've already replaced this child (normal rotation), ignore its exit.
    if (child !== me) return;
    child = null;
    childStdoutRl = null;
    if (shuttingDown) return;
    // Unexpected death of the *current* child — try once to recover.
    log("unexpected current-child exit, recovering in 500ms");
    setTimeout(() => {
      if (!child && !shuttingDown) respawnChild();
    }, 500);
  });
}

function killChildTree() {
  if (!child) return;
  try {
    // Negative PID = process group (we spawned with detached:true)
    process.kill(-child.pid, "SIGTERM");
  } catch (err) {
    // Fallback to direct kill if group-kill fails
    try { child.kill("SIGTERM"); } catch {}
  }
}

function respawnChild() {
  log("respawning child (token rotation or recovery)");
  killChildTree();

  // Error out any in-flight requests so the client doesn't hang forever
  for (const id of pendingRequestIds) {
    writeToClient({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: "xero-mcp-wrapper: token rotated mid-request, please retry",
      },
    });
  }
  pendingRequestIds.clear();

  spawnChild();

  if (cachedInitLine) {
    swallowReplayResponse = true;
    child.stdin.write(cachedInitLine + "\n");
    log("replayed initialize to new child");
  }
}

// ─── Message plumbing ────────────────────────────────────────────────────
function writeToClient(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function onChildLine(line) {
  if (!line.trim()) return;

  // Swallow the response to our replayed initialize — client already has one
  if (swallowReplayResponse) {
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && msg.id === cachedInitId) {
        swallowReplayResponse = false;
        log("swallowed replay initialize response");
        return;
      }
    } catch {}
  }

  // Forward everything else
  process.stdout.write(line + "\n");

  // Track completed requests (has id + result/error)
  try {
    const msg = JSON.parse(line);
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      pendingRequestIds.delete(msg.id);
    }
  } catch {}
}

function onClientLine(line) {
  if (!line.trim()) return;

  try {
    const msg = JSON.parse(line);
    // Capture initialize for future replay on respawn
    if (msg.method === "initialize" && msg.id != null) {
      cachedInitLine = line;
      cachedInitId = msg.id;
    }
    if (msg.id != null) pendingRequestIds.add(msg.id);
  } catch {}

  if (!child) spawnChild();
  child.stdin.write(line + "\n");
}

// ─── Token file watcher (debounced) ──────────────────────────────────────
let watchTimer = null;
let lastTokenSeen = null;

function watchTokenFile() {
  try { lastTokenSeen = readToken(); } catch {}
  fs.watch(TOKEN_FILE, () => {
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      let fresh;
      try { fresh = readToken(); } catch { return; }
      if (fresh && fresh !== lastTokenSeen) {
        lastTokenSeen = fresh;
        respawnChild();
      }
    }, 300);
  });
}

// ─── Startup ─────────────────────────────────────────────────────────────
log("starting, token file:", TOKEN_FILE);

spawnChild();
watchTokenFile();

const clientRl = readline.createInterface({ input: process.stdin });
clientRl.on("line", onClientLine);
clientRl.on("close", () => {
  log("client stdin closed, shutting down");
  shuttingDown = true;
  killChildTree();
  setTimeout(() => process.exit(0), 200);
});

process.on("SIGTERM", () => { shuttingDown = true; killChildTree(); process.exit(0); });
process.on("SIGINT",  () => { shuttingDown = true; killChildTree(); process.exit(0); });
