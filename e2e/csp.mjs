// Exact, per-directive checks of the Content-Security-Policy. Used by the e2e
// suite (against the header the server really sends) and by CI (`node
// e2e/csp.mjs`, against the files), so a substring match can never pass a
// policy that gained an extra source.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseHeaders } from './server.mjs';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// "a 'self'; b 'none'" -> { a: ["'self'"], b: ["'none'"] }. A repeated
// directive is an error: browsers use only the first one.
export function parseCsp(text) {
  const out = {};
  for (const part of text.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const [name, ...sources] = tokens;
    if (Object.hasOwn(out, name.toLowerCase())) throw new Error(`duplicate CSP directive: ${name}`);
    out[name.toLowerCase()] = sources;
  }
  return out;
}

export function headerPolicy() {
  const rules = parseHeaders(readFileSync(path.join(PUBLIC, '_headers'), 'utf8'));
  const values = rules.flatMap((r) => r.headers).filter(([k]) => k.toLowerCase() === 'content-security-policy');
  if (values.length !== 1) throw new Error(`expected one CSP in _headers, found ${values.length}`);
  return values[0][1];
}

export function metaPolicy() {
  const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*>/gi)];
  if (tags.length !== 1) throw new Error(`expected one CSP <meta> in index.html, found ${tags.length}`);
  return tags[0][1];
}

// Problems with a policy, as readable strings (empty = fine).
export function policyProblems(csp, { header }) {
  const p = parseCsp(csp);
  const problems = [];
  const exact = (name, want) => {
    const got = p[name];
    if (!got || got.join(' ') !== want.join(' ')) problems.push(`${name} must be exactly ${want.join(' ')} (got ${got ? got.join(' ') : 'missing'})`);
  };
  exact('default-src', ["'self'"]);
  exact('script-src', ["'self'"]);
  exact('connect-src', ["'none'"]);
  exact('object-src', ["'none'"]);
  exact('base-uri', ["'none'"]);
  exact('form-action', ["'none'"]);
  for (const [name, sources] of Object.entries(p)) {
    if (sources.some((s) => /unsafe-|^\*$|^https?:/i.test(s))) problems.push(`${name} allows ${sources.join(' ')}`);
  }
  if (header) exact('frame-ancestors', ["'none'"]);
  else if ('frame-ancestors' in p) problems.push('frame-ancestors is ignored in a <meta> CSP');
  return problems;
}

// The <meta> copy must equal the header minus frame-ancestors (which only
// works as a header).
export function metaMismatch(headerCsp, metaCsp) {
  const h = parseCsp(headerCsp);
  delete h['frame-ancestors'];
  const m = parseCsp(metaCsp);
  const names = new Set([...Object.keys(h), ...Object.keys(m)]);
  const diffs = [];
  for (const n of names) {
    if ((h[n] || []).join(' ') !== (m[n] || []).join(' ')) {
      diffs.push(`${n}: header "${(h[n] || ['(none)']).join(' ')}" vs meta "${(m[n] || ['(none)']).join(' ')}"`);
    }
  }
  return diffs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const header = headerPolicy();
  const meta = metaPolicy();
  const problems = [
    ...policyProblems(header, { header: true }).map((s) => `_headers: ${s}`),
    ...policyProblems(meta, { header: false }).map((s) => `index.html meta: ${s}`),
    ...metaMismatch(header, meta).map((s) => `meta differs from _headers: ${s}`),
  ];
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('CSP ok');
}
