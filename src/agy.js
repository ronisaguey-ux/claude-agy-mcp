// Antigravity (agy) session control.
//
// agy has no background-session API — `--print` is one-shot and there is no `agents` subcommand
// listing live sessions. So a long-running agy is a tmux-hosted TUI, and the only honest way to
// drive it is to type at it and read its screen. That is what this module does, and it says so
// rather than pretending there is a richer interface.

import { run, sleep } from './exec.js';
import { findAgy } from './harness.js';
import * as tmux from './tmux.js';

export const SESSION_PREFIX = 'agy_';

/**
 * One-shot, non-interactive prompt. `--print` with the prompt ATTACHED is the form that works;
 * passing it as a positional argument hangs waiting on stdin.
 */
export async function print(prompt, { cwd, model, effort = 'max', addDir, timeout = 900000, outputFormat = 'text', continueLast = false, conversation } = {}) {
  const bin = await findAgy();
  if (!bin) throw new Error('agy binary not found');
  const args = [];
  if (cwd) args.push('--add-dir', cwd);
  for (const d of [].concat(addDir || [])) args.push('--add-dir', d);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (continueLast) args.push('--continue');
  if (conversation) args.push('--conversation', conversation);
  args.push('--dangerously-skip-permissions');
  if (outputFormat !== 'text') args.push('--output-format', outputFormat);
  args.push(`--print=${prompt}`);
  const r = await run(bin, args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, text: r.stdout.trim() };
}

/** Start a live agy session in tmux and hand it an initial instruction. */
export async function startSession(name, { cwd, model, effort = 'max', prompt, width = 220, height = 50 } = {}) {
  const bin = await findAgy();
  if (!bin) throw new Error('agy binary not found');
  const session = name.startsWith(SESSION_PREFIX) ? name : SESSION_PREFIX + name;

  const args = ['--dangerously-skip-permissions'];
  if (effort) args.push('--effort', effort);
  if (model) args.push('--model', model);

  await tmux.newSession(session, { cwd, width, height });
  await tmux.sendCommand(session, [bin, ...args].join(' '));
  // The TUI needs a moment to paint before keystrokes land anywhere useful.
  await sleep(8000);
  if (prompt) await tmux.sendText(session, prompt);
  return { name: session, started: true };
}

/** Print mode inside an existing tmux agy session is not possible; the TUI is the session. */
export async function readSession(name, { lines = 120 } = {}) {
  const session = normalise(name);
  if (!(await tmux.hasSession(session))) throw new Error(`no tmux session named ${session}`);
  return tmux.captureContent(session, { lines });
}

export async function sendToSession(name, message) {
  const session = normalise(name);
  if (!(await tmux.hasSession(session))) throw new Error(`no tmux session named ${session}`);
  await tmux.sendText(session, message);
  return { sent: true };
}

export async function stopSession(name) {
  const session = normalise(name);
  return tmux.killSession(session);
}

function normalise(name) {
  return String(name).startsWith(SESSION_PREFIX) ? String(name) : SESSION_PREFIX + String(name);
}

/** agy conversations live beside its config; newest first. */
export async function listConversations({ limit = 25 } = {}) {
  const fs = await import('node:fs/promises');
  const roots = [`${process.env.HOME}/.gemini/antigravity-cli`, `${process.env.HOME}/.config/antigravity`];
  const out = [];
  for (const root of roots) {
    let entries = [];
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = `${root}/${e.name}`;
      let files = [];
      try { files = await fs.readdir(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.json') && !f.endsWith('.jsonl')) continue;
        const p = `${dir}/${f}`;
        try {
          const st = await fs.stat(p);
          out.push({ path: p, name: e.name, file: f, mtime: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}
