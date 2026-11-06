/**
 * The web app served compressed (QA round 2, hobbyist: 445 KB uncompressed, a 3.7 s cold load on
 * slow Wi-Fi): gzip and brotli by Accept-Encoding, ETags and 304s, a minified production bundle.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { join } from 'node:path';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { startHost, type Host } from '../src/server/host.ts';
import { acceptedEncodings } from '../src/server/web-assets.ts';
import { cleanupTmp, eventually, padConfig, tmpDir, writeJson } from './helpers.ts';

afterAll(cleanupTmp);
const hosts: Host[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
});

async function setup(preloadWebApp = false) {
  const dir = tmpDir('buttpad-web-');
  writeJson(join(dir, 'c.json'), padConfig([{ id: 'a', x: 0, y: 0, action: { type: 'none' } }]));
  const host = await startHost({ configPath: join(dir, 'c.json'), host: '127.0.0.1', port: 0, log: () => {}, preloadWebApp });
  hosts.push(host);
  return host;
}

/** A raw HTTP request (fetch would decompress): status, headers, the body bytes as sent. */
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
    const extra = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    const s = connect(port, '127.0.0.1', () => s.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n${extra}\r\n`));
    const chunks: Buffer[] = [];
    s.on('data', (d: Buffer) => chunks.push(d));
    s.on('end', () => {
      const all = Buffer.concat(chunks);
      const i = all.indexOf('\r\n\r\n');
      const [status, ...lines] = all.subarray(0, i).toString().split('\r\n');
      const h = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      let body = all.subarray(i + 4);
      // Bun may answer chunked: undo it.
      if (h['transfer-encoding'] === 'chunked') {
        const parts: Buffer[] = [];
        let at = 0;
        for (;;) {
          const eol = body.indexOf('\r\n', at);
          const n = parseInt(body.subarray(at, eol).toString(), 16);
          if (!n) break;
          parts.push(body.subarray(eol + 2, eol + 2 + n));
          at = eol + 2 + n + 2;
        }
        body = Buffer.concat(parts);
      }
      resolve({ status: Number(status!.split(' ')[1]), headers: h, body });
    });
    s.on('error', reject);
  });
}

test('Accept-Encoding', () => {
  expect([...acceptedEncodings('gzip, deflate, br')].sort()).toEqual(['br', 'deflate', 'gzip']);
  expect([...acceptedEncodings('br;q=0, gzip;q=0.5')]).toEqual(['gzip']);
  expect([...acceptedEncodings(null)]).toEqual([]);
  expect([...acceptedEncodings('*')].sort()).toEqual(['*', 'br', 'gzip']);
});

describe('the web app, compressed', () => {
  test('gzip and brotli by Accept-Encoding, the same bytes underneath; much smaller than before', async () => {
    const host = await setup();
    const page = await raw(host.port, 'GET', '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-cache');
    const html = page.body.toString();
    const chunks = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]!);
    expect(chunks.some((c) => c.endsWith('.js'))).toBe(true);
    expect(chunks.some((c) => c.endsWith('.css'))).toBe(true);
    let plain = 0;
    let gz = 0;
    for (const path of ['/', ...chunks]) {
      const identity = await raw(host.port, 'GET', path);
      expect(identity.headers['content-encoding']).toBeUndefined();
      const g = await raw(host.port, 'GET', path, { 'accept-encoding': 'gzip, deflate' });
      expect(g.headers['content-encoding']).toBe('gzip');
      expect(g.headers.vary).toBe('Accept-Encoding');
      expect(gunzipSync(g.body).equals(identity.body)).toBe(true);
      expect(g.headers.etag).not.toBe(identity.headers.etag);
      if (path !== '/') expect(g.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      plain += identity.body.length;
      gz += g.body.length;
    }
    expect(gz).toBeLessThan(plain * 0.5);
    // Brotli is made in the background; once there, it is preferred.
    const js = chunks.find((c) => c.endsWith('.js'))!;
    const br = await eventually(async () => {
      const r = await raw(host.port, 'GET', js, { 'accept-encoding': 'gzip, br' });
      return r.headers['content-encoding'] === 'br' && r;
    }, 15_000, 'brotli');
    const identity = await raw(host.port, 'GET', js);
    expect(brotliDecompressSync(br.body).equals(identity.body)).toBe(true);
    expect((await raw(host.port, 'GET', js, { 'accept-encoding': 'gzip, br;q=0' })).headers['content-encoding']).toBe('gzip');
  }, 30_000);

  test('the production bundle is minified, without source maps', async () => {
    const host = await setup();
    const html = (await raw(host.port, 'GET', '/')).body.toString();
    const js = (await raw(host.port, 'GET', /src="(\/[^"]+\.js)"/.exec(html)![1]!)).body.toString();
    expect(js.length).toBeGreaterThan(10_000);
    expect(js.split('\n').length).toBeLessThan(js.length / 2000);
    expect(js).not.toContain('sourceMappingURL');
  });

  test('ETag: a revalidation is a 304; HEAD has no body; only GET and HEAD', async () => {
    const host = await setup(true);
    const first = await raw(host.port, 'GET', '/', { 'accept-encoding': 'gzip' });
    const again = await raw(host.port, 'GET', '/', { 'accept-encoding': 'gzip', 'if-none-match': first.headers.etag! });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
    // Another encoding's ETag doesn't match this one.
    expect((await raw(host.port, 'GET', '/', { 'if-none-match': first.headers.etag! })).status).toBe(200);
    const head = await raw(host.port, 'HEAD', '/', { 'accept-encoding': 'gzip' });
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(first.body.length));
    const post = await raw(host.port, 'POST', '/');
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    expect((await raw(host.port, 'GET', '/nope.js')).status).toBe(404);
  });
});
