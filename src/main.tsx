import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import SecondaryWindow from "./SecondaryWindow";
import { installBrowserGuards } from "@vectspace/presentation-core/browser-guards";

installBrowserGuards();

/**
 * The bundle is shared by both game windows. The window identity is the host's
 * own WebView label — never a URL parameter or a JS-supplied value — so a
 * secondary window can never bootstrap as the main story.
 *
 * `getCurrentWindow()` throws outside Tauri (for example a plain `vite` dev
 * page), which must keep rendering the main application exactly as before.
 */
export function resolveWindowRole(): "main" | "secondary" {
  try {
    return getCurrentWindow().label === "secondary" ? "secondary" : "main";
  } catch {
    return "main";
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {resolveWindowRole() === "secondary" ? <SecondaryWindow /> : <App />}
  </React.StrictMode>,
);
