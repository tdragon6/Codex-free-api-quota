import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { isIP } from 'node:net';

export function loadConfig(root, env = process.env) {
  const envFile = resolve(root, '.env');
  // Parse without mutating the process environment: .env is local to this app.
  const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const values = { ...fileEnv, ...env };
  const number = (name, fallback, min, max) => {
    const value = Number(values[name] || fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const upstream = new URL(values.OPENAI_BASE_URL || 'https://api.openai.com/v1');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname);
  if (upstream.protocol !== 'https:' && !(upstream.protocol === 'http:' && loopback)) {
    throw new Error('OPENAI_BASE_URL requires HTTPS (HTTP is allowed only for loopback upstreams)');
  }
  if (upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Invalid OPENAI_BASE_URL');
  const catalog = new URL(values.OPENAI_CATALOG_URL || 'https://chatgpt.com/backend-api/codex/models');
  const catalogLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(catalog.hostname);
  if ((catalog.protocol !== 'https:' && !(catalog.protocol === 'http:' && catalogLoopback)) ||
      catalog.username || catalog.password || catalog.search || catalog.hash) throw new Error('Invalid OPENAI_CATALOG_URL');
  const rawHost = (values.HOST || '127.0.0.1').trim();
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const hostname = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
  if (!host || host.includes('%') || (!isIP(host) && !hostname.test(host))) {
    throw new Error('HOST must be an IP address or hostname without a protocol, port or IPv6 zone identifier');
  }
  const apiKey = values.OPENAI_API_KEY?.trim();
  if (!apiKey || apiKey === 'replace-with-your-official-key' || /\s/.test(apiKey)) throw new Error('Set OPENAI_API_KEY in .env');
  const localApiKey = values.LOCAL_API_KEY?.trim() || '';
  if (/\s/.test(localApiKey)) throw new Error('LOCAL_API_KEY must not contain whitespace');
  return {
    host, port: number('PORT', 8787, 0, 65535), apiKey, localApiKey,
    upstreamBase: upstream.href.replace(/\/$/, ''),
    catalogUrl: catalog.href,
    maxBodyBytes: number('MAX_BODY_MB', 32, 1, 512) * 1024 * 1024,
    timeoutMs: number('UPSTREAM_TIMEOUT_MS', 600000, 1000, 3600000),
    organization: values.OPENAI_ORGANIZATION || '', project: values.OPENAI_PROJECT || '',
    proxyEnv: Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']
      .filter(k => values[k]).map(k => [k, values[k]])),
  };
}

