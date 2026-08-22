# MCP Task Server

Server MCP (Model Context Protocol) điều phối vòng lặp **Coder ↔ Reviewer đa repo** qua GitHub Issues — nguồn sự thật là label `agent:*` / `status:*` theo `docs/AGENT_HANDOFF_PROTOCOL.md`.

Zero-dependency: Node.js thuần, MCP stdio transport (NDJSON JSON-RPC 2.0), thao tác qua `gh` CLI (dùng auth local của `gh`).

## State machine

```
task_create → status:ready-for-cline (+agent:cline)   [hoặc status:queued]
task_claim  → ready-for-cline|queued   → status:in-progress
task_handoff→ in-progress|changes-requested → status:review-requested (+agent:gpt)
task_review → review-requested → approved | changes-requested (+agent:cline)
task_block  → bất kỳ → status:blocked
```

Mọi transition sai thứ tự bị chặn fail-closed trước khi mutation.

## Tools

| Tool | Mô tả |
|---|---|
| `task_list` | Liệt kê task trên 1/nhiều repo (`repo` hoặc `repos[]`, mặc định env `MCP_TASK_REPOS`) |
| `task_get` | Xem chi tiết Issue task (number, title, agent, status, labels) |
| `task_create` | Tạo Issue + label theo state machine |
| `task_claim` | Coder nhận task → `in-progress` |
| `task_handoff` | Coder bàn giao → `review-requested` + `agent:gpt` (tùy chọn kèm số PR) |
| `task_review` | Reviewer chấm `approve` / `request-changes` |
| `task_block` | Đánh dấu `blocked` + lý do |

## Đa repo

- Env `MCP_TASK_REPOS="owner/repo1,owner/repo2"` cho danh sách mặc định.
- Tham số `repo` trên từng tool ghi đè cho call đó.
- Không có env/cấu hình → fallback origin của thư mục làm việc.

## Đăng ký vào Cline

Thêm vào `cline_mcp_settings.json` (Cline → MCP Servers → Configure):

```json
{
  "mcp-task-server": {
    "command": "node",
    "args": ["<đường-dẫn-repo>/mcp-task-server/server.mjs"],
    "env": { "MCP_TASK_REPOS": "owner/repo1,owner/repo2" },
    "disabled": false,
    "autoApprove": ["task_list", "task_get"]
  }
}
```

Hoặc dùng file `.mcp.json` ở root repo (đã có sẵn) với client hỗ trợ project-scope.

## Test

```bash
node mcp-task-server/test-server.mjs   # yêu cầu gh đã đăng nhập; chỉ mutation-safe (negative test không đụng label)
```
