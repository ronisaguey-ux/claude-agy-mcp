#!/usr/bin/env bash
# mcp_call.sh <tool> '<json-args>' [sleep_seconds]
# One JSON-RPC tools/call against claude-agy-mcp. tmux-hosted agy sessions persist
# after this process exits (they live in tmux), so a per-call process is fine.
set -euo pipefail
MCP=/home/roni/Roni_workspace/claude-agy-mcp/bin/claude-agy-mcp.js
SLEEP="${3:-25}"
export CLAUDE_BIN=/home/roni-saguey/.local/bin/claude
export AGY_BIN=/home/roni-saguey/.local/bin/agy
export CLAUDE_CONFIG_DIR=/home/roni-saguey/.claude_worker_config
export PATH=/home/roni-saguey/.local/bin:/usr/local/bin:/usr/bin:/bin
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"cli","version":"1"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
  sleep "$SLEEP"
} | node "$MCP" 2>/dev/null | grep '"id":2' | python3 -c '
import sys,json
for line in sys.stdin:
    try: d=json.loads(line)
    except: continue
    r=d.get("result") or {}
    if r.get("isError"):
        print("TOOL ERROR:", r.get("content",[{}])[0].get("text",""))
    else:
        for c in r.get("content",[]):
            if c.get("type")=="text": print(c.get("text",""))
'
