// Smoke test: speaks the real MCP protocol over a pipe to a real child process.
//
// The point is to exercise the wire, not the functions — the failure this catches is a server
// that starts, lists nothing, or corrupts stdout, which a unit test against the handlers would
// never see.

import { spawn } from 'node:child_process';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'bin', 'claude-agy-mcp.js');

const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
let id = 0;
let stderr = '';

child.stderr.on('data', (d) => { stderr += d.toString(); });
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { throw new Error(`non-JSON on stdout: ${line.slice(0, 200)}`); }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function call(method, params) {
  id += 1;
  const myId = id;
  return new Promise((resolve, reject) => {
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    setTimeout(() => pending.has(myId) && reject(new Error(`timeout: ${method}`)), 60000);
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]); }
}

const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
check('initialize handshake', () => {
  assert.ok(init.result, 'no result');
  assert.equal(init.result.serverInfo.name, 'claude-agy-mcp');
  assert.ok(init.result.capabilities.tools);
});
notify('notifications/initialized');

const ping = await call('ping', {});
check('ping', () => assert.deepEqual(ping.result, {}));

const listed = await call('tools/list', {});
const names = listed.result.tools.map((t) => t.name);
check('tools/list returns the catalogue', () => {
  assert.ok(names.length >= 15, `only ${names.length} tools`);
  for (const n of ['agent_list', 'agent_spawn', 'agent_send', 'agent_stop', 'agent_resume', 'agent_set_model', 'bridge_send', 'self_openbot']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
});
check('every tool has a description and a schema', () => {
  for (const t of listed.result.tools) {
    assert.ok(t.description && t.description.length > 30, `${t.name} description too thin`);
    assert.equal(t.inputSchema?.type, 'object', `${t.name} schema not an object`);
  }
});

const inventory = await call('tools/call', { name: 'agent_inventory', arguments: {} });
const invText = inventory.result.content[0].text;
check('agent_inventory answers', () => {
  assert.ok(invText.includes('CLAUDE'), 'no CLAUDE section');
  assert.ok(invText.includes('TMUX'), 'no TMUX line');
});

const list = await call('tools/call', { name: 'agent_list', arguments: {} });
check('agent_list answers without crashing', () => {
  assert.ok(list.result.content[0].text.length > 0);
});

const bridgeStatus = await call('tools/call', { name: 'bridge_status', arguments: {} });
check('bridge_status names the file and pairs', () => {
  const t = bridgeStatus.result.content[0].text;
  assert.ok(t.includes('messages.jsonl'), 'no bridge file');
  assert.ok(t.includes('pairs:'), 'no pairs');
});

const selfDry = await call('tools/call', { name: 'self_openbot', arguments: { dry_run: true } });
check('self_openbot dry-run does not launch or kill', () => {
  const t = selfDry.result.content[0].text;
  assert.ok(t.includes('dryRun'), 'no dryRun flag in output');
});

const unknown = await call('tools/call', { name: 'does_not_exist', arguments: {} });
check('unknown tool is a protocol error', () => assert.ok(unknown.error, 'expected an error'));

const badCall = await call('tools/call', { name: 'agent_read', arguments: { session: 'no_such_session_xyz' } });
check('a failing tool returns isError, not a crash', () => {
  assert.ok(badCall.result?.isError, 'expected isError');
});

console.log('\nclaude-agy-mcp smoke test\n' + '='.repeat(48));
let failed = 0;
for (const [status, name] of results) {
  if (status === 'FAIL') failed++;
  console.log(`${status === 'PASS' ? ' ok ' : 'FAIL'}  ${name}`);
}
console.log('='.repeat(48));
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) { console.log('\nserver stderr:\n' + stderr.slice(-2000)); }

child.kill();
process.exit(failed ? 1 : 0);
