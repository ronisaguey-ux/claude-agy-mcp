// Discovers which agent CLIs exist on this machine, where they are, and what they support.
//
// There is more than one `claude` on a normal box (a global npm install and a native build),
// and they are NOT the same version — a model can be missing from the older one, and a
// long-running process keeps the model list it booted with. So every answer here is read from
// the binary we would actually run, not from a hardcoded path.

import { run, firstExisting } from './exec.js';

export const CLAUDE_CANDIDATES = [
  process.env.CLAUDE_BIN,
  `${process.env.HOME}/.npm-global/bin/claude`,
  '/usr/local/bin/claude',
  '/usr/bin/claude',
].filter(Boolean);

export const AGY_CANDIDATES = [
  process.env.AGY_BIN,
  `${process.env.HOME}/.local/bin/agy`,
  '/usr/local/bin/agy',
  '/usr/bin/agy',
].filter(Boolean);

export async function findClaude() { return firstExisting(CLAUDE_CANDIDATES); }
export async function findAgy() { return firstExisting(AGY_CANDIDATES); }

async function versionOf(bin, args = ['--version']) {
  if (!bin) return null;
  const r = await run(bin, args, { timeout: 20000 });
  const s = (r.stdout + r.stderr).trim().split('\n')[0] || '';
  return r.code === 0 ? s : null;
}

export async function claudeInfo() {
  const bin = await findClaude();
  if (!bin) return { found: false, bin: null };
  const others = [];
  for (const c of CLAUDE_CANDIDATES) {
    if (c === bin) continue;
    const v = await versionOf(c).catch(() => null);
    if (v) others.push({ bin: c, version: v });
  }
  return {
    found: true,
    bin,
    version: await versionOf(bin),
    otherInstalls: others,
    // A different binary in PATH will shadow the one we drive — worth surfacing, because the
    // user's `claude` and ours can be different builds.
    onPath: (await run('bash', ['-lc', 'command -v claude'], { timeout: 10000 })).stdout.trim() || null,
  };
}

export async function agyInfo() {
  const bin = await findAgy();
  if (!bin) return { found: false, bin: null };
  const ver = await versionOf(bin, ['--version']);
  let mcp = [];
  const r = await run(bin, ['mcp', 'list'], { timeout: 25000 });
  if (r.code === 0) {
    mcp = r.stdout
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const parts = l.split(/\s{2,}/);
        return { name: parts[0], type: parts[1], status: parts[2], target: parts[3] };
      });
  }
  return { found: true, bin, version: ver, mcpServers: mcp };
}

// Known Claude model ids. The CLI accepts anything, so this is guidance for a caller that does
// not know the catalogue — not a whitelist.
export const CLAUDE_MODELS = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-haiku-5',
];

export const AGY_MODELS = ['default', 'pro', 'flash'];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];
