/* global WebSocket, console, process, URL */
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import { createServer } from "vite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = process.argv[2] ?? join(root, ".visual-output");
const candidates = [process.env.PARITY_BROWSER, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].filter(Boolean);
let browser;
for (const candidate of candidates) {
  try { await access(candidate); browser = candidate; break; } catch { /* next installation */ }
}
if (!browser) throw new Error("Install Chromium or set PARITY_BROWSER");
const tempRoot = process.env.CLAUDE_JOB_DIR ? join(process.env.CLAUDE_JOB_DIR, "tmp") : tmpdir();
const profile = await mkdtemp(join(tempRoot, "visual-resources-"));
const server = await createServer({ configFile: false, root, cacheDir: join(profile, "vite"), server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } } });
let child, socket;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  // PARITY_GPU=1 measures on the machine's GPU; the default software
  // rasterizer keeps pixel gates reproducible across machines.
  const renderer = process.env.PARITY_GPU === "1" ? [] : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"];
  child = spawn(browser, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", ...renderer, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error("Browser start timeout")), 30_000);
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
      const match = /DevTools listening on (ws:\/\/\S+)/u.exec(stderr);
      if (match) { clearTimeout(timer); resolveUrl(match[1]); }
    });
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Browser exit ${code}`)); });
  });
  socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", resolveOpen, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const pending = new Map();
  let id = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.consoleAPICalled") console.log(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
    if (message.method === "Runtime.exceptionThrown") console.error(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolveCall, reject) => {
    id += 1;
    const callId = id;
    const timer = setTimeout(() => { pending.delete(callId); reject(new Error(`${method} timeout`)); }, 120_000);
    pending.set(callId, { resolve: resolveCall, reject, timer });
    socket.send(JSON.stringify({ id: callId, method, params, sessionId }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  const ready = new Promise((resolveReady) => {
    const listener = ({ data }) => { const message = JSON.parse(data); if (message.method === "Page.loadEventFired" && message.sessionId === sessionId) { socket.removeEventListener("message", listener); resolveReady(); } };
    socket.addEventListener("message", listener);
  });
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/parity/visual-resources.html` }, sessionId);
  let readyTimer;
  try {
    await Promise.race([ready, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error("Page load timeout")), 30_000); })]);
  } finally { clearTimeout(readyTimer); }
  const result = await send("Runtime.evaluate", { expression: "window.visualResources", awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  const report = result.result.value;
  if (!report) throw new Error("Missing probe report");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "text-block.png"), Buffer.from(report.screenshot.split(",")[1], "base64"));
  delete report.screenshot;
  if (report.thumbnail) {
    await writeFile(join(output, "surface-thumbnail.png"), Buffer.from(report.thumbnail.split(",")[1], "base64"));
    delete report.thumbnail;
  }
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  socket?.close();
  if (child && child.exitCode === null) { child.kill(); await new Promise((resolveExit) => child.once("exit", resolveExit)); }
  await server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
