// tmux is the substrate that both harnesses actually understand as "a live interactive agent".
// Claude Code and agy both run as full-screen TUIs, and a TUI's only programmatic surface is
// its terminal: send it keystrokes, read its screen. A background/print mode exists for Claude
// (see claude.js) but agy has no equivalent for a long interactive session, so tmux is the
// common denominator and this module is the honest way to drive one.

import { run, sleep } from './exec.js';

export const DEFAULT_SOCKET = process.env.TMUX_TMPDIR ? undefined : undefined;

function tmuxArgs(args) {
  const a = [];
  return a.concat(args);
}

export async function available() {
  const r = await run('tmux', ['-V'], { timeout: 5000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function listSessions() {
  const fmt = '#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}\t#{session_activity}';
  const r = await run('tmux', ['list-sessions', '-F', fmt], { timeout: 10000 });
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, windows, created, attached, activity] = line.split('\t');
      return {
        name,
        windows: Number(windows),
        created: Number(created) * 1000,
        attached: Number(attached) > 0,
        activity: Number(activity) * 1000,
      };
    });
}

export async function hasSession(name) {
  const r = await run('tmux', ['has-session', '-t', name], { timeout: 5000 });
  return r.code === 0;
}

export async function newSession(name, { cwd, command, width = 220, height = 50 } = {}) {
  if (await hasSession(name)) return { created: false, name };
  const args = ['new-session', '-d', '-s', name, '-x', String(width), '-y', String(height)];
  if (cwd) args.push('-c', cwd);
  const r = await run('tmux', args, { timeout: 15000 });
  if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim() || r.stdout.trim()}`);
  if (command) await sendCommand(name, command);
  return { created: true, name };
}

/** Type a command line and press Enter. Used to launcher a TUI inside a fresh pane. */
export async function sendCommand(name, command) {
  await run('tmux', ['send-keys', '-t', name, '-l', command], { timeout: 10000 });
  await run('tmux', ['send-keys', '-t', name, 'Enter'], { timeout: 10000 });
}

/** Literal text into the pane. Text and Enter are separate calls on purpose: a newline inside
 *  the literal payload would submit a half-typed message. */
export async function sendText(name, text, { submit = true, enterDelayMs = 250 } = {}) {
  const clean = String(text).replace(/\r/g, '');
  for (const line of clean.split('\n')) {
    await run('tmux', ['send-keys', '-t', name, '-l', line], { timeout: 10000 });
    await run('tmux', ['send-keys', '-t', name, 'Enter'], { timeout: 10000 });
    await sleep(120);
  }
  return { sent: true, submitted: submit };
}

export async function capture(name, { lines = 200, start = null } = {}) {
  const args = ['capture-pane', '-p', '-t', name, '-J'];
  if (start !== null) args.push('-S', String(start));
  args.push('-E', '-');
  const r = await run('tmux', args, { timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
  if (r.code !== 0) throw new Error(`tmux capture-pane failed: ${r.stderr.trim()}`);
  const all = r.stdout.replace(/\s+$/g, '').split('\n');
  return lines > 0 ? all.slice(-lines).join('\n') : all.join('\n');
}

/** Capture the last N *content* lines with the TUI chrome stripped out.
 *
 *  This exists because every "is the agent idle?" heuristic written against raw pane text has
 *  eventually been defeated by the pane's own furniture — box rules, an empty `❯` prompt, a
 *  status line — or by the scrollback quoting the very string being matched. Strip first, then
 *  judge. */
export async function captureContent(name, { lines = 30 } = {}) {
  const raw = await capture(name, { lines: 0 });
  const chrome = /^\s*$|^\s*[─━═-]{3,}\s*$|^\s*[❯>]\s*$|bypass permissions|for agents|for shortcuts|Update installed|esc to interrupt\s*$/i;
  const lines2 = raw
    .split('\n')
    .filter((l) => !chrome.test(l))
    .filter((l) => !/^\s*⎿/.test(l)); // tool-result continuation lines
  return lines2.slice(-lines).join('\n');
}

export async function killSession(name) {
  const r = await run('tmux', ['kill-session', '-t', name], { timeout: 10000 });
  return { killed: r.code === 0, stderr: r.stderr.trim() };
}
