// One unified view of every agent on the machine, whichever harness and whichever substrate.
//
// Two naming worlds exist and they must not be confused:
//   * Claude background sessions — a short hex id, driven by `claude agents/logs/stop`.
//   * tmux sessions — `claude_worker`, `agy_worker`, ... — driven by keystrokes.
// A Claude session can appear in BOTH (a background session the user attached to). This module
// reports them as separate rows and marks the overlap rather than hiding it.

import * as claude from './claude.js';
import * as agy from './agy.js';
import * as tmux from './tmux.js';

const CLAUDE_TMUX_HINT = /claude/i;
const AGY_TMUX_HINT = /agy|antigravity/i;

export async function listAll() {
  const [background, tmuxSessions] = await Promise.all([
    claude.listBackground({ all: true }).catch(() => []),
    tmux.listSessions().catch(() => []),
  ]);

  const rows = [];

  for (const s of background) {
    rows.push({
      harness: 'claude',
      kind: 'background',
      id: s.id,
      name: s.name || null,
      state: s.state || 'unknown',
      cwd: s.cwd || null,
      sessionId: s.sessionId || null,
      startedAt: s.startedAt || null,
      // How the caller interacts with it.
      controls: ['read', 'send', 'stop', 'resume', 'respawn', 'remove', 'logs'],
    });
  }

  for (const t of tmuxSessions) {
    const harness = AGY_TMUX_HINT.test(t.name) ? 'agy' : CLAUDE_TMUX_HINT.test(t.name) ? 'claude' : 'tmux';
    let preview = null;
    try { preview = (await tmux.captureContent(t.name, { lines: 3 })).slice(0, 400); } catch {}
    rows.push({
      harness,
      kind: 'tmux',
      id: t.name,
      name: t.name,
      state: t.attached ? 'attached' : 'detached',
      cwd: null,
      sessionId: null,
      startedAt: t.created,
      lastActivity: t.activity,
      preview,
      controls: ['read', 'send', 'interrupt', 'stop'],
    });
  }

  return rows;
}

/** Resolve a user-supplied reference to a concrete target. Accepts an id, a name, or a prefix. */
export async function resolve(ref) {
  if (!ref) throw new Error('a session id or name is required');
  const rows = await listAll();
  const exact = rows.find((r) => r.id === ref || r.name === ref);
  if (exact) return exact;
  const prefixed = rows.filter((r) => String(r.id).startsWith(ref) || String(r.name || '').startsWith(ref));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new Error(`"${ref}" is ambiguous — matches ${prefixed.map((r) => r.id).join(', ')}`);
  }
  throw new Error(`no session matching "${ref}"`);
}

export async function isTmuxBusy(name) {
  // A TUI is "working" when it says so. Claude Code prints `esc to interrupt` while generating;
  // agy does not use a stable marker, so fall back to movement detection (see waitIdle).
  const raw = await tmux.capture(name, { lines: 0 });
  return /esc to interrupt|ctrl\+c to (interrupt|stop)/i.test(raw);
}

/**
 * Wait until a tmux-hosted agent stops producing output.
 *
 * Deliberately movement-based rather than marker-based. A marker is one vendor rename away from
 * lying — a lesson this codebase has already paid for once — whereas "the screen stopped
 * changing for N seconds" is true for any TUI. The busy marker is still consulted when present
 * so we do not declare idle during a long silent think.
 */
export async function waitIdle(name, { stableMs = 3000, timeoutMs = 600000, pollMs = 1000 } = {}) {
  const start = Date.now();
  let last = null;
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    const now = await tmux.capture(name, { lines: 0 });
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    }
    const busy = /esc to interrupt|ctrl\+c to (interrupt|stop)/i.test(now);
    if (!busy && Date.now() - stableSince >= stableMs) {
      return { idle: true, waitedMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { idle: false, waitedMs: Date.now() - start, reason: 'timeout' };
}

/** Cheap, harness-agnostic limits probe: read the pane tail for a usage notice. */
export async function limitState(name) {
  const raw = await tmux.capture(name, { lines: 0 }).catch(() => '');
  const tail = raw.split('\n').filter((l) => l.trim()).slice(-8).join(' ');
  const m = tail.match(/(?:hit your|reached|limit)[^.]{0,120}?(resets?[^.]{0,60})/i);
  return { limited: !!m, notice: m ? m[0].trim() : null, tail: tail.slice(0, 400) };
}

export async function send(claudeSend, agySend) { return { claudeSend, agySend }; }
