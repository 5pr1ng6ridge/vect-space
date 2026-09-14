/* global URL, WebSocket, process, console */

// Real-WebGL parity entry for the SceneSurface migration baseline.
//
// It generates the frozen fixture payloads from the real runtime
// (`export_parity_fixture`), serves the `parity/` harness page plus the game
// assets through Vite, drives a locally installed Chrome/Edge over the
// DevTools protocol, and writes full-size screenshots plus a JSON report to
// `.parity-output/`.  The command deliberately does not assert that the game
// and editor surfaces are pixel-equal: confirmed differences are recorded in
// `docs/scene-surface-migration-baseline.md`, never frozen as desired
// behaviour.  A non-zero exit means the harness itself failed (missing
// browser, payload export error, page exception, screenshot failure).
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

    const errors = Array.isArray(report.errors) ? report.errors : [];
    console.log(
      `parity: ${report.targets?.length ?? 0} 个目标 / ${captures.length} 张截图 / ${errors.length} 个步骤错误`,
    );
    console.log(`输出目录：${relative(root, options.output)}`);
    if (pageErrors.length > 0) {
      console.error(`页面异常 ${pageErrors.length} 条：`);
      for (const error of pageErrors) console.error(`  - ${error}`);
    }
    for (const error of errors) {
      console.error(`步骤错误 ${error.step}: ${error.message}`);
    }
    // The report must contain exactly the targets the list asked for: a
    // checker pointed at an OS-temp list must fail instead of silently
    // accepting a fixture set built from a different file.
    const reportTargetIds = (
      Array.isArray(report.targets) ? report.targets : []
    ).map((target) => target.id);
    const reportIds = new Set(reportTargetIds);
    const targetProblems = [];
    for (const id of targets.ids) {
      if (!reportIds.has(id)) targetProblems.push(`报告缺少目标 ${id}`);
    }
    for (const id of reportIds) {
      if (!targets.ids.has(id))
        targetProblems.push(`报告出现清单外的目标 ${id}`);
    }
    if (reportIds.size !== reportTargetIds.length) {
      targetProblems.push(
        `报告目标 id 重复（${reportTargetIds.length} 个目标 / ${reportIds.size} 个 id）`,
      );
    }
    const matchedTargetCount = [...targets.ids].filter((id) =>
      reportIds.has(id),
    ).length;
    console.log(
      `目标清单：${relative(root, targets.path)}，报告 ${matchedTargetCount}/${targets.ids.size} 个目标匹配`,
    );
    if (targetProblems.length > 0) {
      console.error(`目标清单与报告不一致：${targetProblems.length} 处：`);
      for (const problem of targetProblems) console.error(`  - ${problem}`);
    }
    // Diagnostics never fail the entry; they are recorded so a reviewer can
    // see whether a visual difference came with a host warning.
    const diagnostics = Array.isArray(report.diagnostics)
      ? report.diagnostics
      : [];
    if (diagnostics.length > 0) {
      console.log(`诊断 ${diagnostics.length} 条：`);
      for (const message of diagnostics) console.log(`  - ${message}`);
    }
    if (report.capturePolicy?.editor !== "deterministic-seek") {
      console.error(
        "harness 报告缺少确定性 seek 策略标记；无法判定媒体定位断言。",
      );
      process.exitCode = 1;
    }
    // The shared ChoiceLayer also gets a real-browser computed-layout probe.
    // This is intentionally separate from screenshot parity: an image that
    // happens to look plausible can still be intrinsically sized or stacked
    // above the label.  Every host/mode pair must report exact button-box
    // artwork geometry and content above the artwork stack.
    const choiceLayoutCases = Array.isArray(report.choiceLayout?.cases)
      ? report.choiceLayout.cases
      : [];
    const choiceLayoutProblems = [];
    const expectedChoiceLayoutCases = new Set([
      "game/separate",
      "game/overlay",
      "editor/separate",
      "editor/overlay",
    ]);
    const actualChoiceLayoutCases = new Set();
    for (const probe of choiceLayoutCases) {
      const key = `${probe.host}/${probe.mode}`;
      if (actualChoiceLayoutCases.has(key)) {
        choiceLayoutProblems.push(`${key}: 探针结果重复`);
      }
      actualChoiceLayoutCases.add(key);
      if (probe.imageBoxesMatchButton !== true) {
        choiceLayoutProblems.push(`${key}: artwork 未与按钮解析盒一致`);
      }
      if (probe.fallbackHeightMatches !== true) {
        choiceLayoutProblems.push(
          `${key}: 80px fallback 高度未按解析按钮盒呈现`,
        );
      }
      if (probe.contentOverlaysArtwork !== true) {
        choiceLayoutProblems.push(
          `${key}: icon/KaTeX content 未叠加在 artwork 上`,
        );
      }
    }
    for (const key of expectedChoiceLayoutCases) {
      if (!actualChoiceLayoutCases.has(key)) {
        choiceLayoutProblems.push(
          `${key}: 缺少真实浏览器 ChoiceLayer 探针结果`,
        );
      }
    }
    console.log(
      `Choice 布局：${choiceLayoutCases.length}/${expectedChoiceLayoutCases.size} 个 host/mode 探针通过`,
    );
    if (choiceLayoutProblems.length > 0) {
      console.error(`Choice 布局探针失败：${choiceLayoutProblems.length} 处：`);
      for (const problem of choiceLayoutProblems)
        console.error(`  - ${problem}`);
    }

    // A deterministically scrubbed video must land on the time the playhead
    // targets, within the shared 50 ms drift threshold.  Playback-mode seeks
    // are checked by the real-video fixture block below; timelines without a
    // video track record `media: null` and assert nothing here.
    const scrubMediaProblems = [];
    for (const target of Array.isArray(report.targets) ? report.targets : []) {
      for (const frame of target.editor?.frames ?? []) {
        const media = frame.media;
        if (media === null || media === undefined) continue;
        if (frame.mode !== "scrub") continue;
        const drift = Math.abs(media.currentTime - media.targetTime);
        if (!(drift <= 0.05)) {
          scrubMediaProblems.push(
            `${target.id} @${frame.elapsed_ms}ms: currentTime=${media.currentTime} target=${media.targetTime} drift=${drift.toFixed(3)}s`,
          );
        }
      }
    }
    if (scrubMediaProblems.length > 0) {
      console.error(`视频定位超过 50ms：${scrubMediaProblems.length} 处：`);
      for (const problem of scrubMediaProblems) console.error(`  - ${problem}`);
    }

    // Real-video fixture: the browser entry drives a video-bearing target on
    // both shared hosts and records nonzero media observations plus in-page
    // assertions.  A run without any such target (or without any observation)
    // fails here instead of silently skipping the video checks.
    const videoTargets = (
      Array.isArray(report.targets) ? report.targets : []
    ).filter((target) => target.video?.fixture === true);
    const videoProblems = [];
    let videoChecks = 0;
    let videoChecksFailed = 0;
    let videoObservations = 0;
    if (videoTargets.length === 0) {
      videoProblems.push(
        "没有任何目标包含视频轨：浏览器视频断言为空（夹具缺失，不得静默跳过）",
      );
    }
    for (const target of videoTargets) {
      const video = target.video;
      const checks = Array.isArray(video.checks) ? video.checks : [];
      const observations = Array.isArray(video.observations)
        ? video.observations
        : [];
      videoChecks += checks.length;
      videoObservations += observations.length;
      if (checks.length === 0) {
        videoProblems.push(`${target.id}: 没有执行任何视频断言`);
        continue;
      }
      const failed = checks.filter((check) => check.ok !== true);
      videoChecksFailed += failed.length;
      for (const check of failed) {
        videoProblems.push(`${target.id}/${check.name}: ${check.detail}`);
      }
      if (observations.length < 6) {
        videoProblems.push(
          `${target.id}: 真实视频观测不足（${observations.length} < 6）`,
        );
      }
      for (const host of ["game", "editor"]) {
        const hostObservations = observations.filter(
          (observation) =>
            observation.host === host && observation.media !== null,
        );
        if (hostObservations.length === 0) {
          videoProblems.push(`${target.id}: ${host} 端没有真实媒体观测`);
        }
      }
      const scrubObservations = observations.filter(
        (observation) =>
          observation.mode === "scrub" && observation.media !== null,
      );
      if (scrubObservations.length < 3) {
        videoProblems.push(
          `${target.id}: scrub 媒体观测不足（${scrubObservations.length} < 3）`,
        );
      }
      const playbackObservations = observations.filter(
        (observation) =>
          observation.mode === "playback" && observation.media !== null,
      );
      if (playbackObservations.length < 2) {
        videoProblems.push(
          `${target.id}: 连续播放媒体观测不足（${playbackObservations.length} < 2）`,
        );
      }
    }
    console.log(
      `视频：${videoTargets.length} 个目标 / ${videoObservations} 个真实观测 / ${videoChecks} 项检查（失败 ${videoChecksFailed}）`,
    );
    if (videoProblems.length > 0) {
      console.error(`真实视频夹具断言失败：${videoProblems.length} 处：`);
      for (const problem of videoProblems) console.error(`  - ${problem}`);
    }
    // Four-slot ambience fixture: the browser harness reads the same
    // read-only AudioDiagnostics seam from the game controller and editor
    // TimelineSession. A report without observations or checks must fail
    // rather than silently treating ambience parity as optional.
    const ambienceProblems = [];
    for (const target of Array.isArray(report.targets) ? report.targets : []) {
      const ambience = target.ambience;
      if (ambience?.fixture !== true) continue;
      const observations = Array.isArray(ambience.observations)
        ? ambience.observations
        : [];
      const checks = Array.isArray(ambience.checks) ? ambience.checks : [];
      if (checks.length === 0) {
        ambienceProblems.push(`${target.id}: 没有执行四槽位环境声断言`);
      }
      for (const check of checks) {
        if (check.ok !== true) {
          ambienceProblems.push(`${target.id}/${check.name}: ${check.detail}`);
        }
      }
      for (const host of ["game", "editor"]) {
        const hostObservation = observations.find(
          (observation) => observation.host === host,
        );
        if (hostObservation === undefined) {
          ambienceProblems.push(`${target.id}: ${host} 端没有环境声诊断观测`);
        }
      }
    }
    console.log(
      `环境声：${
        (Array.isArray(report.targets) ? report.targets : []).filter(
          (target) => target.ambience?.fixture === true,
        ).length
      } 个目标 / ${ambienceProblems.length} 个问题`,
    );
    if (ambienceProblems.length > 0) {
      console.error(`四槽位环境声断言失败：${ambienceProblems.length} 处：`);
      for (const problem of ambienceProblems) console.error(`  - ${problem}`);
    }

    // Browser-driven lifecycle: a cancelled game presentation must settle
    // `failed`, a cancelled/reset editor session must reload to exactly the
    // same deterministic frame, and a cancel must have released any media.
    const lifecycleProblems = [];
    for (const target of Array.isArray(report.targets) ? report.targets : []) {
      if (target.game?.cancelledOutcome !== "failed") {
        lifecycleProblems.push(
          `${target.id}: cancelCurrentPresentation settled ${target.game?.cancelledOutcome}`,
        );
      }
      const baseline = target.thumbnails?.["editor-0000"]?.sha256;
      for (const name of ["editor-cancelled-reload", "editor-reset-reload"]) {
        const signature = target.thumbnails?.[name]?.sha256;
        if (baseline === undefined || signature === undefined) {
          lifecycleProblems.push(`${target.id}: missing ${name} capture`);
        } else if (signature !== baseline) {
          lifecycleProblems.push(
            `${target.id}: ${name} does not reproduce editor-0000 (${signature.slice(0, 12)} != ${baseline.slice(0, 12)})`,
          );
        }
      }
      const hasMedia = (target.editor?.frames ?? []).some(
        (frame) => frame.media !== null && frame.media !== undefined,
      );
      if (hasMedia && target.cancelledMedia !== null) {
        lifecycleProblems.push(
          `${target.id}: cancel kept a media element (${JSON.stringify(target.cancelledMedia)})`,
        );
      }
    }
    if (lifecycleProblems.length > 0) {
      console.error(`生命周期断言失败：${lifecycleProblems.length} 处：`);
      for (const problem of lifecycleProblems) console.error(`  - ${problem}`);
    } else {
      console.log("生命周期：取消/重置后重载逐字节复现，取消结果 failed。");
    }
    if (
      errors.length > 0 ||
      pageErrors.length > 0 ||
      targetProblems.length > 0 ||
      choiceLayoutProblems.length > 0 ||
      scrubMediaProblems.length > 0 ||
      videoProblems.length > 0 ||
      ambienceProblems.length > 0 ||
      lifecycleProblems.length > 0
    ) {
      process.exitCode = 1;
    }
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
