/* global process, console */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lake = path.join(
  homedir(),
  ".elan",
  "bin",
  process.platform === "win32" ? "lake.exe" : "lake",
);
if (!existsSync(lake)) {
  console.error(
    "Lean build requires elan. Install it from https://github.com/leanprover/elan, then run npm run lean:build.",
  );
  process.exit(1);
}
const result = spawnSync(lake, ["build"], {
  cwd: path.join(root, "lean"),
  stdio: "inherit",
  windowsHide: true,
});
if (result.error)
  console.error(`Could not start lake: ${result.error.message}`);
process.exit(result.status ?? 1);
