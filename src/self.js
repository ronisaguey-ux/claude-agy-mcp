// Self-management: restart the agent that is calling this tool.
//
// The point is that a config or plugin change usually only takes effect after the host process
// restarts, and until now that meant asking a human to do it. The hazard is obvious — the caller
// is killed by its own request — so the sequence is ordered so that a NEW terminal is fully up
// before the old process is touched, and the kill is done by a detached helper after a delay, so
// the tool result is delivered first and there is never a window with no agent running.

import fs from 'node:fs/promises';
import path from 'node:path';
import { run, sleep } from './exec.js';

const HELPER = `${process.env.HOME}/.local/bin/self_openbot.sh`;

/** Terminal emulators, best first. Konsole is the desktop's own and the one already in use. */
const TERMINALS = [
  { cmd: 'konsole', args: (c) => ['-e', 'bash', '-lc', c] },
  { cmd: 'x-terminal-emulator', args: (c) => ['-e', 'bash', '-lc', c] },
  { cmd: 'gnome-terminal', args: (c) => ['--', 'bash', '-lc', c] },
  { cmd: 'xfce4-terminal', args: (c) => ['-e', `bash -lc '${c}'`] },
  { cmd: 'xterm', args: (c) => ['-e', 'bash', '-lc', c] },
];

async function findTerminal() {
  for (const t of TERMINALS) {
    const r = await run('bash', ['-lc', `command -v ${t.cmd}`], { timeout: 5000 });
    if (r.code === 0 && r.stdout.trim()) return { ...t, bin: r.stdout.trim() };
  }
  return null;
}

/** Write the detached restarter. Doing the kill from a helper is what makes the call survivable. */
async function ensureHelper() {
  const script = `#!/usr/bin/env bash
# self_openbot helper — opened by the self_openbot MCP tool.
# Args: <delaySeconds> <mode>   mode = serve|opencode
# Why a helper: the caller must survive long enough to receive its own tool result, so the kill
# happens out of process, after a delay, once a replacement is already running.
set -uo pipefail
DELAY="\${1:-4}"
MODE="\${2:-serve}"
LOG="/tmp/self_openbot.log"
log() { printf '%s  %s\\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

log "helper up (delay=\${DELAY}s mode=\${MODE})"
sleep "\$DELAY"

case "\$MODE" in
  serve)
    # Restart the opencode serve unit; the TUI reconnects on its own.
    if systemctl --user list-unit-files opencode-serve.service >/dev/null 2>&1; then
      log "restarting opencode-serve.service"
      systemctl --user restart opencode-serve.service >>"$LOG" 2>&1 || log "restart failed"
    else
      log "no opencode-serve unit; killing the serve process tree"
      for p in \$(ps -eo pid,args | awk '/opencode/ && /serve/ && !/awk/ {print $1}'); do
        kill -9 "\$p" 2>/dev/null && log "killed \$p"
      done
    fi
    ;;
  opencode)
    # Kill whatever is running the old TUI so the freshly launched one is the only instance.
    log "mode=opencode: new terminal already launched, nothing to kill here"
    ;;
esac
log "helper done"
`;
  await fs.writeFile(HELPER, script, { mode: 0o755 });
  return HELPER;
}

/**
 * Launch a fresh agent in a new terminal and then retire the current process.
 * Returns BEFORE the kill; the helper finishes the job out of band.
 */
export async function selfOpenbot({ command = 'openbot', delay = 5, cwd = null, dryRun = false } = {}) {
  const term = await findTerminal();
  const hasOpenbot = (await run('bash', ['-lc', 'command -v openbot'], { timeout: 5000 })).stdout.trim();
  const scriptPath = await ensureHelper();

  const inner = cwd ? `cd ${JSON.stringify(cwd)} && ${command}` : command;

  if (dryRun) {
    return {
      dryRun: true,
      terminal: term ? term.bin : null,
      command: inner,
      helper: scriptPath,
      wouldRun: `setsid ${term ? term.bin : '<no terminal>'} ...`,
    };
  }

  if (!term) {
    throw new Error('no terminal emulator found (tried konsole, x-terminal-emulator, gnome-terminal, xfce4-terminal, xterm)');
  }
  if (!hasOpenbot) {
    throw new Error(`\`${command}\` is not on PATH — refusing to kill this session with nothing to replace it`);
  }

  // 1. Start the replacement FIRST. Only once it is up do we consider killing anything.
  const launch = await run('bash', ['-lc', `setsid ${term.bin} ${term.args(inner).map((a) => JSON.stringify(a)).join(' ')} </dev/null >/dev/null 2>&1 & disown`], { timeout: 15000 });
  await sleep(1500);

  const alive = await run('bash', ['-lc', `pgrep -af ${JSON.stringify(command)} | head -5`], { timeout: 5000 });

  // 2. Then, and only then, schedule the retirement of this one.
  await run('bash', ['-lc', `setsid bash ${JSON.stringify(scriptPath)} ${Number(delay)} serve </dev/null >/dev/null 2>&1 & disown`], { timeout: 10000 });

  return {
    launched: true,
    terminal: term.bin,
    command: inner,
    replacementSeen: alive.stdout.trim() || null,
    killInSeconds: Number(delay),
    helper: scriptPath,
    log: '/tmp/self_openbot.log',
    note: 'A new terminal was opened first. This session will be restarted by the helper in a few seconds; the TUI reconnects on its own.',
    launchStderr: launch.stderr.trim() || undefined,
  };
}
