#!/usr/bin/env node

/**
 * Xero PKCE OAuth 2.0 Token Helper
 * 
 * Runs the full PKCE flow to get a bearer token for the Xero MCP server.
 * Usage:
 *   1. Set your XERO_CLIENT_ID env var or pass it as an argument
 *   2. Run: node xero-auth.mjs
 *   3. Browser opens -> log in to Xero -> authorize
 *   4. Tokens are saved to ./xero-tokens.json
 *   5. Use the access_token as XERO_CLIENT_BEARER_TOKEN
 * 
 * To refresh an expired token:
 *   node xero-auth.mjs --refresh
 */

import http from "node:http";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ── Config ──────────────────────────────────────────────────────────────
const CLIENT_ID = process.env.XERO_CLIENT_ID || process.argv.find(a => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]);
const REDIRECT_URI = "http://localhost:8765/callback";
const TOKEN_FILE = path.join(process.cwd(), "xero-tokens.json");

const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.invoices",
  "accounting.invoices.read",
  "accounting.payments",
  "accounting.payments.read",
  "accounting.banktransactions",
  "accounting.banktransactions.read",
  "accounting.manualjournals",
  "accounting.manualjournals.read",
  "accounting.reports.aged.read",
  "accounting.reports.balancesheet.read",
  "accounting.reports.profitandloss.read",
  "accounting.reports.trialbalance.read",
  "accounting.contacts",
  "accounting.settings",
  "payroll.settings",
  "payroll.employees",
  "payroll.timesheets",
].join(" ");

// ── PKCE helpers ────────────────────────────────────────────────────────
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function generateState() {
  return crypto.randomBytes(16).toString("hex");
}

// ── Token persistence ───────────────────────────────────────────────────
function saveTokens(tokens) {
  tokens.saved_at = new Date().toISOString();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log(`\n✅ Tokens saved to ${TOKEN_FILE}`);
}

function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
}

// ── Token exchange ──────────────────────────────────────────────────────
async function exchangeCodeForTokens(code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${errText}`);
  }
  return res.json();
}

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
    throw new Error(`Token refresh failed (${res.status}): ${errText}`);
  }
  return res.json();
}

// ── Get connected tenant ID ─────────────────────────────────────────────
async function getConnections(accessToken) {
  const res = await fetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Connections request failed (${res.status}): ${errText}`);
  }
  return res.json();
}

// ── Open browser (cross-platform) ───────────────────────────────────────
function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === "darwin") execSync(`open "${url}"`);
    else if (platform === "win32") execSync(`start "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {
    console.log(`\n⚠️  Could not auto-open browser. Open this URL manually:\n${url}\n`);
  }
}

// ── Refresh flow ────────────────────────────────────────────────────────
async function handleRefresh() {
  const tokens = loadTokens();
  if (!tokens?.refresh_token) {
    console.error("❌ No saved refresh_token found. Run without --refresh first.");
    process.exit(1);
  }

  console.log("🔄 Refreshing access token...");
  const newTokens = await refreshAccessToken(tokens.refresh_token);
  saveTokens(newTokens);
  printTokenSummary(newTokens);
  process.exit(0);
}

// ── Print summary ───────────────────────────────────────────────────────
function printTokenSummary(tokens) {
  console.log("\n────────────────────────────────────────────────────────");
  console.log("🔑 ACCESS TOKEN (use as XERO_CLIENT_BEARER_TOKEN):\n");
  console.log(tokens.access_token);
  console.log("\n────────────────────────────────────────────────────────");
  console.log(`⏰ Expires in: ${tokens.expires_in} seconds`);
  if (tokens.refresh_token) {
    console.log(`🔁 Refresh token saved (run with --refresh to renew)`);
  }
  console.log("────────────────────────────────────────────────────────\n");

  console.log("📋 Claude Desktop config snippet:\n");
  console.log(JSON.stringify({
    mcpServers: {
      xero: {
        command: "npx",
        args: ["-y", "@xeroapi/xero-mcp-server@latest"],
        env: {
          XERO_CLIENT_BEARER_TOKEN: tokens.access_token,
        },
      },
    },
  }, null, 2));
}

// ── Main auth flow ──────────────────────────────────────────────────────
async function main() {
  if (!CLIENT_ID) {
    console.error("❌ Set XERO_CLIENT_ID env var or pass it as an argument.");
    console.error("   Usage: XERO_CLIENT_ID=abc123 node xero-auth.mjs");
    process.exit(1);
  }

  if (process.argv.includes("--refresh")) {
    return handleRefresh();
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const authUrl = new URL("https://login.xero.com/identity/connect/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  console.log("🚀 Starting Xero PKCE auth flow...\n");
  console.log(`   Client ID:    ${CLIENT_ID}`);
  console.log(`   Redirect URI: ${REDIRECT_URI}`);
  console.log(`   Scopes:       ${SCOPES.split(" ").length} scopes requested\n`);

  // Start local callback server
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:8765`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Auth Error</h1><p>${error}</p>`);
        server.close();
        console.error(`❌ Auth error: ${error}`);
        resolve();
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>State Mismatch</h1><p>Possible CSRF attack.</p>`);
        server.close();
        console.error("❌ State mismatch - possible CSRF.");
        resolve();
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>No Code</h1><p>No authorization code received.</p>`);
        server.close();
        resolve();
        return;
      }

      // Exchange code for tokens
      try {
        console.log("🔄 Exchanging authorization code for tokens...");
        const tokens = await exchangeCodeForTokens(code, codeVerifier);
        saveTokens(tokens);

        // Get connections (tenant IDs)
        console.log("🔍 Fetching connected Xero tenants...");
        const connections = await getConnections(tokens.access_token);
        console.log(`\n📌 Connected tenants:`);
        connections.forEach((c, i) => {
          console.log(`   ${i + 1}. ${c.tenantName || c.tenantId} (${c.tenantType})`);
        });

        printTokenSummary(tokens);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html>
            <body style="font-family: system-ui; max-width: 600px; margin: 80px auto; text-align: center;">
              <h1>✅ Xero Auth Successful</h1>
              <p>Tokens saved. You can close this tab and return to the terminal.</p>
              <p style="color: #666; font-size: 14px; margin-top: 24px;">
                Connected to: ${connections.map(c => c.tenantName || c.tenantId).join(", ")}
              </p>
            </body>
          </html>
        `);
      } catch (err) {
        console.error(`❌ ${err.message}`);
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<h1>Token Exchange Error</h1><pre>${err.message}</pre>`);
      }

      server.close();
      resolve();
    });

    server.listen(8765, () => {
      console.log("🌐 Callback server listening on http://localhost:8765");
      console.log("📱 Opening browser for Xero login...\n");
      openBrowser(authUrl.toString());
    });
  });
}

main().catch(console.error);
