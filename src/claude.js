// Claude Code session control.
//
// Claude Code ships a real background-session API — `claude --bg`, `claude agents --json`,
// `logs`, `stop`, `respawn`, `rm` — and that is a better control surface than scraping a TUI.
// We prefer it wherever it exists and fall back to tmux for the interactive case, which is the
// one Claude cannot be driven through with flags (a live REPL the user is also watching).

import { run } from './exec.js';
import { findClaude } from './harness.js';

async function claude(args, opts = {}) {
  const bin = await findClaude();
  if (!bin) throw new Error('claude binary not found');
  return run(bin, args, { timeout: opts.timeout ?? 120000, cwd: opts.cwd, env: opts.env, input: opts.input });
}

/**
 * All background sessions, including completed ones when `all` is set.
 * `--json` is documented as not requiring a TTY, which is what makes this usable from a server.
 */
export async function listBackground({ all = false, cwd } = {}) {
  const args = ['agents', '--json'];
  if (all) args.push('--all');
  if (cwd) args.push('--cwd', cwd);
  const r = await claude(args, { timeout: 30000 });
  if (r.code !== 0) return [];
  try {
    const parsed = JSON.parse(r.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** `claude --bg` prints the short id the other subcommands take. */
export async function startBackground({ prompt, cwd, model, effort, permissionMode, addDir, mcpConfig, agent, extraArgs = [] }) {
  const args = ['--bg'];
  if (prompt) args.push(prompt);
  if (cwd) args.push('--add-dir', cwd);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (agent) args.push('--agent', agent);
  for (const d of [].concat(addDir || [])) args.push('--add-dir', d);
  for (const c of [].concat(mcpConfig || [])) args.push('--mcp-config', c);
  args.push(...extraArgs);
  const r = await claude(args, { cwd, timeout: 60000 });
  const id = extractId(r.stdout) || extractId(r.stderr);
  if (!id) {
    throw new Error(`could not read a session id from claude --bg.\nstdout: ${r.stdout.trim()}\nstderr: ${r.stderr.trim()}`);
  }
  return { id, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

function extractId(s) {
  if (!s) return null;
  const m = String(s).match(/\b([0-9a-f]{8})\b/i);
  return m ? m[1] : null;
}

export async function logs(id, { timeout = 30000 } = {}) {
  const r = await claude(['logs', id], { timeout });
  return { code: r.code, output: r.stdout || r.stderr };
}

export async function stop(id) {
  const r = await claude(['stop', id], { timeout: 30000 });
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
}

export async function remove(id) {
  const r = await claude(['rm', id], { timeout: 30000 });
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
}

/** Restart so the session picks up the CURRENT Claude binary. `--all` for every session. */
export async function respawn(id, { all = false } = {}) {
  const args = all ? ['respawn', '--all'] : ['respawn', id];
  const r = await claude(args, { timeout: 60000 });
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim() };
}

/**
 * Send a message to an existing background session.
 *
 * `--bg --resume <sessionId>` continues that conversation in the background under the same id.
 * That is the documented continuation path; there is no separate "send" verb.
 */
export async function sendToBackground(sessionId, message, { model, effort, cwd } = {}) {
  const args = ['--bg', '--resume', sessionId, message];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  const r = await claude(args, { cwd, timeout: 90000 });
  return { ok: r.code === 0, output: (r.stdout + r.stderr).trim(), id: extractId(r.stdout) };
}

/**
 * One-shot, non-interactive run. Costs a turn — use it for a probe, not for a loop.
 * Returns the model's reply text.
 */
export async function print(prompt, { cwd, model, effort, permissionMode = 'bypassPermissions', extraArgs = [], timeout = 600000 } = {}) {
  const args = ['-p', prompt, '--output-format', 'json'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  args.push(...extraArgs);
  const r = await claude(args, { cwd, timeout });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch {}
  return { code: r.code, raw: r.stdout, stderr: r.stderr, parsed, text: parsed?.result ?? r.stdout };
}
