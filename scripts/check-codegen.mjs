/* global URL, process, console */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "vectspace-codegen-"));
const exportBase = join(temporary, "base");
const schemaOutput = join(temporary, "schemas");

function run(command, args, env = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else files.push(path);
  }
  return files;
}

try {
  // ts-rs resolves export_to paths relative to TS_RS_EXPORT_DIR.  Nesting the
  // temporary base three levels deep mirrors the protocol crate and keeps all
  // generated output outside the checkout.
  const exportDir = join(
    exportBase,
    "crates",
    "vectspace-protocol",
    "bindings",
  );
  await run(
    "cargo",
    ["run", "-p", "vectspace-core", "--bin", "export_schemas"],
    {
      VECTSPACE_SCHEMA_OUT: schemaOutput,
    },
  );
  await run("cargo", ["test", "-p", "vectspace-protocol", "export_bindings"], {
    TS_RS_EXPORT_DIR: exportDir,
  });

  const expectedRoots = [
    [join(root, "src-tauri", "gen", "content-schemas"), schemaOutput],
    [
      join(root, "shared", "generated"),
      join(exportBase, "shared", "generated"),
    ],
  ];
  for (const [currentRoot, generatedRoot] of expectedRoots) {
    const currentFiles = (await filesUnder(currentRoot))
      .map((path) => path.slice(currentRoot.length + 1))
      // The barrel is intentionally hand-maintained; individual contracts
      // are the generated surface checked against ts-rs output.
      .filter((name) => name !== "index.ts");
    const generatedFiles = (await filesUnder(generatedRoot)).map((path) =>
      path.slice(generatedRoot.length + 1),
    );
    const names = [...new Set([...currentFiles, ...generatedFiles])].sort();
    for (const name of names) {
      const current = await readFile(join(currentRoot, name)).catch(() => null);
      const generated = await readFile(join(generatedRoot, name)).catch(
        () => null,
      );
      if (!current || !generated || !current.equals(generated)) {
        throw new Error(`generated binding is stale: ${name}`);
      }
    }
  }
  console.log("codegen check passed (working tree was not written)");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
