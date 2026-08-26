import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installBrowserGuards } from "./browserGuards";

installBrowserGuards();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
