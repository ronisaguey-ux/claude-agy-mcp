// Process helpers. Everything shells out with an argument array (never a shell string) so a
// path or a prompt containing spaces or quotes cannot turn into a second command.

import { execFile } from 'node:child_process';

export function run(cmd, args = [], { timeout = 60000, cwd, env, input, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout, cwd, env: env ? { ...process.env, ...env } : process.env, maxBuffer, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          timedOut: !!error?.killed,
          error: error ? error.message : null,
        });
      },
    );
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

export async function which(cmd) {
  const p = process.env.PATH || '/usr/bin:/bin:/usr/local/bin';
  for (const dir of p.split(':')) {
    if (!dir) continue;
    const full = `${dir}/${cmd}`;
    try {
      const fs = await import('node:fs/promises');
      await fs.access(full, (await import('node:fs')).constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

/** First existing executable from a candidate list. */
export async function firstExisting(candidates) {
  const fs = await import('node:fs/promises');
  for (const c of candidates) {
    try {
      await fs.access(c, (await import('node:fs')).constants.X_OK);
      return c;
    } catch {}
  }
  return null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
