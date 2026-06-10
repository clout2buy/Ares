import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const removed = [];

function exists(target) {
  return fs.existsSync(target);
}

function remove(target) {
  if (!exists(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
  removed.push(path.relative(root, target).replaceAll(path.sep, "/"));
}

function removeMatchingFiles(dir, predicate) {
  if (!exists(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && predicate(entry.name)) {
      remove(path.join(dir, entry.name));
    }
  }
}

const packagesDir = path.join(root, "packages");
if (exists(packagesDir)) {
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = path.join(packagesDir, entry.name);
    remove(path.join(packageDir, "dist"));
    removeMatchingFiles(packageDir, (name) => name.endsWith(".tsbuildinfo"));
  }
}

removeMatchingFiles(root, (name) => name.endsWith(".tsbuildinfo"));
remove(path.join(root, ".ares"));

remove(path.join(root, "tauri", "dist"));
remove(path.join(root, "tauri", "src-tauri", "target"));
remove(path.join(root, "tauri", "src-tauri", "gen"));

removeMatchingFiles(path.join(root, "tauri"), (name) => /^target-.*\.png$/.test(name) || name.endsWith(".log"));

if (removed.length === 0) {
  console.log("No generated output found.");
} else {
  console.log(`Removed ${removed.length} generated path(s):`);
  for (const item of removed) console.log(`- ${item}`);
}
