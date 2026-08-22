#!/usr/bin/env node
/**
 * Đăng ký MCP Task Server vào cline_mcp_settings.json (toàn cục).
 * An toàn: backup .bak-<ts> trước khi ghi; read-after-write xác nhận.
 * Chạy: node mcp-task-server/register-cline.mjs
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SETTINGS = join(
  process.env.APPDATA ?? "",
  "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json",
);

const serverDir = dirname(fileURLToPath(import.meta.url));
const ENTRY_NAME = "mcp-task-server";
const entry = {
  command: "node",
  args: [join(serverDir, "server.mjs").replace(/\//g, "\\")],
  env: { MCP_TASK_REPOS: process.env.MCP_TASK_REPOS ?? "duongpdddic-droid/QLDA_DTXD" },
  disabled: false,
  autoApprove: ["task_list", "task_get"],
};

let raw;
try {
  raw = readFileSync(SETTINGS, "utf8");
} catch {
  console.error(`KHÔNG tìm thấy ${SETTINGS} — đăng ký thủ công theo mcp-task-server/README.md`);
  process.exit(2);
}

const config = JSON.parse(raw); // fail nếu JSON hỏng → không ghi gì
const backup = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
copyFileSync(SETTINGS, backup);
config.mcpServers = config.mcpServers ?? {};
const existed = ENTRY_NAME in config.mcpServers;
config.mcpServers[ENTRY_NAME] = entry;

writeFileSync(SETTINGS, JSON.stringify(config, null, 2) + "\n", "utf8");

// Read-after-write
const verify = JSON.parse(readFileSync(SETTINGS, "utf8"));
if (!verify.mcpServers?.[ENTRY_NAME]?.args?.[0]) {
  console.error("Read-back THẤT BẠI — kiểm tra file thủ công. Backup tại: " + backup);
  process.exit(1);
}
console.log(`${existed ? "CẬP NHẬT" : "ĐĂNG KÝ"} OK: ${ENTRY_NAME}`);
console.log(`Settings: ${SETTINGS}`);
console.log(`Backup:   ${backup}`);
