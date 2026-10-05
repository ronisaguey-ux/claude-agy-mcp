// Zero-dependency MCP server over stdio.
//
// Written against the MCP spec by hand rather than pulling @modelcontextprotocol/sdk: this
// server has to survive on machines where `npm install` is unavailable, slow or offline, and
// the wire protocol is small enough that a dependency here is a liability, not a saving.
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs go to stderr only — a stray
// byte on stdout corrupts the stream and the client drops the connection.

import readline from 'node:readline';

export const PROTOCOL_VERSION = '2024-11-05';

export class McpServer {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} opts.version
   * @param {Array}  opts.tools   Tool definitions: {name, description, inputSchema, handler}
   */
  constructor({ name, version, tools }) {
    this.name = name;
    this.version = version;
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.inflight = 0;
    this.closing = false;
  }

  log(...a) {
    process.stderr.write(`[${this.name}] ${a.join(' ')}\n`);
  }

  send(msg) {
    if (this.closing && !msg.id) return;
    try {
      process.stdout.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      this.log('stdout write failed:', e.message);
    }
  }

  ok(id, result) { this.send({ jsonrpc: '2.0', id, result }); }

  err(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    this.send({ jsonrpc: '2.0', id, error });
  }

  /** Tools can return a string, or {text, isError}. Both become MCP text content. */
  contentResult(v) {
    if (v && typeof v === 'object' && typeof v.text === 'string') {
      const out = { content: [{ type: 'text', text: v.text }] };
      if (v.isError) out.isError = true;
      return out;
    }
    if (typeof v === 'string') return { content: [{ type: 'text', text: v }] };
    return { content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] };
  }

  async handle(msg) {
    const { id, method, params } = msg;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case 'initialize': {
        const clientProto = params?.protocolVersion;
        this.ok(id, {
          // Echo the client's version when we recognise the family; otherwise state ours.
          protocolVersion: clientProto || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.name, version: this.version },
        });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        if (!isNotification) this.ok(id, {});
        return;
      case 'tools/list': {
        this.ok(id, {
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema || { type: 'object', properties: {} },
          })),
        });
        return;
      }
      case 'tools/call': {
        const tool = this.tools.get(params?.name);
        if (!tool) {
          this.err(id, -32602, `Unknown tool: ${params?.name}`);
          return;
        }
        this.inflight++;
        try {
          const args = params?.arguments || {};
          const result = await tool.handler(args, this);
          this.ok(id, this.contentResult(result));
        } catch (e) {
          // A tool failure is a result for the model to read, not a protocol error.
          this.ok(id, {
            content: [{ type: 'text', text: `ERROR: ${e?.message || String(e)}` }],
            isError: true,
          });
        } finally {
          this.inflight--;
        }
        return;
      }
      case 'resources/list':
        if (!isNotification) this.ok(id, { resources: [] });
        return;
      case 'prompts/list':
        if (!isNotification) this.ok(id, { prompts: [] });
        return;
      default:
        if (!isNotification) this.err(id, -32601, `Method not found: ${method}`);
    }
  }

  listen() {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    let chain = Promise.resolve();
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      let msg;
      try {
        msg = JSON.parse(s);
      } catch {
        this.log('dropped an unparseable line from stdin');
        return;
      }
      // Serialise handling: some tools shell out and we do not want interleaved output.
      chain = chain.then(() => this.handle(msg)).catch((e) => this.log('handler crashed:', e.message));
    });
    rl.on('close', () => {
      this.closing = true;
      process.exit(0);
    });
    process.on('SIGTERM', () => process.exit(0));
    process.on('SIGINT', () => process.exit(0));
    this.log(`ready — ${this.tools.size} tools`);
  }
}

export function text(s) { return { text: String(s) }; }
export function fail(s) { return { text: String(s), isError: true }; }
