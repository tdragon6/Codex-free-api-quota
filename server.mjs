import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { loadConfig } from './src/config.mjs';
import { createRelay } from './src/server.mjs';
import { acquireRuntime, atomicWrite, releaseRuntime } from './src/runtime.mjs';

const root = dirname(fileURLToPath(import.meta.url));
let config;
try { config = loadConfig(root); }
catch (error) { console.error(error.message); process.exit(1); }

// Node global agents read proxy settings at creation, before .env is loaded.
// Rebuild them explicitly when a proxy is configured in the local .env.
if (Object.keys(config.proxyEnv).length) {
  const http = await import('node:http');
  const https = await import('node:https');
  http.default.globalAgent = new http.Agent({ proxyEnv: config.proxyEnv, keepAlive: true });
  https.default.globalAgent = new https.Agent({ proxyEnv: config.proxyEnv, keepAlive: true });
}
const instanceId = randomBytes(16).toString('hex');
let paths;
try { paths = acquireRuntime(root, instanceId); }
catch (error) { console.error(error.message); process.exit(1); }
const cleanup = () => releaseRuntime(paths, instanceId);
// Register ownership-aware cleanup before publishing either runtime file.
process.on('exit', cleanup);
const relay = createRelay(config, { log: value => console.log(JSON.stringify(value)),
  control: { instanceId, shutdown } });
relay.server.listen(config.port, config.host);
try { await once(relay.server, 'listening'); }
catch (error) { console.error(`Relay failed to listen (${error.code || 'unknown'})`); process.exit(1); }
const address = relay.server.address();
const port = address.port;
const listenAddress = address.address;
// Wildcard addresses bind interfaces but are not client destinations.
const clientHost = listenAddress === '0.0.0.0' ? '127.0.0.1' : listenAddress === '::' ? '::1' : listenAddress;
const baseUrl = `http://${clientHost.includes(':') ? `[${clientHost}]` : clientHost}:${port}/v1`;
const catalogUrl = `${baseUrl.slice(0, -3)}/codex/models`;
const state = { pid: process.pid, instanceId, baseUrl, catalogUrl, listenAddress, authRequired: Boolean(config.localApiKey),
  ...(config.localApiKey ? { apiKey: config.localApiKey } : {}),
  startedAt: new Date().toISOString() };
// Codex needs a nonempty token to enable remote catalog discovery, even without local auth.
const clientToken = config.localApiKey || 'local-no-auth';
const provider = `model_provider = "Codex-free-api-quota"\n\n[model_providers.Codex-free-api-quota]\nname = "Codex-free-api-quota"\nbase_url = ${JSON.stringify(baseUrl)}\nmodel_catalog_url = ${JSON.stringify(catalogUrl)}\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = false\n# In no-auth mode this fixed token only enables Codex catalog discovery.\nexperimental_bearer_token = ${JSON.stringify(clientToken)}\n`;
try {
  atomicWrite(resolve(paths.directory, 'codex-provider.toml'), provider, instanceId);
  atomicWrite(paths.state, JSON.stringify(state, null, 2) + '\n', instanceId);
} catch (error) {
  relay.destroyActive();
  relay.server.closeAllConnections();
  relay.server.close();
  console.error(`Relay failed to write runtime settings (${error.code || 'unknown'})`);
  process.exit(1);
}
console.log(`Listening address: ${listenAddress.includes(':') ? `[${listenAddress}]` : listenAddress}:${port}`);
console.log(`Codex-free-api-quota ready: ${baseUrl}`);
if (listenAddress === '0.0.0.0' || listenAddress === '::') {
  console.log("For remote clients, replace the URL host with this machine's IP address or hostname.");
}
console.log(`Model catalog URL: ${catalogUrl}`);
console.log(`Local authentication: ${config.localApiKey ? 'enabled' : 'disabled'}`);
console.log(`Client settings: ${paths.state}`);

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  relay.destroyActive();
  relay.server.closeAllConnections();
  relay.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
