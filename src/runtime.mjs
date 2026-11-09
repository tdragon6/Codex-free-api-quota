import { mkdirSync, readFileSync, openSync, writeFileSync, closeSync, unlinkSync, renameSync, chmodSync,
  fstatSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export function runtimePaths(root) {
  const directory = resolve(root, '.runtime');
  return { directory, state: resolve(directory, 'client.json'), lock: resolve(directory, 'server.lock'),
    reclaim: resolve(directory, 'reclaim.lock') };
}

export function ensureRuntime(root) {
  const paths = runtimePaths(root);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(paths.directory, 0o700);
  return paths;
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function writeExclusive(path, content) {
  // openSync throws before this function owns a file when the name already exists.
  const descriptor = openSync(path, 'wx', 0o600);
  let identity;
  try {
    identity = fstatSync(descriptor);
    writeFileSync(descriptor, content);
    closeSync(descriptor);
  } catch (error) {
    try { closeSync(descriptor); } catch {}
    try {
      const current = statSync(path);
      if (identity && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
    } catch {}
    throw error;
  }
}

export function acquireRuntime(root, instanceId) {
  const paths = ensureRuntime(root);
  const content = JSON.stringify({ pid: process.pid, instanceId });
  try { writeExclusive(paths.lock, content); return paths; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }

  // Only one process may inspect and replace a stale server lock at a time.
  // A crashed recovery leaves this mutex in place and requires explicit inspection.
  try { writeExclusive(paths.reclaim, content); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Runtime lock recovery is already in progress. Inspect .runtime/reclaim.lock before retrying.');
    throw error;
  }
  try {
    // The previous owner may have finished stopping since our first open attempt.
    try { writeExclusive(paths.lock, content); return paths; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let previous;
    let original;
    try { original = readFileSync(paths.lock, 'utf8'); previous = JSON.parse(original); }
    catch { throw new Error('Runtime lock is not readable. Check whether another instance is starting.'); }
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 || processExists(previous.pid)) {
      throw new Error('Another relay instance owns the runtime directory. Use status or stop first.');
    }
    if (readFileSync(paths.lock, 'utf8') !== original) throw new Error('Runtime lock changed during recovery. Retry after checking the running instance.');
    unlinkSync(paths.lock);
    // A normal starter can win this open after the stale file is removed. Never
    // remove that winner's file; exclusive creation will simply refuse our start.
    try { writeExclusive(paths.lock, content); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('Another relay instance acquired the runtime directory. Use status first.');
      throw error;
    }
    return paths;
  } finally {
    try { if (JSON.parse(readFileSync(paths.reclaim, 'utf8')).instanceId === instanceId) unlinkSync(paths.reclaim); } catch {}
  }
}

export function atomicWrite(path, content, instanceId) {
  const temporary = `${path}.${instanceId}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } finally { try { unlinkSync(temporary); } catch {} }
}

export function releaseRuntime(paths, instanceId) {
  for (const path of [paths.state, paths.lock]) {
    try { if (JSON.parse(readFileSync(path, 'utf8')).instanceId === instanceId) unlinkSync(path); } catch {}
  }
}
