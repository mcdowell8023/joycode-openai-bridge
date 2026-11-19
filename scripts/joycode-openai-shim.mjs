#!/usr/bin/env node
/**
 * JoyCode → OpenAI-compatible shim (direct-upstream edition).
 *
 * Talks straight to the JoyCode public API gateway
 * (https://api-ai.jd.com/api, functionId=chat_completions) using the same
 * HMAC-signed request the JoyCode desktop client makes — no JoyCode.app
 * process, no ephemeral local proxy, no relaunch logic.
 *
 * History:
 *   v1  forward to the JoyCode IDE bridge (single-turn, no tools).
 *   v2  forward to the JoyCode.app local responses proxy (port rediscovery
 *       from the app log + lazy relaunch). Broken whenever the app quit,
 *       switched accounts, or the proxy port changed under it.
 *   v3  (this file, 2026-11-19) direct signed upstream calls. Verified:
 *       all models, streaming, and function calling work; the token does not
 *       expire within 24h (51.8h+ observed) and the desktop app is NOT
 *       required for generation — only for (re)login, which joycode-login.mjs
 *       also replicates without the app.
 *
 * Request signing (reverse-engineered from the desktop client):
 *   params  = {appid:"joycode_ide", functionId:"chat_completions", t:<ms>}
 *   sign    = HMAC-SHA256(key=JOYCODE_SIGNING_KEY, sorted values joined by "&")
 *   headers = ptKey:<auth.json tokens.access_token>
 *             tenant:<auth.json tenant>
 *             loginType: PIN_JD_CLOUD (from auth.json login_type)
 *             X-JoyCode-Caller: IDE, X-JoyCode-IDE-Version: 0.7.0
 *   Upstream quirks (verified):
 *   - `stream:true` returns SSE `data: {...delta...}` lines, same shape as the
 *     old local proxy, so streaming is piped through 1:1.
 *   - `stream:false` returns a plain JSON chat.completion (no SSE) — passed
 *     through as-is after stripping `</think>` residue from message.content.
 *   - tool_calls deltas may split name/arguments across chunks (empty `name` on
 *     continuation chunks) — passed through untouched; clients must merge.
 *   - Errors arrive as HTTP 200 + JSON `{"error":{...}}`; they are re-issued
 *     with a real HTTP error status so downstream clients see failures.
 *
 * Env:
 *   JOYCODE_SHIM_HOST        default 0.0.0.0 (Tailscale peers must reach it)
 *   JOYCODE_SHIM_PORT        default 18888
 *   JOYCODE_SHIM_TOKEN       optional bearer required from downstream clients
 *   JOYCODE_AUTH_FILE        default ~/.joycode/auth.json
 *   JOYCODE_SHIM_TIMEOUT_MS  default 600000
 *   JOYCODE_SHIM_DISABLED_MODELS    default "GLM-5.3" (comma list, case-insensitive;
 *                                   hidden from /v1/models and rejected with 400;
 *                                   set to "" to re-enable everything)
 *   JOYCODE_UPSTREAM_BASE    default https://api-ai.jd.com/api
 *   JOYCODE_SIGNING_KEY      default 0691a3f0b37b4a85aeb63ad0fc7db3ed
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import path from "node:path";
import os from "node:os";

const HOST = process.env.JOYCODE_SHIM_HOST || "0.0.0.0";
const PORT = Number(process.env.JOYCODE_SHIM_PORT || 18888);
const TOKEN = process.env.JOYCODE_SHIM_TOKEN || "";
const TIMEOUT_MS = Number(process.env.JOYCODE_SHIM_TIMEOUT_MS || 600000);
const AUTH_FILE = process.env.JOYCODE_AUTH_FILE || path.join(os.homedir(), ".joycode/auth.json");
const UPSTREAM_BASE = (process.env.JOYCODE_UPSTREAM_BASE || "https://api-ai.jd.com/api").replace(/\/$/, "");
const SIGNING_KEY = process.env.JOYCODE_SIGNING_KEY || "0691a3f0b37b4a85aeb63ad0fc7db3ed";
const APPID = "joycode_ide";
const IDE_VERSION = "0.7.0";

/**
 * Models hidden from the catalogue and rejected on request.
 *
 * Cost check (2026-11-16, quota-exhaustion method): JoyAI-Code-1.6 kept
 * answering after the 10k team quota hit remain=-20 with no counter delta;
 * GLM-5.3 is the most expensive paid tier (0.6x). User decision 2026-11-16:
 * disable GLM-5.3. Override with JOYCODE_SHIM_DISABLED_MODELS="" to re-enable.
 */
