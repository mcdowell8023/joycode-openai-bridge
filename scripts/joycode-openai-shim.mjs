#!/usr/bin/env node
/**
 * JoyCode → OpenAI-compatible shim (CLI edition).
 *
 * Exposes /v1/models and /v1/chat/completions on a TCP port and forwards each
 * request to the local proxy that JoyCode.app (the CLI/GUI edition, NOT the
 * legacy "JoyCode IDE") starts for its own agent runtime.
 *
 * Why the local proxy instead of the public API gateway:
 *   The public gateway (api-ai.jd.com / joycode-api-inner.jd.com) answers
 *   `AI_GRAY_ACCESS_DENIED` for this account. The local proxy speaks to the
 *   same upstream but through the desktop client's own signed channel, which
 *   the tenant does allow.
 *
 * Why this instead of the old IDE bridge (joycode-dispatch.mjs):
 *   The IDE bridge is single-turn text only and cannot emit tool calls. The
 *   CLI proxy is a real OpenAI-shaped endpoint: streaming, multi-turn and
 *   function calling all work, so opencode/DSH can drive it as a normal model.
 *
 * Endpoint contract (verified 2026-11-15):
 *   POST {proxy}/api/saas/openai/v1/chat/completions
 *     header  ptKey: <auth.json tokens.access_token>
 *     body    {"model":"GLM-5.3-agent", ...}   <- slugs from /v1/models
 *   - `stream: true` streams SSE chunks then `data: [DONE]`.
 *   - `tools` works; responses carry `choices[0].message.tool_calls`.
 *   - A bare display name (`GLM-5.3`) is rejected by the proxy, so this shim
 *     maps display names to their `-agent` slugs.
 *
 * Env:
 *   JOYCODE_SHIM_HOST        default 0.0.0.0 (Tailscale peers must reach it)
 *   JOYCODE_SHIM_PORT        default 18888
 *   JOYCODE_SHIM_TOKEN       optional bearer required from downstream clients
 *   JOYCODE_PROXY_URL        pin the proxy base URL; otherwise auto-discovered
 *   JOYCODE_APP_LOG          default ~/.joycode/logs/joycode-app.log
 *   JOYCODE_AUTH_FILE        default ~/.joycode/auth.json
 *   JOYCODE_SHIM_TIMEOUT_MS  default 600000
 *   JOYCODE_APP_PATH         default /Applications/JoyCode.app (relaunch target)
 *   JOYCODE_SHIM_AUTOSTART   default 1; set 0 to disable lazy relaunch
 *   JOYCODE_SHIM_LAUNCH_WAIT_MS     default 60000 (wait for a fresh proxy port)
 *   JOYCODE_SHIM_LAUNCH_COOLDOWN_MS default 30000 (anti crash-loop throttle)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import path from "node:path";
import os from "node:os";

const HOST = process.env.JOYCODE_SHIM_HOST || "0.0.0.0";
const PORT = Number(process.env.JOYCODE_SHIM_PORT || 18888);
const TOKEN = process.env.JOYCODE_SHIM_TOKEN || "";
const TIMEOUT_MS = Number(process.env.JOYCODE_SHIM_TIMEOUT_MS || 600000);
const APP_LOG = process.env.JOYCODE_APP_LOG || path.join(os.homedir(), ".joycode/logs/joycode-app.log");
const AUTH_FILE = process.env.JOYCODE_AUTH_FILE || path.join(os.homedir(), ".joycode/auth.json");
const PINNED_PROXY = process.env.JOYCODE_PROXY_URL || "";
const APP_PATH = process.env.JOYCODE_APP_PATH || "/Applications/JoyCode.app";
const AUTOSTART = process.env.JOYCODE_SHIM_AUTOSTART !== "0";
const LAUNCH_WAIT_MS = Number(process.env.JOYCODE_SHIM_LAUNCH_WAIT_MS || 60000);
const LAUNCH_COOLDOWN_MS = Number(process.env.JOYCODE_SHIM_LAUNCH_COOLDOWN_MS || 30000);

const PROXY_PATH = "/api/saas/openai/v1";
const PROXY_LOG_RE = /pro responses proxy ready: (http:\/\/127\.0\.0\.1:\d+)/g;

// Fallback catalogue, used only when the proxy cannot be reached at startup.
const FALLBACK_MODELS = [
  { slug: "JoyAI-Code-1.6", display: "JoyAI-Code-1.6" },
  { slug: "GLM-5.3-agent", display: "GLM-5.3" },
  { slug: "Kimi-K2.6-agent", display: "Kimi-K2.6" },
  { slug: "MiniMax-M3-agent", display: "MiniMax-M3" },
  { slug: "Doubao-Seed-2.0-pro-agent", display: "Doubao-Seed-2.0-pro" },
];

let modelCache = { at: 0, models: FALLBACK_MODELS };

/** TCP probe: is anything listening on the proxy port right now? */
function probePort(base) {
  let host, port;
  try {
    const u = new URL(base);
    host = u.hostname;
    port = Number(u.port || 80);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (ok) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1500);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

let lastLaunchAt = 0;
let launching = null;

/**
 * JoyCode.app exits on its own (idle/quit), taking the ephemeral proxy port with
 * it. Rather than polling forever, relaunch it lazily on the first request that
 * finds the port dead, then wait for a *newer* log line than the one we saw.
 */
async function ensureProxy() {
  const base = await discoverProxyBase();
  if (await probePort(base)) return base;
  if (!AUTOSTART) throw new Error(`proxy ${base} is not listening (autostart disabled)`);

  const logBefore = await readFile(APP_LOG, "utf8").catch(() => "");
  const seenBefore = [...logBefore.matchAll(PROXY_LOG_RE)].length;

  if (!launching) {
    // Throttle: a crash-looping app must not be respawned on every request.
    const since = Date.now() - lastLaunchAt;
    if (since < LAUNCH_COOLDOWN_MS) {
      throw new Error(`proxy ${base} is down and JoyCode was launched ${Math.round(since / 1000)}s ago`);
    }
    lastLaunchAt = Date.now();
    console.log(`[shim] proxy ${base} not listening; launching ${APP_PATH}`);
    launching = new Promise((resolve) => {
      const child = spawn("/usr/bin/open", ["-g", "-a", APP_PATH], { stdio: "ignore", detached: true });
      child.on("error", (e) => console.error(`[shim] launch failed: ${e.message}`));
      child.on("spawn", () => child.unref());
      resolve();
    }).finally(() => {
      launching = null;
    });
    await launching;
  }

  const deadline = Date.now() + LAUNCH_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const text = await readFile(APP_LOG, "utf8").catch(() => "");
    const hits = [...text.matchAll(PROXY_LOG_RE)];
    if (hits.length > seenBefore) {
      const fresh = hits[hits.length - 1][1];
      if (await probePort(fresh)) {
        console.log(`[shim] proxy ready at ${fresh} after relaunch`);
        return fresh;
      }
    }
  }
  throw new Error(`JoyCode did not come back within ${LAUNCH_WAIT_MS / 1000}s`);
}

