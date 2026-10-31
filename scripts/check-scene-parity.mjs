/* global URL, WebSocket, process, console */

// Real-WebGL parity entry.
//
// It generates the fixture payloads from the real runtime
// (`export_parity_fixture`), serves the `parity/` harness page plus the game
// assets through Vite, drives a locally installed Chrome/Edge over the
// DevTools protocol, and writes full-size screenshots plus a JSON report to
// `.parity-output/`.  The command deliberately does not assert that the game
// and editor surfaces are pixel-equal.  A non-zero exit means the harness
// itself failed (missing browser, payload export error, page exception,
// screenshot failure) or one of the in-page assertions checked by
// `check-parity-report.mjs` failed.
//
// Usage:
//   npm run parity:check
//   npm run parity:check -- --out=<dir> [--browser=<path to chrome/edge>]
//   npm run parity:check -- [--targets=<targets.json>]
//
// `--targets=<path>` replaces `parity/targets.json` for the whole run: the
// fixture export and the checker's expectation that the report contains
// exactly those targets both use it.  The file is validated before anything is
// spawned, and it exists so a read-only verifier can drive the anti-vacuity
// video gate from an OS-temp list (for example one without any video target)
// without touching the repository.
//
// Requires a locally installed Chromium browser (or PARITY_BROWSER); it never
// downloads one and adds no browser-automation dependency.

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { checkReport } from "./check-parity-report.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const targetsFile = join(root, "parity", "targets.json");
const defaultOutput = join(root, ".parity-output");
const stepTimeoutMs = 180_000;

// Set while a run is in flight so a failure can still leave a diagnosable
// artifact next to the screenshots it already captured.
let failureOutput = null;
const failureScreenshots = [];

function browserCandidates() {
  const localAppData = process.env.LOCALAPPDATA ?? "";
  return [
    process.env.PARITY_BROWSER,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    localAppData === ""
      ? null
      : join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate) => candidate !== null);
}

function parseArgs(argv) {
  const options = {
    output: defaultOutput,
    targets: targetsFile,
    browser: null,
  };
  for (const arg of argv) {
    if (arg.startsWith("--out=")) {
      options.output = resolve(arg.slice("--out=".length));
    } else if (arg.startsWith("--targets=")) {
      options.targets = resolve(arg.slice("--targets=".length));
    } else if (arg.startsWith("--browser=")) {
      options.browser = arg.slice("--browser=".length);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads and validates a target list before anything is spawned.
 *
 * The same schema the Rust exporter enforces is checked here so a malformed
 * list fails fast instead of half way through a browser run.  Returns the
 * resolved path plus the expected target ids, which the report is checked
 * against so a run cannot silently accept a fixture set other than the one
 * the caller asked for.
 */
async function readTargets(path) {
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    throw new Error(`目标清单不存在或不可读 ${path}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!stats.isFile()) {
    throw new Error(`目标清单不是文件: ${path}`);
  }
  let document;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`目标清单不是合法 JSON ${path}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (document?.schema_version !== 1) {
    throw new Error(`目标清单 schema_version 必须是 1: ${path}`);
  }
  const targets = document.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error(`目标清单没有 targets: ${path}`);
  }
  const ids = new Set();
  for (const target of targets) {
    if (
      typeof target?.id !== "string" ||
      typeof target.scene_id !== "string" ||
      typeof target.node_id !== "string"
    ) {
      throw new Error(`目标项缺少 id/scene_id/node_id: ${path}`);
    }
    if (ids.has(target.id)) {
      throw new Error(`目标清单包含重复 id ${target.id}: ${path}`);
    }
    ids.add(target.id);
  }
  return { path, ids };
}

async function findBrowser(explicit) {
  const candidates = explicit === null ? browserCandidates() : [explicit];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next well-known location.
    }
  }
  return null;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: options.stdio ?? "inherit",
      shell: false,
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`${command} 退出码 ${code ?? signal}`));
      }
    });
  });
}

