/**
 * The web app, served compressed. Bun serves an HTML import uncompressed (445 KB for this app, 3.7 s
 * on a slow phone link), so in production the host serves the bundle itself: the page at `/`, the
 * hashed chunks at `/chunk-….js|css`, each gzip'ed (and brotli'ed: slower to make, so that one is
 * made in the background and served once ready), negotiated by Accept-Encoding, with an ETag. The
 * page revalidates (`no-cache`); the hashed chunks are cached for a year.
 *
 * The bundle comes from the HTML import: built ahead of time (`bun build --compile`), its files are
 * in the executable; run from source, it is built here, as Bun would for `development: false`
 * (minified, no source maps, NODE_ENV=production). Dev mode (`--dev`, HMR) keeps Bun's own serving.
 */
import type { HTMLBundle } from 'bun';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

/** Worth compressing: text, scripts, styles, SVG, JSON. */
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml|manifest\+json)|image\/svg\+xml)/;
/** Smaller than this, compression gains nothing worth a header. */
const MIN_COMPRESS_BYTES = 1024;
/** A compressed copy is kept only when it saves at least this much. */
const MIN_SAVING = 0.05;

type Bytes = Uint8Array<ArrayBuffer>;

export interface WebAsset {
  /** URL path: `/` for the page, `/chunk-x.js` for the rest. */
  path: string;
  type: string;
  /** Named by its content hash: cached for a year. The page itself is revalidated. */
  immutable: boolean;
  /** sha256 of the bytes, first 16 hex chars: the ETag (each encoding marked). */
  hash: string;
  raw: Bytes;
  gzip?: Bytes;
  br?: Bytes;
}

/** The encodings an Accept-Encoding header takes (q > 0). */
export function acceptedEncodings(header: string | null): Set<string> {
  const out = new Set<string>();
  for (const part of (header ?? '').toLowerCase().split(',')) {
    const [name = '', ...params] = part.split(';').map((s) => s.trim());
    const q = params.map((p) => /^q=([\d.]+)$/.exec(p)?.[1]).find((v) => v !== undefined);
    if (name && (q === undefined || Number(q) > 0)) out.add(name);
  }
  if (out.has('*')) for (const e of ['br', 'gzip']) out.add(e);
  return out;
}

const etagMatches = (header: string | null, etag: string) =>
  !!header && header.split(',').some((t) => {
    const v = t.trim().replace(/^W\//, '');
    return v === '*' || v === etag;
  });

export class WebAssets {
  /** Settles once every brotli copy is made (or given up on). */
  readonly ready: Promise<void>;

  private constructor(private readonly assets: Map<string, WebAsset>) {
    this.ready = Promise.all(
      [...assets.values()].map(async (a) => {
        if (!a.gzip) return; // not worth compressing
        try {
          const br = await brotli(a.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: a.raw.length } });
          if (br.length < a.gzip.length) a.br = new Uint8Array(br);
        } catch {}
      }),
    ).then(() => {});
  }

  /** Load the bundle, gzip what's worth it; brotli follows in the background (`ready`). */
  static async load(bundle: HTMLBundle): Promise<WebAssets> {
    const files: { path: string; type: string; raw: Bytes }[] = [];
    if (bundle.files?.length) {
      // Built ahead of time (bun build --compile): the outputs are in the executable.
      for (const f of bundle.files)
        files.push({ path: f.loader === 'html' ? '/' : `/${basename(f.path)}`, type: f.headers['content-type'], raw: await Bun.file(f.path).bytes() });
    } else {
      const r = await Bun.build({
        entrypoints: [bundle.index],
        target: 'browser',
        minify: true,
        sourcemap: 'none',
        publicPath: '/',
        define: { 'process.env.NODE_ENV': '"production"' },
        // Say what failed (the logs), not just "Bundle failed".
        throw: false,
      });
      if (!r.success) throw new Error(`the web app did not build:\n${r.logs.map(String).join('\n')}`);
      for (const o of r.outputs) {
        const name = o.path.replace(/^\.\//, '');
        files.push({ path: name.endsWith('.html') ? '/' : `/${name}`, type: o.type, raw: new Uint8Array(await o.arrayBuffer()) });
      }
    }
    const assets = new Map<string, WebAsset>();
    await Promise.all(
      files.map(async (f) => {
        const a: WebAsset = { ...f, immutable: f.path !== '/', hash: createHash('sha256').update(f.raw).digest('hex').slice(0, 16) };
        if (COMPRESSIBLE.test(f.type) && f.raw.length >= MIN_COMPRESS_BYTES) {
          const gz = await gzip(f.raw, { level: 9 });
          if (gz.length <= f.raw.length * (1 - MIN_SAVING)) a.gzip = new Uint8Array(gz);
        }
        assets.set(a.path, a);
      }),
    );
    return new WebAssets(assets);
  }

  get(path: string): WebAsset | undefined {
    return this.assets.get(path);
  }

  /** Every asset (measurement, tests). */
  all(): WebAsset[] {
    return [...this.assets.values()];
  }

  /** GET/HEAD of `a`: the best encoding the client takes, 304 when its ETag matches. */
  respond(req: Request, a: WebAsset): Response {
    const accepted = acceptedEncodings(req.headers.get('accept-encoding'));
    const enc = a.br && accepted.has('br') ? 'br' : a.gzip && accepted.has('gzip') ? 'gzip' : undefined;
    const body = enc === 'br' ? a.br! : enc === 'gzip' ? a.gzip! : a.raw;
    const etag = `"${a.hash}${enc === 'br' ? '-br' : enc === 'gzip' ? '-gz' : ''}"`;
    const headers: Record<string, string> = {
      'content-type': a.type,
      etag,
      'cache-control': a.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    };
    // What a client gets depends on its Accept-Encoding: caches (a reverse proxy) must keep them apart.
    if (a.gzip) headers.vary = 'Accept-Encoding';
    if (enc) headers['content-encoding'] = enc;
    if (etagMatches(req.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
    if (req.method === 'HEAD') return new Response(null, { headers: { ...headers, 'content-length': String(body.length) } });
    return new Response(body, { headers });
  }
}
