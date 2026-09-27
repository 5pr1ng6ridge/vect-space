/**
 * Browser design preview (dev only): renders the real App with the Tauri
 * host replaced by an in-memory demo project, so the UI can be inspected and
 * screenshotted in any browser via `/preview.html`.
 *
 * Query parameters drive the UI into a state after the project opens:
 *   ?select=<nodeId>   select a graph node
 *   ?tab=<label>       click a sidebar tab / activity item by its label
 *   ?view=script       switch to the script view
 *   ?open=<label>      click any button by its accessible name afterwards
 *   ?dbl=<nodeId>      double-click a graph node (opens its workspace)
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../styles/index.css";
import { App } from "../App";
import { editorApi } from "../api";
import { demoProject } from "./demoProject";

// Minimal Tauri host stand-in: asset URLs resolve to nothing and every
// host command fails, which previews treat like a missing asset.
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  configurable: true,
  value: {
    convertFileSrc: (path: string) => `about:blank#${encodeURIComponent(path)}`,
    invoke: () => Promise.reject(new Error("设计预览中没有宿主进程")),
    transformCallback: () => 0,
  },
});

const api = editorApi as Record<string, unknown>;
api.pickProjectDirectory = () => Promise.resolve("C:/demo/vectspace-game");
api.openProject = () => Promise.resolve(demoProject());
api.validateProject = () => Promise.resolve();
api.saveProject = () =>
  Promise.resolve({
    project: demoProject(),
    changed_paths: [],
    deleted_paths: [],
    warnings: [],
  });

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

const params = new URLSearchParams(window.location.search);
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function buttonNamed(name: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>("button")).find(
    (button) =>
      (button.getAttribute("aria-label") ?? button.textContent ?? "").trim() ===
      name,
  );
}

function nodeCard(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${CSS.escape(id)}"] article, .react-flow__node[data-id="${CSS.escape(id)}"] .story-node`,
  );
}

async function drive(): Promise<void> {
  if (params.get("welcome") !== null) return;
  await wait(100);
  buttonNamed("打开项目目录")?.click();
  await wait(600);
  const tab = params.get("tab");
  if (tab !== null) buttonNamed(tab)?.click();
  if (params.get("view") === "script") buttonNamed("脚本")?.click();
  await wait(300);
  const select = params.get("select");
  if (select !== null) {
    nodeCard(select)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  const dbl = params.get("dbl");
  if (dbl !== null) {
    nodeCard(dbl)?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  }
  await wait(300);
  const open = params.get("open");
  if (open !== null) buttonNamed(open)?.click();
}

void drive();
