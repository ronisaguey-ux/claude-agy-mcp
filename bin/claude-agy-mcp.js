#!/usr/bin/env node
// Entry point. Everything is on stderr except the protocol — stdout is the wire.
import { McpServer } from '../src/mcp.js';
import { tools } from '../src/tools.js';
import { findClaude, findAgy } from '../src/harness.js';

const VERSION = '1.0.0';

async function main() {
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`claude-agy-mcp ${VERSION}\n`);
    return;
  }

  if (process.argv.includes('--self-test')) {
    const [c, a] = await Promise.all([findClaude(), findAgy()]);
    process.stdout.write(
      JSON.stringify({ version: VERSION, tools: tools.length, claude: c, agy: a }, null, 2) + '\n',
    );
    return;
  }

  const server = new McpServer({
    name: 'claude-agy-mcp',
    version: VERSION,
    tools,
  });
  server.listen();
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.stack || e}\n`);
  process.exit(1);
});
