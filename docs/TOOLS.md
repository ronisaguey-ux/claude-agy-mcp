# Tool reference

Every tool returns text. A failure comes back as `isError: true` with the reason, never as an
empty success.

## Anatomy of the two id spaces

```
claude background session   8 hex chars          e.g. c75c989e
tmux session                a name               e.g. claude_worker, agy_worker
```

`agent_list` shows both. Anything that takes a `session` accepts an id, a name, or an unambiguous
prefix — ambiguity is refused with the candidate list rather than guessed at.

## Recipes

### Take over another agent's work when it runs out of quota
```
agent_limits                       # find the limited session
agent_read    session=<worker>     # read where it stopped
agent_spawn   harness=claude  prompt="<full handoff>"  cwd=/path
```
Spawn the replacement **before** stopping anything. A handoff written after the old session is
gone is a handoff written from memory.

### Fan out and collect
```
agent_spawn_many  harness=claude  count=4  prompt="<task>"  name_prefix=worker
agent_list
agent_read  session=worker_1  wait_idle=true
agent_stop  session=worker_1
```

### Restart yourself after a config change
```
self_openbot  dry_run=true     # always look first
self_openbot                   # new terminal up, then this process retires
```

### Hand work to another agent through the bridge
```
bridge_send  to=antigravity  content="<ask>"  priority=high
bridge_inbox for=opencode
bridge_status history_with=antigravity
```

## Harness limitations, stated plainly

- **agy has no background sessions.** `agent_spawn harness=agy mode=background` returns a refusal.
  Its sessions are tmux-hosted TUIs; the only programmatic surface is keystrokes and a screen.
- **`agent_set_model` on a live tmux session types `/model`.** A running process cannot be
  re-pointed any other way, and a launcher flag wins on the next start instead.
- **`agent_respawn` is Claude-only.** It exists so a session picks up the current binary — a
  running process keeps the model list it booted with.
- **`agent_stop` on a tmux session destroys the session.** The transcript on disk survives, but the
  pane is gone. Claude background sessions keep their conversation and can be resumed.
