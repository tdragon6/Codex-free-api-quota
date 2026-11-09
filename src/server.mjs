import http from 'node:http';
import https from 'node:https';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { gunzipSync, inflateSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { TextDecoder } from 'node:util';
import { sanitizeRequest, upstreamHeaders, responseHeaders } from './sanitize.mjs';
import { createCatalog } from './catalog.mjs';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function digest(value) { return createHash('sha256').update(value).digest(); }
function authenticated(req, localApiKey) {
  if (!localApiKey) return true;
  return typeof req.headers.authorization === 'string' && timingSafeEqual(digest(req.headers.authorization), digest(`Bearer ${localApiKey}`));
}

function readLimited(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let overLimit = false;
    stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        if (!overLimit) reject(new HttpError(413, 'Body exceeds configured limit'));
        overLimit = true;
        chunks.length = 0;
      } else if (!overLimit) chunks.push(chunk);
    });
    stream.once('end', () => { if (!overLimit) resolve(Buffer.concat(chunks)); });
    stream.once('error', reject);
    stream.once('aborted', () => reject(new Error('Connection aborted')));
  });
}

function decodeBody(raw, encoding, limit) {
  const decoders = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync, zstd: zstdDecompressSync };
  if (!encoding || encoding === 'identity') return raw;
  if (!decoders[encoding]) throw new HttpError(415, 'Unsupported Content-Encoding');
  try { return decoders[encoding](raw, { maxOutputLength: limit }); }
  catch (error) { throw new HttpError(error.code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 400, 'Invalid or oversized compressed body'); }
}

function parseJSON(raw) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw new HttpError(400, 'Body must contain valid UTF-8 JSON'); }
}

const routePatterns = [
  ['GET', /^\/v1\/models(?:\/[A-Za-z0-9_.:-]+)?$/],
  ['POST', /^\/v1\/(?:responses(?:\/(?:compact|input_tokens))?|chat\/completions|embeddings)$/],
  ['GET', /^\/v1\/responses\/[A-Za-z0-9_-]+(?:\/input_items)?$/],
  ['DELETE', /^\/v1\/responses\/[A-Za-z0-9_-]+$/],
  ['POST', /^\/v1\/responses\/[A-Za-z0-9_-]+\/cancel$/],
];
function upstreamURL(req, base) {
  const rawPath = req.url.split('?')[0];
  if (!routePatterns.some(([method, pattern]) => req.method === method && pattern.test(rawPath))) throw new HttpError(404, 'Unsupported API route');
  const url = new URL(base + rawPath.slice(3));
  const query = new URL(req.url, 'http://localhost').searchParams;
  const allowed = new Set(['after', 'before', 'limit', 'order', 'include', 'include[]', 'stream', 'starting_after']);
  for (const [key, value] of query) if (allowed.has(key)) url.searchParams.append(key, value);
  return url;
}

function sendJSON(res, status, value, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

export function createRelay(config, options = {}) {
  const log = options.log || (() => {});
  const active = new Set();
  const catalog = createCatalog(config);
  const server = http.createServer({ maxHeaderSize: 64 * 1024 }, async (req, res) => {
    const started = Date.now();
    let upstreamRequest;
    let timeout;
    let expired = false;
    let route = 'invalid';
    let upstreamId;
    const abort = () => upstreamRequest?.destroy(new Error('Client disconnected'));
    res.on('close', () => { if (!res.writableEnded) abort(); });
    req.on('aborted', abort);
    res.on('finish', () => log({ method: req.method, route, status: res.statusCode, ms: Date.now() - started,
      ...(upstreamId ? { requestId: upstreamId } : {}) }));
    try {
      if (req.url === '/health' && req.method === 'GET') return sendJSON(res, 200, { status: 'ok', service: 'Codex-free-api-quota' });
      if (req.url === '/_relay/status' && req.method === 'GET' && options.control) {
        route = '/_relay/status';
        if (req.headers['x-relay-instance-id'] !== options.control.instanceId) throw new HttpError(409, 'Relay instance changed');
        return sendJSON(res, 200, { service: 'Codex-free-api-quota', instanceId: options.control.instanceId, pid: process.pid });
      }
      if (req.url === '/_relay/shutdown' && req.method === 'POST' && options.control) {
        route = '/_relay/shutdown';
        req.resume();
        if (req.headers['x-relay-instance-id'] !== options.control.instanceId) throw new HttpError(409, 'Relay instance changed');
        res.once('finish', () => setImmediate(options.control.shutdown));
        return sendJSON(res, 200, { status: 'stopping', instanceId: options.control.instanceId });
      }
      if (!authenticated(req, config.localApiKey)) {
        req.resume();
        return sendJSON(res, 401, { error: { message: 'Invalid local API key', type: 'authentication_error' } });
      }
      if (req.method === 'GET' && req.url.split('?')[0] === '/codex/models') {
        route = '/codex/models';
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', cancel);
        try {
          const version = new URL(req.url, 'http://localhost').searchParams.get('client_version');
          const result = await catalog.get(version, { signal: controller.signal });
          return sendJSON(res, 200, result.body, { 'cache-control': result.cacheControl });
        } finally { res.off('close', cancel); }
      }
      const url = upstreamURL(req, config.upstreamBase);
      route = req.url.split('?')[0];
      let body;
      let wantsStream = url.searchParams.get('stream') === 'true';
      if (req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Content-Type must be application/json');
        const raw = await readLimited(req, config.maxBodyBytes);
        const parsed = parseJSON(decodeBody(raw, req.headers['content-encoding'], config.maxBodyBytes));
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new HttpError(400, 'Body must be a JSON object');
        const clean = sanitizeRequest(parsed);
        wantsStream = clean.stream === true;
        body = Buffer.from(JSON.stringify(clean));
        if (body.length > config.maxBodyBytes) throw new HttpError(413, 'Rewritten body exceeds configured limit');
      } else req.resume();
      if (res.destroyed) return;
      const transport = url.protocol === 'https:' ? https : http;
      const upstream = await new Promise((resolve, reject) => {
        upstreamRequest = transport.request(url, { method: req.method,
          headers: upstreamHeaders(config, !!body, wantsStream) }, resolve);
        active.add(upstreamRequest);
        upstreamRequest.once('error', reject);
        // Deadline applies to the whole call, including the response stream.
        timeout = setTimeout(() => {
          expired = true;
          upstreamRequest.destroy(new Error('Upstream timeout'));
        }, config.timeoutMs);
        timeout.unref();
        upstreamRequest.end(body);
      });
      upstreamId = upstream.headers['x-request-id'];
      if (upstream.statusCode >= 300 && upstream.statusCode < 400) {
        upstream.resume();
        throw new HttpError(502, 'Upstream redirect rejected');
      }
      res.writeHead(upstream.statusCode, responseHeaders(upstream.headers));
      res.flushHeaders();
      // Forward response bytes unchanged, including JSON, errors and SSE events.
      await pipeline(upstream, res);
    } catch (error) {
      upstreamRequest?.destroy();
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = expired ? 504 : error.status || 502;
      // Network error details can include proxy credentials. Never expose them.
      const message = expired ? 'Upstream request timed out' : error.status ? error.message : 'Unable to reach upstream API';
      sendJSON(res, status, { error: { message, type: status >= 500 ? 'relay_error' : 'invalid_request_error' } });
      req.resume();
    } finally {
      clearTimeout(timeout);
      active.delete(upstreamRequest);
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 5000;
  return { server, destroyActive: () => { for (const req of active) req.destroy(); } };
}
