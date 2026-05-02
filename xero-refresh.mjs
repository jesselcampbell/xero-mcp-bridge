#!/usr/bin/env node

/**
 * Xero Token Auto-Refresh + Claude Config Updater
 *
 * Reads saved tokens, refreshes if needed, and updates
 * both Claude Desktop and Claude Code configs with the new bearer token.
 *
 * Run via launchd every 20 minutes to keep token alive:
 *   XERO_CLIENT_ID=your_id /path/to/node /path/to/xero-refresh.mjs
 *
 * Or run manually: XERO_CLIENT_ID=abc123 node xero-refresh.mjs
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const CLIENT_ID = process.env.XERO_CLIENT_ID;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = process.env.XERO_TOKEN_FILE || path.join(process.cwd(), "xero-tokens.json");
const WRAPPER_PATH = path.join(HERE, "xero-mcp-wrapper.mjs");
// Prefer XERO_NODE_BIN (a stable symlink like /opt/homebrew/bin/node) over
// process.execPath (which resolves to a versioned realpath that breaks on upgrades).
const NODE_BIN = process.env.XERO_NODE_BIN || process.execPath;
const CLAUDE_DESKTOP_CONFIG = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
const CLAUDE_CODE_CONFIG = path.join(os.homedir(), ".claude.json");

if (!CLIENT_ID) {
  console.error("❌ XERO_CLIENT_ID not set");
  process.exit(1);
}

// ── Load tokens ─────────────────────────────────────────────────────────
function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error(`❌ Token file not found: ${TOKEN_FILE}`);
    console.error("   Run xero-auth.mjs first to complete initial auth.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
}

// ── Check if token needs refresh ────────────────────────────────────────
function needsRefresh(tokens) {
  if (!tokens.saved_at || !tokens.expires_in) return true;
  const savedAt = new Date(tokens.saved_at).getTime();
  const expiresAt = savedAt + (tokens.expires_in * 1000);
  const now = Date.now();
  // Refresh if less than 5 minutes remaining
  return (expiresAt - now) < (5 * 60 * 1000);
}

// ── Refresh token ───────────────────────────────────────────────────────
async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Refresh failed (${res.status}): ${errText}`);
  }
  return res.json();
}

// ── Ensure Claude configs point at the wrapper (idempotent) ─────────────
//
// The wrapper reads xero-tokens.json itself on spawn and watches for
// changes, so the Claude configs only need to be set once — no bearer
// token lives in the config anymore.

function wrapperEntry({ includeType }) {
  const entry = {
    command: NODE_BIN,
    args: [WRAPPER_PATH],
  };
  if (includeType) entry.type = "stdio"; // Claude Code requires this field
  return entry;
}

function entriesMatch(a, b) {
  return a && b &&
    a.command === b.command &&
    JSON.stringify(a.args) === JSON.stringify(b.args) &&
    (a.type ?? null) === (b.type ?? null) &&
    // reject any lingering env.XERO_CLIENT_BEARER_TOKEN from the old setup
    !(a.env && "XERO_CLIENT_BEARER_TOKEN" in a.env);
}

function updateClaudeDesktopConfig() {
  let config = {};
  if (fs.existsSync(CLAUDE_DESKTOP_CONFIG)) {
    config = JSON.parse(fs.readFileSync(CLAUDE_DESKTOP_CONFIG, "utf-8"));
  }
  if (!config.mcpServers) config.mcpServers = {};

  const desired = wrapperEntry({ includeType: false });
  if (entriesMatch(config.mcpServers.Xero, desired)) {
    console.log(`✓ Claude Desktop config already points at wrapper`);
    return;
  }
  config.mcpServers.Xero = desired;
  fs.writeFileSync(CLAUDE_DESKTOP_CONFIG, JSON.stringify(config, null, 2));
  console.log(`✅ Updated Claude Desktop config → wrapper`);
}

function updateClaudeCodeConfig() {
  let config = {};
  if (fs.existsSync(CLAUDE_CODE_CONFIG)) {
    config = JSON.parse(fs.readFileSync(CLAUDE_CODE_CONFIG, "utf-8"));
  }
  if (!config.mcpServers) config.mcpServers = {};

  const desired = wrapperEntry({ includeType: true });
  if (entriesMatch(config.mcpServers.xero, desired)) {
    console.log(`✓ Claude Code config already points at wrapper`);
    return;
  }
  config.mcpServers.xero = desired;
  fs.writeFileSync(CLAUDE_CODE_CONFIG, JSON.stringify(config, null, 2));
  console.log(`✅ Updated Claude Code config → wrapper`);
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const tokens = loadTokens();

  // Always ensure configs point at the wrapper (idempotent no-op if already set)
  updateClaudeDesktopConfig();
  updateClaudeCodeConfig();

  if (!needsRefresh(tokens)) {
    const savedAt = new Date(tokens.saved_at).getTime();
    const expiresAt = savedAt + (tokens.expires_in * 1000);
    const remaining = Math.round((expiresAt - Date.now()) / 60000);
    console.log(`⏳ Token still valid (~${remaining} min remaining). No refresh needed.`);
    return;
  }

  if (!tokens.refresh_token) {
    console.error("❌ No refresh_token available. Re-run xero-auth.mjs for full auth.");
    process.exit(1);
  }

  console.log("🔄 Refreshing Xero access token...");
  const newTokens = await refreshAccessToken(tokens.refresh_token);
  newTokens.saved_at = new Date().toISOString();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(newTokens, null, 2));
  console.log(`✅ New token saved to ${TOKEN_FILE}`);
  console.log(`⏰ New token expires in ${newTokens.expires_in} seconds`);
  console.log(`   (Wrapper will detect the file change and respawn the Xero MCP child transparently.)`);
}

main().catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
