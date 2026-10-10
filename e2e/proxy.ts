/**
 * A TCP proxy in front of a host, for link-failure tests: freeze links (the TCP connection stays
 * open but nothing moves, like Wi-Fi gone or a sleeping host), black-hole new connections, add
 * latency, or cut a link right after it forwarded a press.
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
  /** pass: forward. blackhole: accept new connections and never forward a byte. */
  setMode(mode: 'pass' | 'blackhole'): void;
  /** WebSocket upgrades go nowhere (black-holed), plain HTTP passes. */
  blackholeWs: boolean;
  /** Close every new connection this long after it opened (0 = off). */
  cutNewAfterMs: number;
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
  const server = net.createServer((client) => {
    accepted++;
    const l: Link = { client, upstream: null, frozen: mode === 'blackhole', openedAt: Date.now(), ws: false };
    links.add(l);
    client.on('error', () => {});
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
          const delay = p.latency + (dir === 'up' ? p.upLatency : 0) + (l.ws ? p.wsLatency : 0);
          if (delay) setTimeout(() => !l.frozen && to.write(d), delay);
          else to.write(d);
        });
      if (first) up.write(first);
      pipe(client, up, 'up');
      pipe(up, client, 'down');
    };
    if (!p.blackholeWs && !p.wsLatency) return connect();
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
    blackholeWs: false,
    cutNewAfterMs: 0,
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
