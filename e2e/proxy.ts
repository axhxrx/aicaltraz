/**
 * A TCP proxy in front of a host, for link-failure tests: freeze links (the TCP connection stays
 * open but nothing moves, like Wi-Fi gone or a sleeping host), black-hole new connections, add
 * latency, hold back a socket's hello, or cut a link right after it forwarded a press.
 */
import net from 'node:net';

interface Link {
  client: net.Socket;
  upstream: net.Socket | null;
  frozen: boolean;
  openedAt: number;
  /** A WebSocket (its first chunk was `GET /ws…`). */
  ws: boolean;
}

export interface Proxy {
  readonly port: number;
  readonly url: string;
  /** Connections accepted so far. */
  readonly accepted: number;
  /** One-way delay for every chunk, both directions. */
  latency: number;
  /** Extra delay for chunks from the browser to the host only (a press that is slow to arrive, its answer not). */
  upLatency: number;
  /** Extra delay for WebSocket links only, both directions (a slow hello; the page itself loads fast). */
  wsLatency: number;
  /**
   * WebSocket links only: the upgrade's answer passes at once, the host's next bytes (its hello)
   * are held this long (a big config over a slow link), then everything flows.
   */
  helloDelayMs: number;
  /** pass: forward. blackhole: accept new connections and never forward a byte. */
  setMode(mode: 'pass' | 'blackhole'): void;
  /** WebSocket upgrades go nowhere (black-holed), plain HTTP passes. */
  blackholeWs: boolean;
  /**
   * Like a reverse proxy (or a preview pane) that passes requests on with its own `Host` (e.g. the
   * host's address): request headers from the browser get `Host: <this>`. The page's Origin is the
   * proxy's address all the same.
   */
  rewriteHost: string | null;
  /** Close every new connection this long after it opened (0 = off). */
  cutNewAfterMs: number;
  /**
   * Every request line the browser sent through it (`GET /ws?ticket=…`), as a reverse proxy's
   * access log keeps them: what must never carry a token.
   */
  readonly lines: string[];
  /** The next chunk from the browser is forwarded, then the link dies before anything comes back. */
  cutAfterNextUp(): void;
  /** Existing links stop moving bytes (their TCP connections stay open). */
  freezeAll(): void;
  /** Frozen links finally die (like a TCP timeout or RST). */
  killFrozen(): void;
  killAll(): void;
  close(): Promise<void>;
}

export async function startProxy(targetPort: number): Promise<Proxy> {
  const links = new Set<Link>();
  let mode: 'pass' | 'blackhole' = 'pass';
  let cutNext = false;
  let accepted = 0;
  const kill = (l: Link) => {
    l.client.destroy();
    l.upstream?.destroy();
    links.delete(l);
  };
  /** rewriteHost: request headers carry the proxy's own idea of the Host. */
  const rewrite = (d: Buffer) => (p.rewriteHost ? Buffer.from(d.toString('latin1').replace(/\r\nhost: [^\r]*\r\n/i, `\r\nHost: ${p.rewriteHost}\r\n`), 'latin1') : d);
  const lines: string[] = [];
  const server = net.createServer((client) => {
    accepted++;
    const l: Link = { client, upstream: null, frozen: mode === 'blackhole', openedAt: Date.now(), ws: false };
    links.add(l);
    client.on('error', () => {});
    // A request's head comes first in its chunk (browsers don't pipeline): its first line is the log line.
    client.on('data', (d: Buffer) => {
      const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]\r\n/.exec(d.toString('latin1', 0, Math.min(d.length, 8192)));
      if (m) lines.push(`${m[1]} ${m[2]}`);
    });
    client.on('close', () => {
      links.delete(l);
      l.upstream?.destroy();
    });
    if (l.frozen) return void client.on('data', () => {});
    if (p.cutNewAfterMs > 0) setTimeout(() => kill(l), p.cutNewAfterMs);
    const connect = (first?: Buffer) => {
      const up = net.connect(targetPort, '127.0.0.1');
      l.upstream = up;
      up.on('error', () => {});
      up.on('close', () => !l.frozen && client.destroy());
      // helloDelayMs: the answer's head goes through, what follows it is held for a while.
      let hello: { head: Buffer; held: Buffer[] | null } | null = l.ws && p.helloDelayMs > 0 ? { head: Buffer.alloc(0), held: null } : null;
      const holdHello = (d: Buffer) => {
        const h = hello!;
        if (h.held) return void h.held.push(d);
        h.head = Buffer.concat([h.head, d]);
        const end = h.head.indexOf('\r\n\r\n');
        if (end < 0) return;
        client.write(h.head.subarray(0, end + 4));
        h.held = h.head.length > end + 4 ? [h.head.subarray(end + 4)] : [];
        setTimeout(() => {
          hello = null;
          if (!l.frozen) for (const b of h.held!) client.write(b);
        }, p.helloDelayMs);
      };
      const pipe = (from: net.Socket, to: net.Socket, dir: 'up' | 'down') =>
        from.on('data', (d: Buffer) => {
          if (l.frozen) return;
          if (dir === 'up' && cutNext) {
            cutNext = false;
            to.write(d);
            l.frozen = true;
            setTimeout(() => kill(l), 150);
            return;
          }
          if (dir === 'down' && hello) return holdHello(d);
          if (dir === 'up') d = rewrite(d);
          const delay = p.latency + (dir === 'up' ? p.upLatency : 0) + (l.ws ? p.wsLatency : 0);
          if (delay) setTimeout(() => !l.frozen && to.write(d), delay);
          else to.write(d);
        });
      if (first) up.write(rewrite(first));
      pipe(client, up, 'up');
      pipe(up, client, 'down');
    };
    if (!p.blackholeWs && !p.wsLatency && !p.helloDelayMs && !p.rewriteHost) return connect();
    // Decide on the first chunk: WebSocket upgrades go nowhere (or slowly), plain HTTP passes.
    client.once('data', (first: Buffer) => {
      l.ws = first.toString('latin1').startsWith('GET /ws');
      if (l.ws && p.blackholeWs) {
        l.frozen = true;
        return void client.on('data', () => {});
      }
      if (l.ws && p.wsLatency) {
        // Hold the rest (if any) until the upgrade request has gone through.
        client.pause();
        return void setTimeout(() => {
          if (l.frozen) return;
          connect(first);
          client.resume();
        }, p.wsLatency);
      }
      connect(first);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const p: Proxy = {
    port,
    url: `http://127.0.0.1:${port}`,
    get accepted() {
      return accepted;
    },
    latency: 0,
    upLatency: 0,
    wsLatency: 0,
    helloDelayMs: 0,
    blackholeWs: false,
    rewriteHost: null,
    cutNewAfterMs: 0,
    lines,
    setMode: (m) => void (mode = m),
    cutAfterNextUp: () => void (cutNext = true),
    freezeAll: () => {
      for (const l of links) l.frozen = true;
    },
    killFrozen: () => {
      for (const l of [...links]) if (l.frozen) kill(l);
    },
    killAll: () => {
      for (const l of [...links]) kill(l);
    },
    close: async () => {
      p.killAll();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  return p;
}
