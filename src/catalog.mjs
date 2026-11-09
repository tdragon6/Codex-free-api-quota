import http from 'node:http';
import https from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { TextDecoder } from 'node:util';

const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_CACHE_ENTRIES = 16;

class CatalogError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function endpoint(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new CatalogError(502, 'Invalid upstream model catalog configuration'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.hash) {
    throw new CatalogError(502, 'Invalid upstream model catalog configuration');
  }
  return url;
}

function requestJSON(url, headers, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new CatalogError(499, 'Model catalog request was cancelled')); return; }
    let settled = false;
    let request;
    let deadline;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => {
      finish(new CatalogError(499, 'Model catalog request was cancelled'));
      request?.destroy();
    };
    const fail = message => {
      finish(new CatalogError(502, message));
      request?.destroy();
    };
    try {
      const transport = url.protocol === 'https:' ? https : http;
      request = transport.request(url, { method: 'GET', headers }, response => {
        response.once('error', () => fail('Unable to read upstream model catalog'));
        response.once('aborted', () => fail('Unable to read upstream model catalog'));
        if (response.statusCode < 200 || response.statusCode >= 300) {
          fail(`Unable to load upstream model catalog (HTTP ${response.statusCode})`);
          response.destroy();
          return;
        }
        if (Number(response.headers['content-length']) > MAX_UPSTREAM_BYTES) {
          fail('Upstream model catalog exceeds the size limit');
          response.destroy();
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_UPSTREAM_BYTES) {
            fail('Upstream model catalog exceeds the size limit');
            response.destroy();
          } else chunks.push(chunk);
        });
        response.once('end', () => {
          if (settled) return;
          try {
            let raw = Buffer.concat(chunks);
            const encoding = response.headers['content-encoding'];
            if (encoding && encoding !== 'identity') {
              const decoders = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync, zstd: zstdDecompressSync };
              if (!decoders[encoding]) throw new Error('Unsupported encoding');
              raw = decoders[encoding](raw, { maxOutputLength: MAX_UPSTREAM_BYTES });
            }
            const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
            finish(null, { body, headers: response.headers, receivedAt: Date.now() });
          } catch { fail('Upstream model catalog returned invalid or oversized JSON'); }
        });
      });
      request.once('error', () => fail('Unable to reach upstream model catalog'));
      signal?.addEventListener('abort', abort, { once: true });
      deadline = setTimeout(() => fail('Upstream model catalog request timed out'), timeoutMs);
      deadline.unref();
      // An AbortSignal may have changed between the initial check and listener registration.
      if (signal?.aborted) { abort(); return; }
      request.end();
    } catch { fail('Unable to reach upstream model catalog'); }
  });
}

function cacheLifetime(headers) {
  const control = String(headers['cache-control'] || '');
  const directives = control.split(',').map(value => value.trim());
  if (directives.some(value => /^(?:no-store|private|no-cache)(?:\s*=|$)/i.test(value))) return 0;
  const match = directives.map(value => /^max-age\s*=\s*(?:"(\d+)"|(\d+))$/i.exec(value)).find(Boolean);
  if (!match) return 0;
  const age = /^\d+$/.test(String(headers.age || '0')) ? Number(headers.age || '0') : Infinity;
  return Math.max(0, Math.min(60, Number(match[1] || match[2]) - age)) * 1000;
}

function filterCatalog(catalog, apiModels) {
  if (!catalog || Array.isArray(catalog) || !Array.isArray(catalog.models) ||
      !apiModels || !Array.isArray(apiModels.data)) {
    throw new CatalogError(502, 'Upstream model catalog has an incompatible response format');
  }
  const visible = new Set();
  for (const model of apiModels.data) {
    if (!model || typeof model.id !== 'string' || !model.id.trim()) {
      throw new CatalogError(502, 'Upstream model list has an incompatible response format');
    }
    visible.add(model.id);
  }
  const seen = new Set();
  const models = [];
  for (const model of catalog.models) {
    if (!model || typeof model.slug !== 'string' || !model.slug.trim() || seen.has(model.slug)) {
      throw new CatalogError(502, 'Upstream model catalog contains invalid model identifiers');
    }
    seen.add(model.slug);
    if (!visible.has(model.slug)) continue;
    models.push(model);
  }
  // Keep version-specific compatibility fields and every unmodified capability field.
  return { ...catalog, models };
}

export function createCatalog(config) {
  const cache = new Map();
  const catalogEndpoint = endpoint(config.catalogUrl || 'https://chatgpt.com/backend-api/codex/models');
  const modelsEndpoint = endpoint(config.upstreamBase.replace(/\/$/, '') + '/models');
  const timeoutMs = Math.min(config.timeoutMs || 20000, 20000);
  const commonHeaders = {
    authorization: `Bearer ${config.apiKey}`,
    'user-agent': 'local-agent-harness/1.0',
    accept: 'application/json',
    'accept-encoding': 'identity',
  };
  const apiHeaders = { ...commonHeaders };
  if (config.organization) apiHeaders['openai-organization'] = config.organization;
  if (config.project) apiHeaders['openai-project'] = config.project;

  return {
    async get(clientVersion, { signal } = {}) {
      if (typeof clientVersion !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(clientVersion) || clientVersion.length > 32) {
        throw new CatalogError(400, 'client_version must be a major.minor.patch version');
      }
      if (signal?.aborted) throw new CatalogError(499, 'Model catalog request was cancelled');
      const cached = cache.get(clientVersion);
      if (cached?.expires > Date.now()) {
        return { body: JSON.parse(cached.json), cacheControl: 'no-store' };
      }
      cache.delete(clientVersion);
      const url = new URL(catalogEndpoint);
      url.searchParams.set('client_version', clientVersion);
      const results = await Promise.allSettled([
        requestJSON(url, commonHeaders, timeoutMs, signal),
        requestJSON(modelsEndpoint, apiHeaders, timeoutMs, signal),
      ]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      const [catalog, apiModels] = results.map(result => result.value);
      const body = filterCatalog(catalog.body, apiModels.body);
      const json = JSON.stringify(body);
      if (Buffer.byteLength(json) > MAX_CATALOG_BYTES) throw new CatalogError(502, 'Filtered model catalog exceeds the client size limit');
      const expires = Math.min(catalog.receivedAt + cacheLifetime(catalog.headers),
        apiModels.receivedAt + cacheLifetime(apiModels.headers));
      if (expires > Date.now()) {
        if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(clientVersion, { json, expires });
      }
      return { body, cacheControl: 'no-store' };
    },
  };
}
