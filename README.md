# claude-agy-mcp

An MCP server that lets any agent drive **Claude Code** and **Antigravity (`agy`)** sessions as
controlled subagents — list them, start them, talk to them, pause them, switch their model, read
their output, and run several at once.

It exists because an agent that can spawn another agent but cannot see it, wait for it, or stop it
has not gained a worker; it has gained a race condition.

```jsonc
// mcp config
{
  "mcpServers": {
    "claude-agy": {
      "command": "node",
      "args": ["/absolute/path/to/claude-agy-mcp/bin/claude-agy-mcp.js"]
    }
  }
}
```

No dependencies. Node >= 20.12. Nothing to install.

---

## The problem it solves

Both harnesses are full-screen TUIs. Claude Code additionally ships a real background-session API
(`claude --bg`, `claude agents --json`, `logs`, `stop`, `respawn`, `rm`) and this server prefers it
wherever it exists, because a structured API beats scraping a screen. `agy` has no equivalent, so
those sessions are driven through tmux — and the tool says so rather than pretending otherwise.

| | Claude Code | Antigravity (`agy`) |
|---|---|---|
| background session | yes (`--bg`, real id, real log) | no |
| list sessions | `agents --json` | tmux |
| send a message | `--bg --resume <id>` | keystrokes |
| stop / resume | `stop` / `resume` | tmux kill |
| switch model | next turn | `/model` in-session |

## Tools

**Inventory**
- `agent_list` — every session, both harnesses, one table
- `agent_inventory` — which binaries exist, their versions, extra installs that could shadow them
- `agent_models` — known model ids and effort levels per harness

**Read**
- `agent_read` — recent output, optionally waiting for the agent to stop generating
- `agent_wait_idle` — block until output stops changing
- `agent_limits` — is a session rate- or usage-limited right now
- `agent_transcript` — where the conversation lives on disk

**Spawn**
- `agent_spawn` — one session (background for Claude, tmux for agy)
- `agent_spawn_many` — a fan-out, reporting partial failure honestly

**Talk**
- `agent_send` — send, and by default wait for the answer
- `agent_interrupt` — stop generation without ending the session

**Lifecycle**
- `agent_stop`, `agent_resume`, `agent_respawn`, `agent_set_model`

**Bridge** (agents cannot call each other directly; this is the channel that reaches them)
- `bridge_send`, `bridge_inbox`, `bridge_status`

**Self**
- `self_openbot` — restart the host that is running this tool, after a config change, with no human

## Design notes that are load-bearing

**Idle detection is movement-based, not marker-based.** A "is it busy?" check built on one
vendor's status string is one rename away from lying — that has already happened here once, and
the failure mode is that a working agent reads as idle. This server watches whether the screen is
still changing, and only uses the busy marker as a secondary signal so a long silent think is not
mistaken for a finish.

**A tool that cannot do the thing says so.** `agent_spawn` for agy with `mode=background` returns
"agy has no background-session mode", not an empty success. A silent no-op is the failure that
makes an orchestration layer worthless, because the caller cannot tell it apart from work.

**The bridge appends under a lock and fsyncs.** It is written by more than one process, and a torn
line makes the whole log unparseable. That failure has already destroyed an inbox on this machine.

**`self_openbot` starts the replacement before it retires anything.** The new terminal comes up
first, and the kill is performed by a detached helper after a delay so the tool result is
delivered before the process exits. The command is verified to exist on `PATH` first — refusing is
correct when the alternative is killing the session with nothing to replace it.

## Test

```bash
node test/smoke.mjs
```

Speaks the real protocol over a pipe to a real child process: handshake, `tools/list`, a live
inventory read, the bridge, the dry-run path, an unknown tool, and a failing tool call. It exists
to catch a server that starts but lists nothing or corrupts stdout — which a unit test against the
handlers would never see.
