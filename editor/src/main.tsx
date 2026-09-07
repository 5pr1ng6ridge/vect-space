import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "katex/dist/katex.min.css";
import "./styles.css";
import { App } from "./App";
import { installBrowserGuards } from "@vectspace/presentation-core/browser-guards";

installBrowserGuards(true);

const root = document.getElementById("root");
if (root === null) throw new Error("缺少编辑器根元素 #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
