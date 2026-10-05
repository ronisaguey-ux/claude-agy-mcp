// The antigravity bridge — a file-backed message channel between agents.
//
// Claude Code and agy cannot call each other directly, but both can read and write a JSONL file.
// This is that file. The schema is fixed by the existing bridge on this machine, so it is
// reproduced exactly rather than invented:
//
//   {id, timestamp, from, to, subject, priority, content, status, reply_to}

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_BRIDGE = process.env.AGY_BRIDGE_FILE
  || `${process.env.HOME}/.claude/inbox/messages.jsonl`;

const AGENTS = ['claude_code', 'antigravity', 'opencode', 'user_telegram'];

function rid() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

async function readAll(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Append one message.
 *
 * Appended under a lock and with an fsync, because this file is written by more than one process
 * and a torn line makes the whole log unparseable — a failure mode that has already destroyed an
 * inbox on this machine once.
 */
export async function send({ from = 'opencode', to, subject = '', content, priority = 'normal', replyTo = null, file = DEFAULT_BRIDGE }) {
  if (!to) throw new Error('`to` is required');
  if (!content) throw new Error('`content` is required');
  await fs.mkdir(path.dirname(file), { recursive: true });

  const entry = {
    id: rid(),
    timestamp: new Date().toISOString(),
    from,
    to,
    subject,
    priority,
    content,
    status: 'unread',
    reply_to: replyTo,
  };

  const lock = `${file}.lock`;
  const handle = await fs.open(lock, 'w').catch(() => null);
  try {
    if (handle) { try { await handle.writeFile(String(process.pid)); } catch {} }
    await fs.appendFile(file, JSON.stringify(entry) + '\n');
    const fh = await fs.open(file, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(lock).catch(() => {});
  }
  return entry;
}

export async function inbox({ for: who = 'opencode', unreadOnly = true, limit = 20, file = DEFAULT_BRIDGE } = {}) {
  const all = await readAll(file);
  return all
    .filter((m) => m.to === who || m.to === '*' || m.to === 'all')
    .filter((m) => (unreadOnly ? m.status !== 'read' : true))
    .slice(-limit)
    .reverse();
}

export async function conversation({ with: who, limit = 50, file = DEFAULT_BRIDGE } = {}) {
  const all = await readAll(file);
  return all
    .filter((m) => !who || m.from === who || m.to === who)
    .slice(-limit);
}

export async function markRead(ids, { file = DEFAULT_BRIDGE } = {}) {
  const set = new Set([].concat(ids));
  const all = await readAll(file);
  let n = 0;
  for (const m of all) {
    if (set.has(m.id)) { m.status = 'read'; n++; }
  }
  if (n) {
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, all.map((m) => JSON.stringify(m)).join('\n') + '\n');
    await fs.rename(tmp, file);
  }
  return { marked: n };
}

export async function participants({ file = DEFAULT_BRIDGE } = {}) {
  const all = await readAll(file);
  const counts = {};
  for (const m of all) {
    counts[`${m.from} -> ${m.to}`] = (counts[`${m.from} -> ${m.to}`] || 0) + 1;
  }
  return { file, total: all.length, agents: AGENTS, pairs: counts, last: all[all.length - 1] || null };
}
