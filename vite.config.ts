import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  // Keep Vite's mutable optimizer cache outside node_modules.  On Windows,
  // antivirus/WebView processes can hold node_modules/.vite and make the
  // first `tauri dev` fail while Vite tries to replace its dependency tree.
  cacheDir: ".vite-cache",

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. never watch Rust sources or Cargo artifacts. The workspace target
      // directory contains executables that are locked while rustc links them
      // on Windows, and attempting to watch them aborts the first dev launch.
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
}));
