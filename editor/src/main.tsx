import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { App } from "./App";
import { installBrowserGuards } from "@vectspace/presentation-core/browser-guards";

installBrowserGuards({
  allowContextMenu: true,
  // Editor-owned shortcuts that WebView2 would otherwise claim.
  passThrough: (event) =>
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    event.key.toLowerCase() === "f",
});

const root = document.getElementById("root");
if (root === null) throw new Error("缺少编辑器根元素 #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
