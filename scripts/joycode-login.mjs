#!/usr/bin/env node
/**
 * JoyCode login helper — replicates the JoyCode.app desktop login flow WITHOUT
 * the app. Writes ~/.joycode/auth.json exactly like the desktop client does.
 *
 * Flow (reverse-engineered from JoyCode.app dist/main.js, verified 2026-11-19):
 *   1. GET  https://joycode-api.jd.com/api/saas/user/v2/userInfo
 *      headers: ptKey: "" , loginType: ""
 *      -> 200 {"code":401,"data":{"loginUrl":"https://joycode.jd.com/portal/login"}}
 *   2. Open the loginUrl in a browser with extra params:
 *        ideAppName=JoyCode & fromIde=ide & redirect=0
 *        authPort=<local port> & authKey=<48-hex> & jcid=<device id>
 *   3. After the web login succeeds the page redirects to
 *        http://127.0.0.1:<authPort>/?pt_key=...&tenant=...&loginType=...
 *           &authKey=...&userId=...&userName=...&isColor=...&base_url=...
 *   4. This tool validates authKey, persists credentials to ~/.joycode/auth.json
 *      (same shape the app writes: tokens.access_token === tokens.refresh_token),
 *      verifies the new token against the chat endpoint and exits.
 *
 * jcid = sha256("joycoder-ide:jcid:v1:<platform>:<source>:<value>").slice(0,32)
 *        where darwin uses IOPlatformUUID (source "darwin-ioplatformuuid").
 *
 * Usage: node joycode-login.mjs [--timeout 300]
 */
