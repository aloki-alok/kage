import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// private-data-guard.ts
import { readFileSync } from "node:fs";
import { dirname as dirname2 } from "node:path";

// core/guards.ts
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
var PRIVATE_TOOL = /^mcp__.*(gmail|google_drive|google_calendar|granola|fireflies)/i;
function privateToolRefusal(tool, sender) {
  if (!PRIVATE_TOOL.test(tool) || sender === "owner") return void 0;
  return `${tool} reads the owner's private data, and this task did not come from the owner. Reply that this needs the owner, and stop.`;
}
var memoryDirs = (home, envFile, env) => ({
  own: env.KAGE_MEMORY || `${envFile.replace(/\/[^/]*$/, "")}/memory`,
  owner: env.KAGE_OWNER_MEMORY || `${home}/.claude/projects/${home.replace(/[^A-Za-z0-9]/g, "-")}/memory`
});
var WRITE_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
function ownerMemoryRefusal(tool, input, ownerMemory, home = process.env.HOME ?? "") {
  const raw = input.file_path ?? input.notebook_path;
  if (!WRITE_TOOLS.has(tool) || !raw) return;
  const file = realish(raw.replace(/^~(?=\/)/, home));
  const dir = realish(ownerMemory);
  if (!file.toLowerCase().startsWith(`${dir.toLowerCase()}/`)) return;
  const name = file.slice(dir.length + 1);
  if (/^user_[\w-]+\.md$/.test(name) || name === "MEMORY.md" && tool !== "Write") return;
  return `The owner's memory takes only people notes (user_<name>.md) from you. Save your own lessons in your own memory folder.`;
}
function realish(p) {
  const rest = [];
  for (let cur = resolve(p); ; cur = dirname(cur)) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
    }
    if (dirname(cur) === cur) return resolve(p);
    rest.unshift(basename(cur));
  }
}
var senderFile = (dir, thread2) => `${dir}/sender/${thread2.replace(/[^A-Za-z0-9.]/g, "_")}`;

// private-data-guard.ts
var thread = process.env.KAGE_THREAD;
if (thread) {
  const { tool_name, tool_input } = JSON.parse(readFileSync(0, "utf8"));
  const envFile = process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`;
  const dir = dirname2(envFile);
  let sender;
  try {
    sender = readFileSync(senderFile(dir, thread), "utf8").trim();
  } catch {
  }
  const reason = privateToolRefusal(tool_name, sender) ?? ownerMemoryRefusal(tool_name, tool_input ?? {}, memoryDirs(process.env.HOME, envFile, process.env).owner);
  if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}