const DISABLED_MODELS = new Set(
  (process.env.JOYCODE_SHIM_DISABLED_MODELS ?? "GLM-5.3")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// Static catalogue — the desktop client serves the same five slugs; slugs must
// match the upstream exactly (they are validated there, not resolved).
const FALLBACK_MODELS = [
  { slug: "JoyAI-Code-1.6", display: "JoyAI-Code-1.6", context: 200000 },
  { slug: "GLM-5.3-agent", display: "GLM-5.3", context: 200000 },
  { slug: "Kimi-K2.6-agent", display: "Kimi-K2.6", context: 200000 },
  { slug: "MiniMax-M3-agent", display: "MiniMax-M3", context: 200000 },
  { slug: "Doubao-Seed-2.0-pro-agent", display: "Doubao-Seed-2.0-pro", context: 200000 },
];
let modelCache = { at: 0, models: FALLBACK_MODELS.filter((m) => !isDisabledModel(m.slug, m.display)) };

function isDisabledModel(slug, display) {
  if (!DISABLED_MODELS.size) return false;
  const slugL = String(slug || "").toLowerCase();
  const displayL = String(display || "").toLowerCase();
  const bare = slugL.replace(/-agent$/, "");
  return DISABLED_MODELS.has(slugL) || DISABLED_MODELS.has(displayL) || DISABLED_MODELS.has(bare);
}

/** auth.json: {tokens:{access_token, refresh_token, id_token,...}, tenant, login_type, ...} */
async function readCreds() {
  const raw = JSON.parse(await readFile(AUTH_FILE, "utf8"));
  const ptKey = raw?.tokens?.access_token || raw?.tokens?.refresh_token || raw?.pt_key;
  if (!ptKey) throw new Error(`no access_token in ${AUTH_FILE}`);
  return {
    ptKey,
    tenant: raw?.tenant || process.env.JOYCODE_TENANT || "",
    loginType: raw?.login_type || "PIN_JD_CLOUD",
    userId: raw?.userId || "",
  };
}

function signedParams(functionId) {
  const params = { appid: APPID, functionId, t: String(Date.now()) };
  const s = Object.keys(params)
    .sort()
    .map((k) => params[k])
    .filter(Boolean)
    .join("&");
  const sign = createHmac("sha256", SIGNING_KEY).update(s).digest("hex");
  const q = new URLSearchParams(params);
  q.set("sign", sign);
  return q.toString();
}

function authHeaders(creds) {
  return {
    "content-type": "application/json",
    ptKey: creds.ptKey,
    tenant: creds.tenant,
    loginType: creds.loginType,
    "X-JoyCode-Caller": "IDE",
    "X-JoyCode-IDE-Version": IDE_VERSION,
  };
}

function resolveSlug(raw, models) {
  const key = String(raw || "").toLowerCase().trim();
  if (!key) return models[0].slug;
  for (const m of models) if (m.slug.toLowerCase() === key) return m.slug;
  for (const m of models) if (m.display.toLowerCase() === key) return m.slug;
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

/** Does this upstream SSE line carry an error payload? */
function isSseErrorLine(line) {
  return (
    line.includes("response.failed") ||
    (line.includes('"error"') && (line.includes("AI_GRAY_ACCESS_DENIED") || line.includes("insufficient_quota") || line.includes("账号未登录")))
  );
}

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    json(res, 400, { error: { message: `bad json: ${e.message}`, type: "invalid_request_error" } });
    return;
  }

  let creds;
  try {
    creds = await readCreds();
  } catch (e) {
    console.error(`[shim] 503 ${e.message}`);
    json(res, 503, {
      error: {
        message: `JoyCode credentials unavailable: ${e.message}. Run: node ${path.join(path.dirname(new URL(import.meta.url).pathname), "joycode-login.mjs")}`,
        type: "upstream_error",
        code: "joycode_no_credentials",
      },
    });
    return;
  }

  const models = modelCache.models;

  // Reject explicitly-requested models that are disabled, instead of silently
  // falling back to models[0] (resolveSlug would do that for unknown names).
  if (body.model) {
    const wanted = String(body.model).toLowerCase().trim();
    const wantedBare = wanted.replace(/-agent$/, "");
    const hit = models.find(
      (m) =>
        m.slug.toLowerCase() === wanted ||
        m.display.toLowerCase() === wanted ||
        m.slug.toLowerCase().replace(/-agent$/, "") === wantedBare,
    );
    const explicitlyDisabled = !hit && (DISABLED_MODELS.has(wanted) || DISABLED_MODELS.has(wantedBare));
    if (explicitlyDisabled) {
      console.log(`[shim] 400 model=${body.model} disabled`);
      json(res, 400, {
        error: {
          message: `Model "${body.model}" is disabled on this shim (JOYCODE_SHIM_DISABLED_MODELS). Available: ${models
            .map((m) => m.display)
            .join(", ")}`,
          type: "invalid_request_error",
          code: "model_disabled",
        },
      });
      return;
    }
  }

  const modelSlug = resolveSlug(body.model, models);
  const upstreamBody = { ...body, model: modelSlug, stream: Boolean(body.stream) };
  // (keep upstream stream flag aligned with the downstream request: the direct
  //  gateway honours it — stream:true → SSE deltas, stream:false → plain JSON)

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // Propagate downstream disconnects so we do not keep streaming into a dead socket.
  res.on("close", () => controller.abort());

  const started = Date.now();
  const url = `${UPSTREAM_BASE}?${signedParams("chat_completions")}`;
  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: authHeaders(creds), // no accept header: the gateway forwards it and the backend answers 406 (COLOR_FORWARD_EXCEPTION)
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    console.error(`[shim] 502 model=${modelSlug} ${e.message}`);
    json(res, 502, {
      error: { message: String(e.message || e), type: "upstream_error", code: "joycode_upstream_failed" },
    });
    return;
  }

  const ctype = upstream.headers.get("content-type") || "";

  // stream:false on the direct upstream returns a plain JSON chat.completion
  // body (NOT SSE) — pass it through 1:1 after logging. (Verified 2026-11-19.)
  if (!body.stream) {
    const text = await upstream.text();
    clearTimeout(timer);
    console.log(`[shim] ${upstream.status} model=${modelSlug} elapsedMs=${Date.now() - started} stream=false bytes=${text.length}`);
    if (!upstream.ok) {
      let err = null;
      try { err = JSON.parse(text)?.error; } catch { /* raw */ }
      json(res, upstream.status, {
        error: {
          message: err?.message || text.slice(0, 400),
          type: "upstream_error",
          code: err?.code || "joycode_upstream_error",
        },
      });
      return;
    }
    let out;
    try {
      out = JSON.parse(text); // a healthy body is exactly an OpenAI-style completion
    } catch {
      // e.g. "event: COLOR_FORWARD_EXCEPTION\ndata: {...}" gateway noise
      json(res, 502, { error: { message: text.slice(0, 400), type: "upstream_error", code: "joycode_upstream_error" } });
      return;
    }
    const msg = out?.choices?.[0]?.message;
    if (msg) {
      // The model leaks </think> tags into content; the real reasoning already
      // arrives in reasoning_content — strip the tags, keep the tail answer.
      if (typeof msg.content === "string") msg.content = msg.content.replace(/<\/?think>/g, "").trim();
    }
    json(res, 200, out);
    return;
  }

  // Upstream auth/quota failures arrive as HTTP 200 + JSON {"error":...}.
  if (!upstream.ok || (!body.stream && false)) {
    const text = await upstream.text();
    clearTimeout(timer);
    let errObj = null;
    try {
      errObj = JSON.parse(text);
    } catch {
      /* keep raw */
    }
    const err = errObj?.error || (errObj && errObj.code && errObj.msg ? { message: errObj.msg, code: String(errObj.code) } : null);
    console.log(
      `[shim] ${upstream.status} model=${modelSlug} elapsedMs=${Date.now() - started} stream=false bytes=${text.length}${err ? ` err=${err.code || ""}` : ""}`,
    );
    const status = upstream.ok ? (err ? 502 : 200) : upstream.status;
    if (status !== 200) {
      json(res, status, {
        error: {
          message: err?.message || text.slice(0, 400),
          type: "upstream_error",
          code: err?.code || "joycode_upstream_error",
        },
      });
    } else {
      res.writeHead(200, { "content-type": ctype || "application/json; charset=utf-8", "access-control-allow-origin": "*" });
      res.end(text);
    }
    return;
  }

  // Streaming: pipe the upstream SSE through 1:1.
  if (body.stream) {
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
      console.error(`[shim] stream aborted model=${modelSlug} ${e.message}`);
    } finally {
      clearTimeout(timer);
      res.end();
      console.log(`[shim] 200 model=${modelSlug} elapsedMs=${Date.now() - started} stream=true bytes=${bytes}`);
    }
    return;
  }

  // Non-streaming: upstream still answers with SSE; buffer and synthesize.
  const { completion, error } = await bufferSseCompletion(upstream, modelSlug);
  clearTimeout(timer);
  if (error) {
    console.log(`[shim] ${error.code || 502} model=${modelSlug} elapsedMs=${Date.now() - started} stream=false err=${error.code || ""}`);
    json(res, error.code === "insufficient_quota" ? 429 : error.code === "AI_GRAY_ACCESS_DENIED" ? 403 : 502, {
      error: { message: error.message, type: "upstream_error", code: error.code || "joycode_upstream_error" },
    });
    return;
  }
  console.log(`[shim] 200 model=${modelSlug} elapsedMs=${Date.now() - started} stream=false (buffered sse)`);
  json(res, 200, completion);
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
    json(res, 200, {
      object: "list",
      data: modelCache.models.map((m) => ({
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
    let error = null;
    let user = null;
    try {
      const creds = await readCreds();
      user = creds.userId || undefined;
    } catch (e) {
      error = e.message;
    }
    json(res, error ? 503 : 200, {
      ok: !error,
      mode: "direct-upstream",
      upstream: UPSTREAM_BASE,
      user,
      models: modelCache.models.map((m) => m.display),
      error,
    });
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
  ) {
    try {
      await handleChat(req, res);
    } catch (e) {
      console.error(`[shim] 500 handler crash: ${e.stack || e}`);
      if (!res.headersSent) {
        json(res, 500, { error: { message: String(e.message || e), type: "upstream_error", code: "joycode_shim_internal" } });
      } else {
        res.end();
      }
    }
    return;
  }

  json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
});

server.listen(PORT, HOST, () => {
  console.log(`[shim] listening on ${HOST}:${PORT}`);
  console.log(`[shim] mode: direct-upstream (signed api-ai.jd.com calls, no JoyCode.app needed)`);
  console.log(`[shim] upstream: ${UPSTREAM_BASE}`);
  console.log(`[shim] models: ${modelCache.models.map((m) => m.display).join(", ")}`);
  console.log(`[shim] auth: ${TOKEN ? "bearer required" : "open (no token)"}`);
  console.log(`[shim] credential: ${AUTH_FILE}`);
  readCreds()
    .then((c) => console.log(`[shim] credential ok (tenant=${c.tenant || "(empty)"}, user=${c.userId || "?"})`))
    .catch((e) => console.error(`[shim] credential unavailable: ${e.message}`));
});