import { createServer } from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileP = promisify(execFile);
const AUTH_FILE = process.env.JOYCODE_AUTH_FILE || path.join(os.homedir(), ".joycode/auth.json");
const BOOTSTRAP_URL = "https://joycode-api.jd.com/api/saas/user/v2/userInfo";
const VERIFY_URL = "https://api-ai.jd.com/api";
const APPID = "joycode_ide";
const HMAC_KEY = "0691a3f0b37b4a85aeb63ad0fc7db3ed";
const JC_PREFIX = "joycoder-ide:jcid:v1";
const TIMEOUT_RAW = process.argv.includes("--timeout") ? process.argv[process.argv.indexOf("--timeout") + 1] : "300";
const TIMEOUT_MS = Number(TIMEOUT_RAW.endsWith("s") ? TIMEOUT_RAW.slice(0, -1) : TIMEOUT_RAW) * (TIMEOUT_RAW.endsWith("s") ? 1000 : 1000);

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Fake alg=none JWT id_token — exactly what the app writes (W3e in main.js). */
function fakeIdToken() {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
    email: "joycode@jd.com",
    "http://joycode-api-inner.jd.com/api/saas/openai/v1": { chatgpt_plan_type: "pro" },
  })}.${Buffer.from("joycode").toString("base64url")}`;
}

/** Device fingerprint identical to the app's clientIdProvider (ete/j3e/F3e). */
async function computeJcid() {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileP("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 2000 });
      const m = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return createHash("sha256").update(`${JC_PREFIX}:${process.platform}:darwin-ioplatformuuid:${m[1]}`, "utf8").digest("hex").slice(0, 32);
      const s = stdout.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
      if (s) return createHash("sha256").update(`${JC_PREFIX}:${process.platform}:darwin-serial:${s[1]}`, "utf8").digest("hex").slice(0, 32);
    } catch {
      /* fall through */
    }
  }
  // Non-darwin / fallback: machine-id style source so the shape stays valid.
  let value = os.hostname();
  let source = "fallback-hostname";
  try {
    const { readFile } = await import("node:fs/promises");
    value = (await readFile("/etc/machine-id", "utf8")).trim() || value;
    source = "linux-machine-id";
  } catch {
    /* keep hostname */
  }
  return createHash("sha256").update(`${JC_PREFIX}:${process.platform}:${source}:${value}`, "utf8").digest("hex").slice(0, 32);
}

async function fetchLoginUrl() {
  const res = await fetch(BOOTSTRAP_URL, {
    headers: { ptKey: "", loginType: "" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  const url = body?.data?.loginUrl;
  if (!url) throw new Error(`bootstrap did not return loginUrl: ${JSON.stringify(body).slice(0, 200)}`);
  return url;
}

/** Signed upstream probe — the same HMAC the desktop client uses. */
async function verifyToken(ptKey, tenant) {
  const t = String(Date.now());
  const params = { appid: APPID, functionId: "chat_completions", t };
  const keys = Object.keys(params).sort();
  const s = keys.map((k) => params[k]).filter(Boolean).join("&");
  const sig = createHmac("sha256", HMAC_KEY).update(s).digest("hex");
  const q = new URLSearchParams({ appid: APPID, functionId: "chat_completions", t, sign: sig });
  const res = await fetch(`${VERIFY_URL}?${q}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ptKey,
      tenant: tenant || "",
      loginType: "PIN_JD_CLOUD",
      "X-JoyCode-Caller": "IDE",
      "X-JoyCode-IDE-Version": "0.7.0",
    },
    body: JSON.stringify({
      model: "JoyAI-Code-1.6",
      stream: false,
      messages: [{ role: "user", content: "ping" }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  return { ok: res.ok && !text.includes("AI_GRAY_ACCESS_DENIED") && !text.includes("账号未登录"), status: res.status, body: text.slice(0, 300) };
}

async function main() {
  const jcid = await computeJcid();
  const authKey = randomBytes(24).toString("hex");
  const loginUrl0 = await fetchLoginUrl();
  console.log(`[login] bootstrap loginUrl: ${loginUrl0}`);
  console.log(`[login] jcid: ${jcid}`);

  const credsPromise = new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname === "/success" || u.pathname === "/cancel") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html><body><h3>登录成功</h3>可以关闭此页面。</body></html>");
        return;
      }
      const ptKey = (u.searchParams.get("pt_key") || "").trim();
      const key = u.searchParams.get("authKey");
      if (!ptKey || key !== authKey) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("invalid authKey or missing pt_key");
        return;
      }
      res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/success` });
      res.end();
      const pick = (a, b) => u.searchParams.get(a) ?? u.searchParams.get(b);
      resolve({
        ptKey,
        tenant: u.searchParams.get("tenant") || "",
        loginType: u.searchParams.get("loginType") || u.searchParams.get("login_type") || "PtKey",
        userId: pick("userId", "user_id") || "",
        userName: pick("userName", "user_name") || "",
        erp: pick("erp") || "",
        orgFullName: pick("orgFullName", "org_full_name") || "",
        colorBaseUrl: pick("colorBaseUrl", "color_base_url") || "",
        baseUrl: u.searchParams.get("base_url") || "",
        isColor: u.searchParams.get("isColor") || "",
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const url = new URL(loginUrl0);
      url.searchParams.set("ideAppName", "JoyCode");
      url.searchParams.set("fromIde", "ide");
      url.searchParams.set("redirect", "0");
      url.searchParams.set("authPort", String(port));
      url.searchParams.set("authKey", authKey);
      url.searchParams.set("jcid", jcid);
      console.log(`\n[login] opening browser:\n${url.toString()}\n`);
      const { spawn } = import("node:child_process").then(({ spawn }) => {
        const child = spawn("/usr/bin/open", [url.toString()], { stdio: "ignore", detached: true });
        child.on("error", () => console.log("[login] cannot auto-open browser; copy the URL above by hand"));
        child.unref();
      });
    });
  });

  let loginDone = false;
  const timer = setTimeout(() => {
    if (!loginDone) {
      console.error(`[login] login not completed within ${TIMEOUT_MS / 1000}s`);
      process.exit(3);
    }
  }, TIMEOUT_MS);

  const c = await Promise.race([
    credsPromise.then((v) => { loginDone = true; clearTimeout(timer); return v; }),
    new Promise((_, rej) => timer.on?.("unref", () => {})), // noop keeps race shape stable
  ]);
  console.log(`[login] got pt_key (${c.ptKey.length} chars), tenant=${c.tenant || "(empty)"}, loginType=${c.loginType}`);

  const check = await verifyToken(c.ptKey, c.tenant);
  if (!check.ok) {
    console.error(`[login] WARNING: token verification failed (HTTP ${check.status}): ${check.body}`);
    console.error("[login] credentials will still be written; the caller may retry or re-login.");
  } else {
    console.log("[login] token verified against upstream chat endpoint ✓");
  }

  const auth = {
    tokens: {
      id_token: fakeIdToken(),
      access_token: c.ptKey,
      refresh_token: c.ptKey,
      account_id: null,
    },
    last_refresh: new Date().toISOString(),
    ...(c.isColor === "true" ? { color_base_url: c.colorBaseUrl || "https://api-ai.jd.com/" } : { base_url: c.baseUrl || "https://joycode.jd.com" }),
    tenant: c.tenant,
    login_type: c.loginType,
    userId: c.userId || undefined,
    userName: c.userName || undefined,
    erp: c.erp || undefined,
    orgFullName: c.orgFullName || undefined,
  };
  await mkdir(path.dirname(AUTH_FILE), { recursive: true });
  await writeFile(AUTH_FILE, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  console.log(`[login] credentials written to ${AUTH_FILE}`);
  console.log("[login] done. JoyCode.app is no longer needed for API calls.");
}

async function status() {
  try {
    const cred = JSON.parse(await readFile(AUTH_FILE, "utf8"));
    const tok = cred?.tokens ?? {};
    const bearer = tok.access_token ?? tok.refresh_token ?? "";
    const mint = /^\d{13}/.test(bearer) ? new Date(Number(bearer.slice(0, 13))).toISOString() : "?";
    console.log(`file        : ${AUTH_FILE}`);
    console.log(`user        : ${cred?.userId || cred?.userName || "?"}`);
    console.log(`tenant      : ${cred?.tenant || "(empty)"}`);
    console.log(`login_type  : ${cred?.login_type || cred?.loginType || "?"}`);
    console.log(`token mint  : ${mint}`);
    console.log(`token sha12 : ${bearer ? createHash("sha256").update(bearer).digest("hex").slice(0, 12) : "(empty)"}`);
    console.log(`last_refresh: ${cred?.last_refresh || "?"}`);
  } catch (e) {
    console.log(e.code === "ENOENT" ? `no credential at ${AUTH_FILE}` : `cannot read ${AUTH_FILE}: ${e.message}`);
    process.exit(2);
  }
}

async function logout() {
  try {
    await unlink(AUTH_FILE);
    console.log(`removed ${AUTH_FILE}`);
  } catch (e) {
    console.log(e.code === "ENOENT" ? "already absent" : `cannot remove: ${e.message}`);
  }
}

if (process.argv.includes("--status")) await status();
else if (process.argv.includes("--logout")) await logout();
else
  main().catch((e) => {
    console.error(`[login] failed: ${e.message}`);
    process.exit(1);
  });