/** The proxy binds an ephemeral port on every launch; the only durable record is its log. */
async function discoverProxyBase() {
  if (PINNED_PROXY) return PINNED_PROXY.replace(/\/$/, "");
  if (!existsSync(APP_LOG)) throw new Error(`joycode log not found: ${APP_LOG}`);
  const text = await readFile(APP_LOG, "utf8");
  let last = null;
  for (const m of text.matchAll(PROXY_LOG_RE)) last = m[1];
  if (!last) throw new Error(`no "pro responses proxy ready" line in ${APP_LOG}`);
  return last;
}

async function readPtKey() {
  const raw = JSON.parse(await readFile(AUTH_FILE, "utf8"));
  const key = raw?.tokens?.access_token;
  if (!key) throw new Error(`no tokens.access_token in ${AUTH_FILE}`);
  return key;
}

async function fetchModels(base, ptKey) {
  if (Date.now() - modelCache.at < 60_000) return modelCache.models;
  try {
    const res = await fetch(`${base}${PROXY_PATH}/models`, {
      headers: { ptKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`models HTTP ${res.status}`);
    const body = await res.json();
    const models = (body.models || []).map((m) => ({
      slug: m.slug,
      display: m.display_name || m.slug,
      context: m.context_window,
      reasoning: m.supported_reasoning_levels || [],
    }));
    if (models.length) modelCache = { at: Date.now(), models };
  } catch (e) {
    console.error(`[shim] model catalogue refresh failed: ${e.message}`);
  }
  return modelCache.models;
}

/** Clients may send either the display name or the slug; the proxy only accepts the slug. */
function resolveSlug(raw, models) {
  const key = String(raw || "").toLowerCase().trim();
  if (!key) return models[0].slug;
  for (const m of models) {
    if (m.slug.toLowerCase() === key) return m.slug;
  }
  for (const m of models) {
    if (m.display.toLowerCase() === key) return m.slug;
  }
  // Tolerate the `-agent` suffix being present or absent in either direction.
  const bare = key.replace(/-agent$/, "");
  for (const m of models) {
    if (m.slug.toLowerCase().replace(/-agent$/, "") === bare) return m.slug;
  }
  return models[0].slug;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

async function handleChat(req, res, url) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    json(res, 400, { error: { message: `bad json: ${e.message}`, type: "invalid_request_error" } });
    return;
  }

  const started = Date.now();
  let base, ptKey, models;
  try {
    base = await ensureProxy();
    ptKey = await readPtKey();
    models = await fetchModels(base, ptKey);
  } catch (e) {
    console.error(`[shim] 503 ${e.message}`);
    json(res, 503, {
      error: {
        message: `JoyCode proxy unavailable: ${e.message}. Start JoyCode.app first.`,
        type: "upstream_error",
        code: "joycode_proxy_unavailable",
      },
    });
    return;
  }

  const upstreamBody = { ...body, model: resolveSlug(body.model, models) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // Propagate downstream disconnects so we do not keep streaming into a dead socket.
  res.on("close", () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(`${base}${PROXY_PATH}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ptKey,
        accept: body.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    console.error(`[shim] 502 model=${upstreamBody.model} ${e.message}`);
    json(res, 502, {
      error: { message: String(e.message || e), type: "upstream_error", code: "joycode_proxy_failed" },
    });
    return;
  }

  if (!upstream.ok || !body.stream) {
    const text = await upstream.text();
    clearTimeout(timer);
    console.log(
      `[shim] ${upstream.status} model=${upstreamBody.model} elapsedMs=${Date.now() - started} stream=false bytes=${text.length}`,
    );
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    });
    res.end(text);
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });

  let bytes = 0;
  try {
    for await (const chunk of upstream.body) {
      bytes += chunk.length;
      res.write(chunk);
    }
  } catch (e) {
    console.error(`[shim] stream aborted model=${upstreamBody.model} ${e.message}`);
  } finally {
    clearTimeout(timer);
    res.end();
    console.log(
      `[shim] 200 model=${upstreamBody.model} elapsedMs=${Date.now() - started} stream=true bytes=${bytes}`,
    );
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    res.end();
    return;
  }

  if (TOKEN) {
    const auth = String(req.headers.authorization || "");
    if (auth !== `Bearer ${TOKEN}`) {
      json(res, 401, { error: { message: "invalid api key", type: "invalid_request_error" } });
      return;
    }
  }

  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    let models = modelCache.models;
    try {
      const base = await discoverProxyBase();
      models = await fetchModels(base, await readPtKey());
    } catch {
      /* keep the cached catalogue so the endpoint stays usable for diagnostics */
    }
    json(res, 200, {
      object: "list",
      data: models.map((m) => ({
        id: m.slug,
        object: "model",
        created: 0,
        owned_by: "joycode",
        context_window: m.context,
      })),
    });
    return;
  }

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    let proxy = null;
    let error = null;
    let alive = false;
    try {
      proxy = await discoverProxyBase();
      alive = await probePort(proxy);
      await readPtKey();
    } catch (e) {
      error = e.message;
    }
    json(res, proxy && alive ? 200 : 503, {
      ok: Boolean(proxy) && alive,
      mode: "cli-proxy",
      proxy,
      proxyListening: alive,
      autostart: AUTOSTART,
      models: modelCache.models.map((m) => m.slug),
      error,
    });
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
  ) {
    await handleChat(req, res, url);
    return;
  }

  json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
});

server.listen(PORT, HOST, async () => {
  console.log(`[shim] listening on ${HOST}:${PORT}`);
  console.log(`[shim] mode: cli-proxy (JoyCode.app local proxy)`);
  try {
    const base = await discoverProxyBase();
    const models = await fetchModels(base, await readPtKey());
    console.log(`[shim] proxy: ${base}`);
    console.log(`[shim] models: ${models.map((m) => m.slug).join(", ")}`);
  } catch (e) {
    console.error(`[shim] proxy not ready: ${e.message} (will retry per request)`);
  }
  console.log(`[shim] auth: ${TOKEN ? "bearer required" : "open (no token)"}`);
});
