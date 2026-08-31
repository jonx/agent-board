#!/usr/bin/env node
// Entry point: self-check invariants, open the DB, serve MCP + API + UI on localhost.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { openDatabase } from './db.js';
import { Store } from './store.js';
import { runInvariantChecks } from './invariants.js';
import { createHttpServer } from './http.js';
import { VERSION, changelogSince } from './changelog.js';

export const DEFAULT_DATA_DIR = process.env.BOARD_DATA ?? join(homedir(), '.agent-board');
export const DEFAULT_PORT = Number(process.env.BOARD_PORT ?? 7777);

export function loadHumanToken(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const f = join(dataDir, 'human.token');
  if (!existsSync(f)) writeFileSync(f, randomBytes(24).toString('hex'), { mode: 0o600 });
  return readFileSync(f, 'utf8').trim();
}

export function startServer({ port = DEFAULT_PORT, host = '127.0.0.1', dataDir = DEFAULT_DATA_DIR, quiet = false } = {}) {
  const check = runInvariantChecks();
  if (!check.ok) {
    console.error('REFUSING TO START: human-in-the-loop invariants are broken:\n - ' + check.failures.join('\n - '));
    process.exit(2);
  }
  const db = openDatabase(join(dataDir, 'board.db'));
  const store = new Store(db);
  const humanToken = loadHumanToken(dataDir);
  const v = store.recordVersion(VERSION, changelogSince);
  if (v.changed && v.previous && !quiet) console.log(`board updated ${v.previous} → ${v.version}: update notice posted in every project`);
  const uiFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
  const server = createHttpServer({ store, humanToken, uiFile });
  server.on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`port ${port} is already in use — the board is probably already running (\`board service status\`, \`board open\`).\nTo run a second instance: board serve --port <other>. To stop the service: board service uninstall.`);
    process.exit(1);
  });
  return new Promise(resolve => server.listen(port, host, () => {
    const base = `http://${host}:${server.address().port}`;
    if (!quiet) {
      console.log(`agent-board ${VERSION} ready  (invariants OK, db: ${join(dataDir, 'board.db')})`);
      console.log(`  human UI : ${base}/#token=${humanToken}`);
      console.log(`  agents   : ${base}/mcp/<project>/<agent-name>`);
    }
    resolve({ server, store, base, humanToken });
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  startServer({ port: Number(opt('--port', DEFAULT_PORT)), host: opt('--host', '127.0.0.1'), dataDir: opt('--data', DEFAULT_DATA_DIR) });
}