function launchBrowser(browser, profileDir) {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--hide-scrollbars",
    "--mute-audio",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    // A headless page cannot produce the user gesture the editor preview's
    // audio unlock waits for; the flag makes the same real media pipeline
    // playable without faking the element, its time or its events.
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1920,2200",
    "about:blank",
  ];
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(browser, args, {
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });
    let settled = false;
    let stderr = "";
    const timer = setTimeout(() => {
      finish(new Error(`等待 DevTools 端口超时：${stderr.trim()}`));
    }, 30_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === null) resolveLaunch(value);
      else rejectLaunch(error);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/u.exec(stderr);
      if (match !== null) {
        finish(null, { child, webSocketUrl: match[1] });
      }
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      finish(new Error(`浏览器提前退出（${code}）：${stderr.trim()}`));
    });
  });
}

async function connectDevtools(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const handlers = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) {
        handlers.reject(
          new Error(`CDP ${message.error.code}: ${message.error.message}`),
        );
      } else {
        handlers.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of listeners.get(message.method) ?? []) {
        listener(message.params ?? {});
      }
    }
  });
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener(
      "error",
      () => rejectOpen(new Error("DevTools WebSocket 连接失败")),
      { once: true },
    );
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolveCall, rejectCall) => {
        pending.set(id, { resolve: resolveCall, reject: rejectCall });
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId === undefined ? {} : { sessionId }),
          }),
        );
      });
    },
    on(method, listener) {
      const existing = listeners.get(method) ?? [];
      existing.push(listener);
      listeners.set(method, existing);
    },
    close() {
      socket.close();
    },
  };
}

