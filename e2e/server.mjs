// Dependency-free static server for public/ that applies the headers from
// public/_headers (so the real CSP is enforced in the browsers under test)
// and mimics Cloudflare Pages: unknown paths fall back to index.html.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

// Cloudflare format: an unindented path pattern, then indented `Name: value`.
export function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (/^\s/.test(raw)) {
      const i = raw.indexOf(':');
      if (current && i > 0) current.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
    } else {
      current = { pattern: raw.trim(), headers: [] };
      rules.push(current);
    }
  }
  return rules;
}

function matches(pattern, pathname) {
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(pathname);
}

// Starts the server. `requests` records every request the server receives,
// so tests can prove that blocked attempts never reached it.
export async function start(port = 0) {
  const rules = parseHeaders(await readFile(path.join(ROOT, '_headers'), 'utf8'));
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, url: req.url });
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT) || path.basename(file) === '_headers') file = path.join(ROOT, 'index.html');
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      await stat(file);
    } catch {
      file = path.join(ROOT, 'index.html');
    }
    const body = await readFile(file);
    for (const rule of rules) {
      if (matches(rule.pattern, url.pathname)) for (const [k, v] of rule.headers) res.setHeader(k, v);
    }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { base } = await start(Number(process.env.PORT || 8774));
  console.log(base);
}
