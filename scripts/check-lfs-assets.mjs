import { Buffer } from "node:buffer";
import console from "node:console";
import { open, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const LFS_SIGNATURE = "version https://git-lfs.github.com/spec/v1";
const roots = process.argv.slice(2);

if (roots.length === 0) {
  console.error("用法: node scripts/check-lfs-assets.mjs <资源目录> [...]");
  process.exit(2);
}

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

async function isLfsPointer(path) {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(128);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return header
      .subarray(0, bytesRead)
      .toString("utf8")
      .startsWith(LFS_SIGNATURE);
  } finally {
    await file.close();
  }
}

const unresolved = [];
for (const root of roots) {
  for await (const path of walk(resolve(root))) {
    if (await isLfsPointer(path)) unresolved.push(path);
  }
}

if (unresolved.length > 0) {
  console.error("以下素材仍是 Git LFS 指针，无法用于开发预览：");
  for (const path of unresolved) console.error(`  - ${path}`);
  console.error("请在仓库根目录运行 `git lfs pull`，然后重新启动开发服务。");
  process.exit(1);
}

console.log("素材预检通过：没有未下载的 Git LFS 指针。");
