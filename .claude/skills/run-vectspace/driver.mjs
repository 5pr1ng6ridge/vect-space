#!/usr/bin/env node
/* global Buffer, WebSocket, console, fetch, process, setTimeout */
// Drive the real VECTSPACE Tauri game (main + secondary window) on Windows
// through WebView2's Chrome DevTools Protocol. No dependencies: Node >= 22
// (global fetch/WebSocket).
//
//   node .claude/skills/run-vectspace/driver.mjs <command> [args]
//
// Run from the repo root. Artifacts (log, pid, default screenshots) go to
// %TEMP%\vectspace-run\.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = process.env.VECTSPACE_CDP_PORT ?? "9333";
const RUN_DIR = join(tmpdir(), "vectspace-run");
const LOG = join(RUN_DIR, "tauri-dev.log");
const PID_FILE = join(RUN_DIR, "tauri-dev.pid");
mkdirSync(RUN_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pages() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => {
    throw new Error(
      `app not running (nothing on CDP port ${PORT}); run "launch" first`,
    );
  });
  return (await response.json()).filter(
    (target) => target.type === "page" && target.url.includes("localhost:1420"),
  );
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const current = ++id;
      pending.set(current, (message) =>
        message.error
          ? reject(new Error(JSON.stringify(message.error)))
          : resolve(message.result),
      );
      socket.send(JSON.stringify({ id: current, method, params }));
    });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails)
      throw new Error(
        exceptionDetails.exception?.description ?? exceptionDetails.text,
      );
    return result.value;
  };
  return { send, evaluate, close: () => socket.close() };
}

// Both windows load the same URL; the Tauri window label tells them apart.
async function windowSession(which) {
  for (const target of await pages()) {
    const session = await connect(target);
    const label = await session
      .evaluate(
        "window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? ''",
      )
      .catch(() => "");
    if ((label || "main") === which) return session;
    session.close();
  }
  return null;
}

async function withWindow(which, action) {
  const session = await windowSession(which);
  if (!session)
    throw new Error(
      `no "${which}" window (is the app running? is a secondary open?)`,
    );
  try {
    return await action(session);
  } finally {
    session.close();
  }
}

const STATE_JS = `(() => {
  const q = (selector) => document.querySelector(selector);
  const screen = q('.boot-screen') ? 'booting'
    : q('.chapter-map-page') ? 'chapter-map'
    : q('.title-screen') ? 'title' : 'game';
  return {
    screen,
    dialogue: q('.dialogue-surface')?.textContent?.trim() || null,
    blockNotice: q('[data-testid=advance-block-notice]')?.textContent?.trim() || null,
    choices: [...document.querySelectorAll('[role=group][aria-label=选项] button')].map(
      (button) => (button.disabled ? '[disabled] ' : '') + button.dataset.choiceId + ': ' + button.textContent.trim()),
    buttons: [...document.querySelectorAll('button')]
      .filter((button) => !button.closest('[role=group][aria-label=选项]'))
      .map((button) => button.textContent.trim()).filter(Boolean),
  };
})()`;

const clickButtonByText = (text) => `(() => {
  const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent.trim() === ${JSON.stringify(text)});
  if (!button) throw new Error('no button with text ' + ${JSON.stringify(text)});
  button.click();
  return 'clicked ' + ${JSON.stringify(text)};
})()`;

