const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const ignoredDirs = new Set(["node_modules", "artifacts", "cache", "_archive", ".git"]);

function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        collectJsFiles(path.join(dir, entry.name), out);
      }
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(path.join(dir, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".cjs")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = collectJsFiles(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);