function withTimeout(promise, milliseconds, label) {
  let timer = null;
  const timeout = new Promise((resolveTimeout, rejectTimeout) => {
    timer = setTimeout(() => {
      rejectTimeout(new Error(`${label} 超时（${milliseconds}ms）`));
    }, milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

async function evaluate(client, sessionId, expression) {
  const result = await withTimeout(
    client.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    ),
    stepTimeoutMs,
    expression,
  );
  if (result.exceptionDetails !== undefined) {
    const exception = result.exceptionDetails;
    const description =
      exception.exception?.description ?? exception.text ?? "未知异常";
    throw new Error(`页面内异常：${description}`);
  }
  return result.result?.value;
}

async function waitForHarness(client, sessionId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = await evaluate(
      client,
      sessionId,
      "window.__parity ? window.__parity.status : null",
    );
    if (status === "ready") return;
    if (status === "failed") {
      const error = await evaluate(
        client,
        sessionId,
        "window.__parity ? window.__parity.error : null",
      );
      throw new Error(`harness 准备失败：${error ?? "未知原因"}`);
    }
    await delay(120);
  }
  throw new Error("等待 parity harness 准备超时");
}

function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "-");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const targets = await readTargets(options.targets);
  const browser = await findBrowser(options.browser);
  if (browser === null) {
    throw new Error(
      "找不到 Chrome/Edge。请安装 Chromium 浏览器，或用 PARITY_BROWSER / --browser=<path> 指定可执行文件。",
    );
  }
  await rm(options.output, { recursive: true, force: true });
  await mkdir(options.output, { recursive: true });
  failureOutput = options.output;

  const temporary = await mkdtemp(join(tmpdir(), "vectspace-parity-"));
  let server = null;
  let launched = null;
  let client = null;
  let pageErrors = [];
  try {
    const fixturesPath = join(temporary, "fixtures.json");
    await runCommand("cargo", [
      "run",
      "--quiet",
      "-p",
      "vectspace-protocol",
      "--bin",
      "export_parity_fixture",
      "--",
      "game",
      targets.path,
      fixturesPath,
    ]);
    const fixturesText = await readFile(fixturesPath, "utf8");

    server = await createServer({
      configFile: false,
      root,
      publicDir: join(root, "game", "assets"),
      cacheDir: join(root, ".vite-cache", "parity"),
      logLevel: "warn",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [
        {
          name: "vectspace-parity-payload",
          configureServer(devServer) {
            devServer.middlewares.use(
              "/__parity/fixtures.json",
              (request, response) => {
                response.setHeader(
                  "Content-Type",
                  "application/json; charset=utf-8",
                );
                response.end(fixturesText);
              },
            );
          },
        },
      ],
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (
      address === null ||
      address === undefined ||
      typeof address === "string"
    ) {
      throw new Error("Vite 开发服务器没有 TCP 端口");
    }
    const pageUrl = `http://127.0.0.1:${address.port}/parity/index.html`;

    launched = await launchBrowser(browser, join(temporary, "chrome-profile"));
    client = await connectDevtools(launched.webSocketUrl);
    client.on("Runtime.exceptionThrown", (params) => {
      pageErrors.push(
        params.exceptionDetails?.exception?.description ??
          params.exceptionDetails?.text ??
          "未捕获的页面异常",
      );
    });
    client.on("Log.entryAdded", (params) => {
      if (params.entry?.level === "error") {
        const where = params.entry.url ?? "";
        const text = params.entry.text ?? "页面日志错误";
        pageErrors.push(where === "" ? text : `${text} (${where})`);
      }
    });

    const { targetId } = await client.send("Target.createTarget", {
      url: "about:blank",
    });
    // Record the actual browser identity next to the screenshots instead of
    // probing a browser executable from the shell.
    const browserIdentity = await client.send("Browser.getVersion");
    const { sessionId } = await client.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Log.enable", {}, sessionId);
    await client.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1920, height: 2200, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
    await client.send("Page.navigate", { url: pageUrl }, sessionId);
    await waitForHarness(client, sessionId);

    const captures = [];
    let report = null;
    for (;;) {
      const step = await evaluate(client, sessionId, "window.__parity.next()");
      if (step === null || step === undefined) {
        throw new Error("harness.next() 没有返回结果");
      }
      if (step.done === true) {
        report = step.report;
        break;
      }
      const capture = step.capture;
      const shot = await withTimeout(
        client.send(
          "Page.captureScreenshot",
          {
            format: "png",
            clip: {
              x: capture.x,
              y: capture.y,
              width: capture.width,
              height: capture.height,
              scale: 1,
            },
            captureBeyondViewport: true,
            fromSurface: true,
          },
          sessionId,
        ),
        stepTimeoutMs,
        `captureScreenshot ${capture.name}`,
      );
      const file = join(
        options.output,
        `${sanitize(capture.target)}--${sanitize(capture.name)}.png`,
      );
      await writeFile(file, Buffer.from(shot.data, "base64"));
      captures.push(relative(root, file));
      failureScreenshots.push(relative(root, file));
    }
    if (report === null || typeof report !== "object") {
      throw new Error("harness 没有返回报告");
    }
    report.pageErrors = pageErrors;
    report.browser = {
      product: browserIdentity.product,
      protocolVersion: browserIdentity.protocolVersion,
      revision: browserIdentity.revision,
    };
    await writeFile(
      join(options.output, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFile(join(options.output, "fixtures.json"), fixturesText);

    const failed = checkReport({
      report,
      targets,
      pageErrors,
      captureCount: captures.length,
      outputDir: options.output,
      root,
    });
    if (failed) process.exitCode = 1;
  } finally {
    if (client !== null) {
      await client.send("Browser.close").catch(() => undefined);
      client.close();
    }
    if (launched !== null) {
      launched.child.kill();
    }
    if (server !== null) {
      await server.close().catch(() => undefined);
    }
    await rm(temporary, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

main().catch(async (error) => {
  console.error(
    `parity 检查失败：${error instanceof Error ? error.message : String(error)}`,
  );
  // Failure keeps its screenshots: write a small failure report beside them so
  // a reviewer can see how far the run got without re-running the browser.
  if (failureOutput !== null && failureScreenshots.length > 0) {
    try {
      await writeFile(
        join(failureOutput, "failure.json"),
        `${JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
            screenshots: failureScreenshots,
          },
          null,
          2,
        )}
`,
      );
      console.error(
        `失败截图已保留：${relative(root, failureOutput)}（共 ${failureScreenshots.length} 张）`,
      );
    } catch {
      // The original failure is the one that matters.
    }
  }
  process.exitCode = 1;
});
