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
}

export interface Proxy {
  readonly port: number;
  readonly url: string;
  /** Connections accepted so far. */
  readonly accepted: number;
  /** One-way delay for every chunk, both directions. */
  latency: number;
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
    const l: Link = { client, upstream: null, frozen: mode === 'blackhole', openedAt: Date.now() };
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
          if (p.latency) setTimeout(() => !l.frozen && to.write(d), p.latency);
          else to.write(d);
        });
      if (first) up.write(first);
      pipe(client, up, 'up');
      pipe(up, client, 'down');
    };
    if (!p.blackholeWs) return connect();
    // Decide on the first chunk: WebSocket upgrades go nowhere, plain HTTP passes.
    client.once('data', (first: Buffer) => {
      if (first.toString('latin1').startsWith('GET /ws')) {
        l.frozen = true;
        return void client.on('data', () => {});
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