async function pressKey(session, key) {
  for (const type of ["keyDown", "keyUp"]) {
    await session.send("Input.dispatchKeyEvent", {
      type,
      key,
      code: key === " " ? "Space" : key,
    });
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Visible game windows, topmost-first (EnumWindows walks the z-order), as
// "title\tleft,top,width,height\ttopmost" with the raw physical window rect
// (Windows 10/11 include an invisible resize border of a few px in it).
function nativeWindows() {
  // Delegate (script block) output is dropped, so collect into a list.
  const script = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class VsWin {
  public delegate bool P(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
# Otherwise Windows hands this process DPI-virtualized (scaled-down) rects.
[void][VsWin]::SetProcessDPIAware()
$ids = @(Get-Process vectspace -ErrorAction SilentlyContinue | ForEach-Object Id)
$found = New-Object System.Collections.Generic.List[string]
[void][VsWin]::EnumWindows({ param($h,$l) $p=[uint32]0; [void][VsWin]::GetWindowThreadProcessId($h,[ref]$p); if ($ids -contains [int]$p -and [VsWin]::IsWindowVisible($h)) { $s = New-Object Text.StringBuilder 512; [void][VsWin]::GetWindowText($h,$s,512); if ($s.Length) { $r = New-Object VsWin+R; [void][VsWin]::GetWindowRect($h,[ref]$r); $top = ([VsWin]::GetWindowLong($h,-20) -band 8) -ne 0; $found.Add($s.ToString() + "\`t" + $r.L + "," + $r.T + "," + ($r.Ri-$r.L) + "," + ($r.B-$r.T) + "\`t" + $(if ($top) { "topmost" } else { "normal" })) } }; return $true }, [IntPtr]::Zero)
$found
`;
  return execFileSync("pwsh", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);
}

const nativeTitles = () => nativeWindows().map((line) => line.split("\t")[0]);

const usage = `commands:
  launch                         start \`npm run tauri dev\` with CDP on :${PORT}; waits for the title screen
  stop                           kill the app and dev server (process tree + ports 1420/${PORT})
  state [main|secondary]         screen, dialogue, block hint, choices, buttons (both windows by default)
  titles                         native window titles (Win32)
  windows                        native title, rect (physical x,y,w,h) and topmost flag, front-most first
  replay <hotspotId>             title screen -> 章节地图 -> hotspot (e.g. window_pair)
  button <win> <text>            click the button whose trimmed text equals <text> (e.g. 标题, 设置, 关闭)
  choose <win> <choiceId>        click a choice option by id
  key <win> <key>                send a key (Enter advances; the first may only finish the typewriter)
  shot <win> [file.png]          screenshot (default %TEMP%\\vectspace-run\\<win>.png)
  clips <win> x y w h n ms       hash n cropped frames (CSS px) to detect animation
  eval <win> <js>                evaluate JS in a window, print the JSON result`;

const [command, ...args] = process.argv.slice(2);

// A failed top-level await surfaces as an uncaught exception in ESM.
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    console.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}

switch (command) {
  case "launch": {
    if (existsSync(PID_FILE)) {
      console.log(
        `note: ${PID_FILE} exists; run "stop" first if an old app is still up`,
      );
    }
    const log = openSync(LOG, "w");
    const child = spawn("npm run tauri dev", {
      shell: true,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
      },
    });
    child.unref();
    writeFileSync(PID_FILE, String(child.pid));
    console.log(`launched pid ${child.pid}; log ${LOG}`);
    try {
      await waitFor(
        async () =>
          (await withWindow("main", (session) => session.evaluate(STATE_JS)))
            .screen === "title",
        15 * 60_000,
        "the title screen",
      );
    } catch (error) {
      console.error(String(error));
      console.error(
        readFileSync(LOG, "utf8").split(/\r?\n/).slice(-20).join("\n"),
      );
      process.exit(1);
    }
    console.log("ready: main window is on the title screen");
    break;
  }
  case "stop": {
    if (existsSync(PID_FILE)) {
      const pid = readFileSync(PID_FILE, "utf8").trim();
      try {
        execFileSync("taskkill", ["/PID", pid, "/T", "/F"], {
          stdio: "ignore",
        });
      } catch {
        // already gone
      }
      rmSync(PID_FILE, { force: true });
    }
    // Leftovers from a crashed or hand-started run. `Get-NetTCPConnection`
    // fails the exit status when nothing listens, even when silenced.
    execFileSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `Get-Process vectspace -ErrorAction SilentlyContinue | Stop-Process -Force; ` +
          `Get-NetTCPConnection -State Listen -LocalPort 1420,${PORT} -ErrorAction SilentlyContinue | ` +
          `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; exit 0`,
      ],
      { stdio: "ignore" },
    );
    console.log("stopped");
    break;
  }
  case "state": {
    for (const which of args.length ? args : ["main", "secondary"]) {
      const session = await windowSession(which);
      if (!session) {
        console.log(`== ${which}: (no window)`);
        continue;
      }
      try {
        console.log(`== ${which}`);
        console.log(JSON.stringify(await session.evaluate(STATE_JS), null, 2));
      } finally {
        session.close();
      }
    }
    break;
  }
  case "titles":
    for (const title of nativeTitles()) console.log(title);
    break;
  case "windows":
    for (const line of nativeWindows()) console.log(line);
    break;
  case "replay": {
    const [hotspot] = args;
    await withWindow("main", async (session) => {
      const { screen } = await session.evaluate(STATE_JS);
      if (screen === "title")
        await session.evaluate(clickButtonByText("章节地图"));
      else if (screen !== "chapter-map")
        throw new Error(`main is on "${screen}"; go back to the title first`);
      await waitFor(
        () =>
          session.evaluate(
            `!!document.querySelector('[data-hotspot-id=${JSON.stringify(hotspot)}]')`,
          ),
        10_000,
        `hotspot ${hotspot}`,
      );
      await session.evaluate(
        `document.querySelector('[data-hotspot-id=${JSON.stringify(hotspot)}]').click()`,
      );
      await waitFor(
        async () => (await session.evaluate(STATE_JS)).screen === "game",
        15_000,
        "the replay to start",
      );
    });
    console.log(`entered replay ${hotspot}`);
    break;
  }
  case "button": {
    const [which, text] = args;
    console.log(
      await withWindow(which, (session) =>
        session.evaluate(clickButtonByText(text)),
      ),
    );
    break;
  }
  case "choose": {
    const [which, choiceId] = args;
    await withWindow(which, (session) =>
      session.evaluate(`(() => {
        const button = document.querySelector('[data-choice-id=${JSON.stringify(choiceId)}]');
        if (!button) throw new Error('no choice ' + ${JSON.stringify(choiceId)});
        if (button.disabled) throw new Error('choice ' + ${JSON.stringify(choiceId)} + ' is disabled');
        button.click();
      })()`),
    );
    console.log(`chose ${choiceId} in ${which}`);
    break;
  }
  case "key": {
    const [which, key] = args;
    await withWindow(which, (session) => pressKey(session, key));
    console.log(`key ${key} -> ${which}`);
    break;
  }
  case "shot": {
    const [which, file = join(RUN_DIR, `${which}.png`)] = args;
    const { data } = await withWindow(which, (session) =>
      session.send("Page.captureScreenshot", { format: "png" }),
    );
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(file);
    break;
  }
  case "clips": {
    const [which, ...numbers] = args;
    const [x, y, width, height, count, interval] = numbers.map(Number);
    const hashes = await withWindow(which, async (session) => {
      const result = [];
      for (let index = 0; index < count; index += 1) {
        const { data } = await session.send("Page.captureScreenshot", {
          format: "png",
          clip: { x, y, width, height, scale: 1 },
        });
        result.push(createHash("md5").update(data).digest("hex").slice(0, 8));
        await sleep(interval);
      }
      return result;
    });
    console.log(
      `${new Set(hashes).size} distinct of ${count}: ${hashes.join(" ")}`,
    );
    break;
  }
  case "eval": {
    const [which, ...rest] = args;
    console.log(
      JSON.stringify(
        await withWindow(which, (session) => session.evaluate(rest.join(" "))),
        null,
        2,
      ),
    );
    break;
  }
  default:
    console.log(usage);
    process.exit(command ? 1 : 0);
}
