import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { isIP } from 'node:net';
import { loadConfig } from './src/config.mjs';
import { ensureRuntime, runtimePaths } from './src/runtime.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const paths = runtimePaths(root);
const command = process.argv[2] || 'help';
const flags = process.argv.slice(3);

function readState() {
  let text;
  try { text = readFileSync(paths.state, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Unable to read relay runtime settings.'); }
  try {
    const state = JSON.parse(text);
    const url = new URL(state.baseUrl);
    const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    if (url.protocol !== 'http:' || !isIP(host) || host === '0.0.0.0' || host === '::' ||
        url.username || url.password || url.pathname !== '/v1' || url.search || url.hash ||
        (state.apiKey !== undefined && (typeof state.apiKey !== 'string' || !state.apiKey || /\s/.test(state.apiKey))) ||
        !/^[a-f0-9]{32}$/.test(state.instanceId)) throw new Error();
    return state;
  } catch { throw new Error('Invalid relay runtime settings.'); }
}

function controlRequest(state, path, method = 'GET') {
  return new Promise((resolveRequest, reject) => {
    const url = new URL(path, state.baseUrl);
    // Control traffic must never inherit an outbound proxy.
    const request = http.request(url, { method, agent: false, headers: {
      'x-relay-instance-id': state.instanceId,
    } }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 16384) request.destroy(new Error('Invalid relay control response.'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || body.instanceId !== state.instanceId) throw new Error();
          resolveRequest(body);
        } catch { reject(new Error('Runtime settings do not match the running relay. Refusing control.')); }
      });
    });
    request.setTimeout(1800, () => request.destroy(new Error('Relay control request timed out.')));
    request.once('error', reject);
    request.end();
  });
}

async function running(state) {
  if (!state) return false;
  try {
    const result = await controlRequest(state, '/_relay/status');
    if (result.service !== 'Codex-free-api-quota') throw new Error('Unexpected relay service.');
    return true;
  } catch (error) {
    if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH'].includes(error.code)) return false;
    throw error;
  }
}

function showState(state) {
  if (state.listenAddress) {
    const host = state.listenAddress.includes(':') ? `[${state.listenAddress}]` : state.listenAddress;
    console.log(`Listening address: ${host}:${new URL(state.baseUrl).port || '80'}`);
  }
  console.log(`Base URL: ${state.baseUrl}`);
  console.log(`Model catalog URL: ${state.catalogUrl}`);
  if (state.listenAddress === '0.0.0.0' || state.listenAddress === '::') {
    console.log("For remote clients, replace the URL host with this machine's IP address or hostname.");
  }
  console.log(`Local authentication: ${state.apiKey ? 'enabled' : 'disabled'}`);
  if (state.apiKey) console.log(`Local client key: ${state.apiKey}`);
  console.log(`Provider configuration: ${resolve(paths.directory, 'codex-provider.toml')}`);
}

async function start(foreground) {
  const existing = readState();
  if (await running(existing)) {
    console.log('Relay is already running.');
    showState(existing);
    return;
  }
  loadConfig(root);
  if (foreground) {
    const child = spawn(process.execPath, ['--use-env-proxy', resolve(root, 'server.mjs')], {
      cwd: root, stdio: 'inherit', windowsHide: true,
    });
    const forward = signal => { try { child.kill(signal); } catch {} };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try {
      process.exitCode = await new Promise((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
      });
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
    return;
  }
  ensureRuntime(root);
  const output = openSync(resolve(paths.directory, 'stdout.log'), 'a', 0o600);
  const errors = openSync(resolve(paths.directory, 'stderr.log'), 'a', 0o600);
  let child;
  let failure;
  let exited = false;
  try {
    child = spawn(process.execPath, ['--use-env-proxy', resolve(root, 'server.mjs')], {
      cwd: root, detached: true, windowsHide: true, stdio: ['ignore', output, errors],
    });
    child.once('error', error => { failure = error; });
    child.once('exit', () => { exited = true; });
    child.unref();
  } finally { closeSync(output); closeSync(errors); }
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(100);
    const state = readState();
    if (state && await running(state)) { showState(state); return; }
    if (failure || exited) throw new Error('Relay failed to start. See .runtime/stderr.log.');
  }
  try { child.kill('SIGTERM'); } catch {}
  throw new Error('Relay startup timed out. See .runtime/stderr.log.');
}

async function stop() {
  const state = readState();
  if (!await running(state)) { console.log('Relay is not running.'); return; }
  await controlRequest(state, '/_relay/shutdown', 'POST');
  for (let attempt = 0; attempt < 60; attempt++) {
    await delay(100);
    if (!await running(state)) {
      console.log('Relay stopped.');
      return;
    }
  }
  throw new Error('Relay shutdown timed out.');
}

try {
  if (command === 'start') {
    if (flags.some(flag => flag !== '--foreground') || flags.length > 1) throw new Error('Usage: node relay.mjs start [--foreground]');
    await start(flags.includes('--foreground'));
  } else if (command === 'stop' || command === 'status') {
    if (flags.length) throw new Error(`Usage: node relay.mjs ${command}`);
    if (command === 'stop') await stop();
    else {
      const state = readState();
      if (await running(state)) showState(state);
      else { console.log('Relay is not running.'); process.exitCode = 1; }
    }
  } else if (command === 'help' || command === '--help') {
    console.log('Usage: node relay.mjs <start [--foreground] | stop | status>');
  } else throw new Error('Unknown command. Run node relay.mjs --help.');
} catch (error) {
  console.error(error.code ? `Relay command failed (${error.code}).` : error.message);
  process.exitCode = 1;
}
