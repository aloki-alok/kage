import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// private-data-guard.ts
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

// logic.ts
var PRIVATE_TOOL = /^mcp__.*(gmail|google_drive|google_calendar|granola|fireflies)/i;
function privateToolRefusal(tool, sender) {
  if (!PRIVATE_TOOL.test(tool) || sender === "owner") return void 0;
  return `${tool} reads the owner's private data, and this task did not come from the owner. Reply that this needs the owner, and stop.`;
}
var senderFile = (dir, thread2) => `${dir}/sender/${thread2.replace(/[^A-Za-z0-9.]/g, "_")}`;

// private-data-guard.ts
var thread = process.env.KAGE_THREAD;
if (thread) {
  const { tool_name } = JSON.parse(readFileSync(0, "utf8"));
  const dir = dirname(process.env.KAGE_ENV || `${process.env.HOME}/.config/kage/env`);
  let sender;
  try {
    sender = readFileSync(senderFile(dir, thread), "utf8").trim();
  } catch {
  }
  const reason = privateToolRefusal(tool_name, sender);
  if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}
