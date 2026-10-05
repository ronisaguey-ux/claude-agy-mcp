// Tool catalogue. Every tool returns text so the calling model reads a result, not a struct.
//
// Two rules held throughout:
//   1. A destructive action says what it will destroy and refuses when it cannot verify the
//      target — never a blind kill.
//   2. A tool that cannot do the thing says so, rather than returning a plausible-looking empty
//      success. A silent no-op is the failure mode that makes an orchestration layer useless.

import * as claude from './claude.js';
import * as agy from './agy.js';
import * as sessions from './sessions.js';
import * as tmux from './tmux.js';
import * as bridge from './bridge.js';
import * as self from './self.js';
import * as harness from './harness.js';
import { run } from './exec.js';

const S = (o) => (typeof o === 'string' ? o : JSON.stringify(o, null, 2));

function table(rows, cols) {
  if (!rows.length) return '(none)';
  const width = {};
  for (const c of cols) width[c] = Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length));
  const head = cols.map((c) => c.padEnd(width[c])).join('  ');
  const sep = cols.map((c) => '-'.repeat(width[c])).join('  ');
  return [head, sep, ...rows.map((r) => cols.map((c) => String(r[c] ?? '').padEnd(width[c])).join('  '))].join('\n');
}

export const tools = [
  // ── inventory ────────────────────────────────────────────────────────────────
  {
    name: 'agent_list',
    description:
      'List every agent session on this machine in one view: Claude Code background sessions and live tmux sessions (Claude and agy), with harness, state, cwd and a short screen preview. Call this first — every other tool takes an id or name from here.',
    inputSchema: {
      type: 'object',
      properties: {
        harness: { type: 'string', enum: ['claude', 'agy', 'tmux'], description: 'Only show one harness' },
        kind: { type: 'string', enum: ['background', 'tmux'], description: 'Only show one substrate' },
        json: { type: 'boolean', description: 'Return the raw rows as JSON' },
      },
    },
    handler: async ({ harness: h, kind, json }) => {
      let rows = await sessions.listAll();
      if (h) rows = rows.filter((r) => r.harness === h);
      if (kind) rows = rows.filter((r) => r.kind === kind);
      if (json) return S(rows);
      if (!rows.length) return 'No agent sessions found.';
      return table(
        rows.map((r) => ({
          id: r.id,
          harness: r.harness,
          kind: r.kind,
          state: r.state,
          name: (r.name || '').slice(0, 28),
          cwd: (r.cwd || '').replace(process.env.HOME || '~', '~'),
        })),
        ['id', 'harness', 'kind', 'state', 'name', 'cwd'],
      );
    },
  },
  {
    name: 'agent_inventory',
    description:
      'What agent CLIs this machine actually has: the resolved binary path, its version, other installs that could shadow it, and (for agy) its configured MCP servers. Use before spawning so you know which build you are driving.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const [c, a, t] = await Promise.all([harness.claudeInfo(), harness.agyInfo(), tmux.available()]);
      const lines = [];
      lines.push('CLAUDE');
      if (!c.found) lines.push('  not found');
      else {
        lines.push(`  driving     ${c.bin}`);
        lines.push(`  version     ${c.version}`);
        if (c.onPath && c.onPath !== c.bin) lines.push(`  on PATH     ${c.onPath}   <- different binary; a bare \`claude\` is NOT the one this server drives`);
        for (const o of c.otherInstalls) lines.push(`  other       ${o.bin} (${o.version})`);
      }
      lines.push('');
      lines.push('ANTIGRAVITY (agy)');
      if (!a.found) lines.push('  not found');
      else {
        lines.push(`  driving     ${a.bin}`);
        lines.push(`  version     ${a.version || '(no --version output)'}`);
        if (a.mcpServers?.length) {
          lines.push('  mcp servers:');
          for (const m of a.mcpServers) lines.push(`    ${m.name}  ${m.type || ''}  ${m.status || ''}`);
        }
      }
      lines.push('');
      lines.push(`TMUX          ${t || 'not installed'}`);
      return lines.join('\n');
    },
  },
  {
    name: 'agent_models',
    description: 'Known model ids and effort levels for each harness, plus the paths to change them by hand. Guidance, not a whitelist — the CLIs accept any id.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () =>
      [
        'CLAUDE  (claude --model <id> --effort <level>)',
        ...harness.CLAUDE_MODELS.map((m) => `  ${m}`),
        '',
        'AGY  (agy --model <name> --effort <level>)',
        ...harness.AGY_MODELS.map((m) => `  ${m}`),
        '',
        `EFFORT LEVELS  ${harness.EFFORT_LEVELS.join(' | ')}`,
        '',
        'Note: /model inside a running session and the launcher flag are different switches. A',
        'launcher flag wins on the next start; the running process keeps the model list it booted',
        'with.',
      ].join('\n'),
  },

  // ── read ─────────────────────────────────────────────────────────────────────
  {
    name: 'agent_read',
    description:
      'Read the recent output of a session. For a tmux session this is the screen with TUI chrome stripped; for a Claude background session it is that session\'s log. Pass `wait_idle: true` to block until the agent stops producing output first.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id or name' },
        lines: { type: 'number', description: 'How many recent lines (default 120)' },
        wait_idle: { type: 'boolean', description: 'Wait for output to stop changing before reading' },
        idle_timeout_ms: { type: 'number', description: 'Max wait when wait_idle is set (default 600000)' },
      },
      required: ['session'],
    },
    handler: async ({ session, lines = 120, wait_idle, idle_timeout_ms = 600000 }) => {
      const target = await sessions.resolve(session);
      if (wait_idle) {
        const w = await sessions.waitIdle(target.id, { timeoutMs: idle_timeout_ms });
        if (!w.idle) return `Still producing output after ${Math.round(w.waitedMs / 1000)}s (${w.reason}). Read anyway:\n\n${await read(target, lines)}`;
      }
      return read(target, lines);
    },
  },

  // ── spawn ────────────────────────────────────────────────────────────────────
  {
    name: 'agent_spawn',
    description:
      'Start a new agent session. harness=claude uses Claude Code\'s native background session (preferred — it has a real id and a real log). harness=agy starts a tmux-hosted Antigravity session, because agy has no background mode. mode=tmux forces an interactive tmux session for either harness.',
    inputSchema: {
      type: 'object',
      properties: {
        harness: { type: 'string', enum: ['claude', 'agy'], description: 'Which agent to start' },
        prompt: { type: 'string', description: 'Initial instruction' },
        cwd: { type: 'string', description: 'Working directory' },
        name: { type: 'string', description: 'Session name (tmux mode, and used to label the session)' },
        mode: { type: 'string', enum: ['auto', 'background', 'tmux'], description: 'auto = background for claude, tmux for agy' },
        model: { type: 'string', description: 'Model id' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'max'] },
        permission_mode: { type: 'string', description: 'Claude only, e.g. bypassPermissions, acceptEdits, plan' },
        add_dir: { type: 'array', items: { type: 'string' }, description: 'Extra directories to allow' },
        mcp_config: { type: 'array', items: { type: 'string' }, description: 'Claude only: --mcp-config paths' },
        agent: { type: 'string', description: 'Claude only: named agent' },
      },
      required: ['harness'],
    },
    handler: async (a) => {
      const mode = a.mode === 'auto' || !a.mode ? (a.harness === 'agy' ? 'tmux' : 'background') : a.mode;

      if (a.harness === 'agy' && mode === 'background') {
        return 'agy has no background-session mode — use mode=tmux (this is a limitation of agy, not of this tool).';
      }

      if (mode === 'background') {
        const r = await claude.startBackground({
          prompt: a.prompt,
          cwd: a.cwd,
          model: a.model,
          effort: a.effort,
          permissionMode: a.permission_mode,
          addDir: a.add_dir,
          mcpConfig: a.mcp_config,
          agent: a.agent,
        });
        return `Started Claude background session ${r.id}${a.cwd ? ` in ${a.cwd}` : ''}.\nRead it with agent_read "${r.id}", message it with agent_send, stop it with agent_stop.`;
      }

      const name = a.name || `${a.harness}_${Date.now().toString(36)}`;
      if (a.harness === 'agy') {
        const r = await agy.startSession(name, { cwd: a.cwd, model: a.model, effort: a.effort || 'max', prompt: a.prompt });
        return `Started agy session "${r.name}" in tmux${a.cwd ? ` (${a.cwd})` : ''}.\nAttach with: tmux attach -t ${r.name}`;
      }

      const bin = await harness.findClaude();
      if (!bin) return 'claude binary not found.';
      const parts = [bin, '--permission-mode', a.permission_mode || 'bypassPermissions'];
      if (a.model) parts.push('--model', a.model);
      if (a.effort) parts.push('--effort', a.effort);
      await tmux.newSession(name, { cwd: a.cwd });
      await tmux.sendCommand(name, parts.map((p) => JSON.stringify(p)).join(' '));
      await new Promise((r) => setTimeout(r, 7000));
      if (a.prompt) await tmux.sendText(name, a.prompt);
      return `Started Claude tmux session "${name}".\nAttach with: tmux attach -t ${name}`;
    },
  },
  {
    name: 'agent_spawn_many',
    description:
      'Start several sessions at once — one per prompt, or N clones of one prompt. Returns the ids it created and any that failed, so a partial fan-out is visible instead of silent.',
    inputSchema: {
      type: 'object',
      properties: {
        harness: { type: 'string', enum: ['claude', 'agy'] },
        prompts: { type: 'array', items: { type: 'string' }, description: 'One session per prompt' },
        count: { type: 'number', description: 'If prompts is omitted, start this many clones of `prompt`' },
        prompt: { type: 'string', description: 'Prompt used with count' },
        cwd: { type: 'string' },
        name_prefix: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        stagger_ms: { type: 'number', description: 'Gap between starts (default 800)' },
      },
      required: ['harness'],
    },
    handler: async (a) => {
      let prompts = a.prompts;
      if (!prompts && a.count) prompts = Array.from({ length: a.count }, () => a.prompt || '');
      if (!prompts?.length) return 'Give either `prompts` or `count`.';

      const created = [];
      const failed = [];
      for (let i = 0; i < prompts.length; i++) {
        const name = `${a.name_prefix || a.harness}_${i + 1}`;
        try {
          const r = await tools.find((t) => t.name === 'agent_spawn').handler({
            harness: a.harness,
            prompt: prompts[i],
            cwd: a.cwd,
            name,
            model: a.model,
            effort: a.effort,
          });
          created.push(`${name}: ${String(r).split('\n')[0]}`);
        } catch (e) {
          failed.push(`${name}: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, a.stagger_ms ?? 800));
      }
      const out = [`Created ${created.length}/${prompts.length}.`];
      if (created.length) out.push('', ...created.map((c) => '  ' + c));
      if (failed.length) out.push('', 'FAILED:', ...failed.map((f) => '  ' + f));
      return out.join('\n');
    },
  },

  // ── talk ─────────────────────────────────────────────────────────────────────
  {
    name: 'agent_send',
    description:
      'Send a message to an existing session and, unless wait:false, wait for it to finish answering. Wraps the right mechanism per harness: a resumed background turn for Claude background sessions, keystrokes for a tmux session.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id or name' },
        message: { type: 'string' },
        wait: { type: 'boolean', description: 'Wait for the reply (default true for tmux sessions)' },
        timeout_ms: { type: 'number', description: 'Max wait (default 600000)' },
      },
      required: ['session', 'message'],
    },
    handler: async ({ session, message, wait, timeout_ms = 600000 }) => {
      const target = await sessions.resolve(session);

      if (target.kind === 'background') {
        const busy = await sessions.isTmuxBusy(target.id).catch(() => false);
        if (busy) return `Refusing to send: "${target.id}" is currently generating. Stop it first or wait for it to finish.`;
        const r = await claude.sendToBackground(target.sessionId || target.id, message);
        return r.ok
          ? `Sent to ${target.id}.${r.id ? ` Session id ${r.id}.` : ''}\n${r.output.slice(0, 800)}`
          : `Send failed: ${r.output.slice(0, 800)}`;
      }

      await tmux.sendText(target.id, message);
      if (wait === false) return `Sent to ${target.id} (not waiting).`;
      const w = await sessions.waitIdle(target.id, { timeoutMs: timeout_ms });
      const out = await tmux.captureContent(target.id, { lines: 60 });
      return `${w.idle ? 'Answered' : `Still working after ${Math.round(w.waitedMs / 1000)}s`} — ${target.id}:\n\n${out}`;
    },
  },
  {
    name: 'agent_interrupt',
    description:
      'Stop a tmux-hosted agent mid-generation without killing its session, by sending Escape (then Ctrl-C if asked). The conversation is preserved. Use agent_stop to end the session instead.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        hard: { type: 'boolean', description: 'Also send Ctrl-C after Escape' },
      },
      required: ['session'],
    },
    handler: async ({ session, hard }) => {
      const target = await sessions.resolve(session);
      if (target.kind !== 'tmux') return `agent_interrupt works on tmux sessions; "${target.id}" is a ${target.kind} session. Use agent_stop.`;
      await run('tmux', ['send-keys', '-t', target.id, 'Escape']);
      if (hard) {
        await new Promise((r) => setTimeout(r, 400));
        await run('tmux', ['send-keys', '-t', target.id, 'C-c']);
      }
      await new Promise((r) => setTimeout(r, 800));
      const out = await tmux.captureContent(target.id, { lines: 20 });
      return `Interrupted ${target.id}.\n\n${out}`;
    },
  },

  // ── lifecycle ────────────────────────────────────────────────────────────────
  {
    name: 'agent_stop',
    description:
      'Stop a session. Claude background sessions keep their conversation and can be resumed; a tmux session is destroyed (its transcript on disk survives). Says which one it did.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        remove: { type: 'boolean', description: 'Claude only: delete the session entirely instead of stopping it' },
        all: { type: 'boolean', description: 'Claude only with session=background: stop every background session' },
      },
      required: ['session'],
    },
    handler: async ({ session, remove, all }) => {
      const target = await sessions.resolve(session);
      if (target.kind === 'background') {
        if (all) return S(await claude.stop(target.id));
        const r = remove ? await claude.remove(target.id) : await claude.stop(target.id);
        return remove
          ? `Deleted ${target.id}: ${r.output || 'ok'}`
          : `Stopped ${target.id} (conversation kept — resume with agent_resume): ${r.output || 'ok'}`;
      }
      const r = await tmux.killSession(target.id);
      return r.killed ? `Killed tmux session ${target.id}.` : `Could not kill ${target.id}: ${r.stderr}`;
    },
  },
  {
    name: 'agent_resume',
    description:
      'Bring a stopped Claude background session back, optionally with a new message. Restarts it in the background under the same id.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session id or name' },
        message: { type: 'string', description: 'Optional message to deliver on resume' },
      },
      required: ['session'],
    },
    handler: async ({ session, message }) => {
      const target = await sessions.resolve(session);
      if (target.kind !== 'background') return `agent_resume works on Claude background sessions; "${target.id}" is a ${target.kind} session.`;
      const r = await claude.sendToBackground(target.sessionId || target.id, message || 'Continue where you left off.');
      return r.ok ? `Resumed ${target.id}. ${r.output.slice(0, 600)}` : `Resume failed: ${r.output.slice(0, 600)}`;
    },
  },
  {
    name: 'agent_respawn',
    description:
      'Restart a Claude background session (or all of them) so it picks up the CURRENT Claude binary. Use after `claude update`, or when a session was started by an older build — a running process keeps the model list it booted with.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Omit together with all=true to respawn everything' },
        all: { type: 'boolean' },
      },
    },
    handler: async ({ session, all }) => {
      if (all) { const r = await claude.respawn(null, { all: true }); return `Respawned all: ${r.output || 'ok'}`; }
      const target = await sessions.resolve(session);
      const r = await claude.respawn(target.id);
      return r.ok ? `Respawned ${target.id}: ${r.output}` : `Respawn failed: ${r.output}`;
    },
  },
  {
    name: 'agent_set_model',
    description:
      'Change the model a session runs on. For a running tmux session this types the /model command and confirms the switch, because a live process cannot be re-pointed any other way. For a background session it applies on the next turn.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        model: { type: 'string', description: 'Model id' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'max'] },
      },
      required: ['session', 'model'],
    },
    handler: async ({ session, model, effort }) => {
      const target = await sessions.resolve(session);
      if (target.kind === 'background') {
        const r = await claude.sendToBackground(target.sessionId || target.id, `/model ${model}`);
        return `Asked ${target.id} to switch to ${model}.\n${r.output.slice(0, 400)}`;
      }
      await tmux.sendText(target.id, `/model ${model}`);
      const w = await sessions.waitIdle(target.id, { timeoutMs: 30000 });
      let out = await tmux.captureContent(target.id, { lines: 25 });
      if (effort) {
        await tmux.sendText(target.id, `/effort ${effort}`);
        await sessions.waitIdle(target.id, { timeoutMs: 30000 });
        out += '\n' + (await tmux.captureContent(target.id, { lines: 15 }));
      }
      return `Requested ${model} on ${target.id}${effort ? ` at effort ${effort}` : ''}.\n\n${out}`;
    },
  },
  {
    name: 'agent_wait_idle',
    description:
      'Block until a tmux-hosted agent stops producing output. Movement-based, not marker-based, so it works for any harness. Returns as soon as the screen has been stable for a few seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        stable_ms: { type: 'number', description: 'How long the screen must be unchanged (default 3000)' },
        timeout_ms: { type: 'number', description: 'Max wait (default 600000)' },
      },
      required: ['session'],
    },
    handler: async ({ session, stable_ms = 3000, timeout_ms = 600000 }) => {
      const target = await sessions.resolve(session);
      const w = await sessions.waitIdle(target.id, { stableMs: stable_ms, timeoutMs: timeout_ms });
      return w.idle
        ? `${target.id} is idle (stable after ${Math.round(w.waitedMs / 1000)}s).`
        : `${target.id} was still producing output after ${Math.round(w.waitedMs / 1000)}s.`;
    },
  },
  {
    name: 'agent_limits',
    description:
      'Report whether a session is currently rate- or usage-limited, and the reset time the banner names if so. Reads the live pane rather than a counter, because these notices are rendered into the UI and never returned through any API.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'Omit to check every tmux session' } },
    },
    handler: async ({ session }) => {
      const targets = session
        ? [await sessions.resolve(session)]
        : (await sessions.listAll()).filter((r) => r.kind === 'tmux');
      if (!targets.length) return 'No tmux sessions to check.';
      const lines = [];
      for (const t of targets) {
        const s = await sessions.limitState(t.id);
        lines.push(`${t.id}: ${s.limited ? `LIMITED — ${s.notice}` : 'no limit banner'}`);
      }
      return lines.join('\n');
    },
  },
  {
    name: 'agent_transcript',
    description:
      'Where a session\'s conversation is stored on disk, so a caller can read the raw history itself. Resolves the config-dir indirection rather than guessing a path.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' }, limit: { type: 'number', description: 'Max files to list' } },
    },
    handler: async ({ session, limit = 10 }) => {
      const fs = await import('node:fs/promises');
      if (!session) {
        const roots = [
          `${process.env.HOME}/.claude_worker_config/projects`,
          `${process.env.HOME}/.claude/projects`,
        ];
        const out = [];
        for (const root of roots) {
          let dirs = [];
          try { dirs = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
          for (const d of dirs) {
            if (!d.isDirectory()) continue;
            const full = `${root}/${d.name}`;
            let files = [];
            try { files = (await fs.readdir(full)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
            for (const f of files) {
              const st = await fs.stat(`${full}/${f}`).catch(() => null);
              if (st) out.push({ path: `${full}/${f}`, mtime: st.mtimeMs, size: st.size });
            }
          }
        }
        out.sort((a, b) => b.mtime - a.mtime);
        return table(out.slice(0, limit).map((o) => ({ path: o.path.replace(process.env.HOME, '~'), mb: (o.size / 1048576).toFixed(1), when: new Date(o.mtime).toISOString().slice(0, 16) })), ['path', 'mb', 'when']);
      }
      const target = await sessions.resolve(session);
      return S(target);
    },
  },

  // ── bridge ───────────────────────────────────────────────────────────────────
  {
    name: 'bridge_send',
    description:
      'Send a message to another agent through the file-backed bridge (Claude Code and agy cannot call each other directly, and this is the channel that reaches them). A watcher wakes the other side, so this is how you hand off or ask for help.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'claude_code | antigravity | opencode | user_telegram' },
        content: { type: 'string' },
        from: { type: 'string', description: 'Defaults to opencode' },
        subject: { type: 'string' },
        priority: { type: 'string', enum: ['normal', 'high', 'urgent'] },
        reply_to: { type: 'string', description: 'Id of the message being replied to' },
      },
      required: ['to', 'content'],
    },
    handler: async (a) => {
      const e = await bridge.send(a);
      return `Sent ${e.id} to ${e.to} (${e.priority}).`;
    },
  },
  {
    name: 'bridge_inbox',
    description: 'Read messages waiting for an agent on the bridge. Defaults to the calling agent\'s own inbox (opencode).',
    inputSchema: {
      type: 'object',
      properties: {
        for: { type: 'string', description: 'Which agent\'s inbox' },
        unread_only: { type: 'boolean', description: 'Default true' },
        limit: { type: 'number' },
        mark_read: { type: 'boolean', description: 'Mark what is returned as read' },
      },
    },
    handler: async ({ for: who = 'opencode', unread_only = true, limit = 20, mark_read }) => {
      const msgs = await bridge.inbox({ for: who, unreadOnly: unread_only, limit });
      if (!msgs.length) return `No ${unread_only ? 'unread ' : ''}messages for ${who}.`;
      const out = msgs.map((m) => `[${m.timestamp?.slice(0, 16)}] ${m.from} → ${m.to} (${m.priority})\n  id: ${m.id}\n  ${String(m.content).split('\n').join('\n  ')}`);
      if (mark_read) await bridge.markRead(msgs.map((m) => m.id));
      return out.join('\n\n');
    },
  },
  {
    name: 'bridge_status',
    description: 'The bridge file\'s location, size, and which agent pairs are actually talking. Use it to check a channel exists before relying on it.',
    inputSchema: { type: 'object', properties: { history_with: { type: 'string', description: 'Also dump recent history with this agent' }, limit: { type: 'number' } } },
    handler: async ({ history_with, limit = 20 }) => {
      const s = await bridge.participants();
      const lines = [`file: ${s.file}`, `total messages: ${s.total}`, '', 'pairs:'];
      for (const [k, v] of Object.entries(s.pairs).sort((a, b) => b[1] - a[1])) lines.push(`  ${String(v).padStart(5)}  ${k}`);
      if (history_with) {
        const h = await bridge.conversation({ with: history_with, limit });
        lines.push('', `recent with ${history_with}:`);
        for (const m of h) lines.push(`  [${m.timestamp?.slice(0, 16)}] ${m.from} → ${m.to}: ${String(m.content).slice(0, 160).replace(/\n/g, ' ')}`);
      }
      return lines.join('\n');
    },
  },

  // ── self ─────────────────────────────────────────────────────────────────────
  {
    name: 'self_openbot',
    description:
      'Restart the agent host that is running this tool: opens a NEW terminal running the agent first, then retires the current process a few seconds later. Use after changing config, plugins or MCP servers that only take effect on restart — no human needed. Refuses if the replacement command is not on PATH, because killing the session with nothing to replace it is not recoverable through this channel.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run in the new terminal (default: openbot)' },
        delay: { type: 'number', description: 'Seconds before the old process is retired (default 5)' },
        cwd: { type: 'string', description: 'Directory for the new terminal' },
        dry_run: { type: 'boolean', description: 'Report what it would do without launching or killing' },
      },
    },
    handler: async (a) => S(await self.selfOpenbot({ command: a.command || 'openbot', delay: a.delay ?? 5, cwd: a.cwd, dryRun: !!a.dry_run })),
  },
];

async function read(target, lines) {
  if (target.kind === 'background') {
    const r = await claude.logs(target.id);
    const all = (r.output || '').split('\n');
    return all.slice(-lines).join('\n') || '(no output)';
  }
  return tmux.captureContent(target.id, { lines });
}
