/**
 * Serves the web app alone (no host): enough for `?demo` and for UI-only checks.
 * Usage: bun e2e/serve-web.ts [port]   (default 19310)
 */
import index from '../src/web/index.html';

const port = Number(process.argv[2] ?? process.env.PORT ?? 19310);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  development: false,
  // Bun enables SO_REUSEPORT when development is off; a stale server must make this fail loudly.
  reusePort: false,
  routes: { '/': index, '/api/health': () => Response.json({ ok: true, name: 'web-only', version: 'dev', protocol: 1 }) },
  fetch: () => new Response('not found', { status: 404 }),
});
console.log(`web app on http://127.0.0.1:${server.port}/`);
