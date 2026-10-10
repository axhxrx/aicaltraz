/** Command line: flags, startup banner with pairing URLs + QR, --ready-json, graceful shutdown. */
import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import { ConfigLoadError } from './config-store.ts';
import { startHost, VERSION, type Host } from './host.ts';

export const USAGE = `Usage: buttpad [options]

  --config PATH     config file (default ./buttpad.config.json, or $BUTTPAD_CONFIG);
                    a starter config is written there if it doesn't exist
  --secrets PATH    token file (default: buttpad.secrets.json next to the config)
  --host H          listen address (overrides config server.host)
  --port N          listen port (overrides config server.port; 0 = any free port)
  --rotate-tokens   generate new press/admin tokens (paired devices must pair again)
  --no-qr           don't print the pairing QR code
  --ready-json      once listening, print one JSON line to stdout (other output goes to stderr)
  --tls-cert PATH   serve HTTPS with this PEM certificate…
  --tls-key PATH    …and this PEM private key
  -h, --help        show this help
  -v, --version     print the version
`;

export class UsageError extends Error {}

export interface CliOptions {
  config: string;
  secrets?: string;
  host?: string;
  port?: number;
  rotateTokens: boolean;
  qr: boolean;
  readyJson: boolean;
  tls?: { cert: string; key: string };
  help: boolean;
  version: boolean;
}

export function parseCli(argv: string[], env: Record<string, string | undefined> = process.env): CliOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        config: { type: 'string' },
        secrets: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
        'rotate-tokens': { type: 'boolean' },
        'no-qr': { type: 'boolean' },
        'ready-json': { type: 'boolean' },
        'tls-cert': { type: 'string' },
        'tls-key': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  let port: number | undefined;
  if (values.port !== undefined) {
    port = /^\d{1,5}$/.test(values.port) ? Number(values.port) : NaN;
    if (!(port >= 0 && port <= 65535)) throw new UsageError(`--port must be 0-65535, got "${values.port}"`);
  }
  const cert = values['tls-cert'];
  const key = values['tls-key'];
  if (!cert !== !key) throw new UsageError('--tls-cert and --tls-key go together');
  if (values.host === '') throw new UsageError('--host must not be empty');
  return {
    config: values.config || env.BUTTPAD_CONFIG || './buttpad.config.json',
    secrets: values.secrets,
    host: values.host,
    port,
    rotateTokens: !!values['rotate-tokens'],
    qr: !values['no-qr'],
    readyJson: !!values['ready-json'],
    tls: cert && key ? { cert, key } : undefined,
    help: !!values.help,
    version: !!values.version,
  };
}

type Ifaces = ReturnType<typeof networkInterfaces>;

/** Hostnames to print pairing URLs for: every non-internal IPv4 plus localhost when bound to all interfaces. */
export function pairingHosts(bind: string, ifaces: Ifaces = networkInterfaces()): string[] {
  if (!['', '0.0.0.0', '::', '[::]'].includes(bind)) return /^(127\.|localhost$|::1$|\[::1\]$)/.test(bind) ? ['localhost'] : [bind];
  const ips = Object.values(ifaces)
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  return [...new Set(ips), 'localhost'];
}

export const pairingUrl = (scheme: string, host: string, port: number, token: string) =>
  `${scheme}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}/#token=${token}`;

async function printBanner(host: Host, out: (s: string) => void, qr: boolean) {
  const cfg = host.config.config;
  const buttons = cfg.pads.reduce((n, p) => n + p.buttons.length, 0);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  out(`ButtPad ${VERSION} · ${host.configPath} · ${plural(cfg.pads.length, 'pad')}, ${plural(buttons, 'button')}`);
  if (host.created.config) out(`Wrote a starter config to ${host.configPath} — edit it by hand (saves reload live) or use Edit mode via the admin URL.`);
  if (host.created.secrets) out(`Created ${host.secretsPath} (mode 0600) with new pairing tokens.`);
  if (host.created.rotatedTokens) out(`Rotated the tokens in ${host.secretsPath}: previously paired devices must pair again.`);
  if (host.created.fixedSecretsMode) out(`Tightened ${host.secretsPath} permissions to 0600.`);
  out(`Listening on ${host.scheme}://${host.hostname}:${host.port}`);

  const hosts = pairingHosts(host.hostname);
  const url = (h: string, token: string) => pairingUrl(host.scheme, h, host.port, token);
  out('\nPress URL (pairs a device that can push buttons):');
  for (const h of hosts) out(`  ${url(h, host.secrets.pressToken)}`);
  out('\nAdmin URL (can edit the config = run any command on this machine; treat it like a password):');
  for (const h of hosts) out(`  ${url(h, host.secrets.adminToken)}`);
  if (host.scheme === 'http')
    out('\n⚠  Plain HTTP: tokens and presses cross the network unencrypted. Use it on a network you trust, or pass --tls-cert/--tls-key.');
  const lan = hosts.find((h) => h !== 'localhost');
  if (qr && lan) {
    out(`\nScan to pair as a press device (${lan}):`);
    out(await QRCode.toString(url(lan, host.secrets.pressToken), { type: 'terminal', small: true }));
  } else out('');
}

const g = globalThis as { __buttpadHost?: Host; __buttpadSignals?: boolean };

function installSignalHandlers(log: (m: string) => void) {
  if (g.__buttpadSignals) return;
  g.__buttpadSignals = true;
  let stopping = false;
  const onSignal = (sig: NodeJS.Signals) => {
    const host = g.__buttpadHost;
    if (stopping || !host) {
      host?.state.forceKillAll();
      process.exit(1);
    }
    stopping = true;
    const n = host.state.running;
    log(`${sig}: shutting down${n ? `, stopping ${n} running action${n === 1 ? '' : 's'}` : ''}`);
    void host.stop().finally(() => process.exit(0));
  };
  for (const sig of ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? [] : ['SIGHUP'])] as NodeJS.Signals[]) process.on(sig, onSignal);
  // Last resort for unexpected exits: don't leave action process groups behind.
  process.on('exit', () => g.__buttpadHost?.state.forceKillAll());
}

const clock = () => new Date().toTimeString().slice(0, 8);

export async function main(argv: string[]): Promise<void> {
  let o: CliOptions;
  try {
    o = parseCli(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`buttpad: ${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (o.help) return void process.stdout.write(USAGE);
  if (o.version) return void process.stdout.write(`buttpad ${VERSION}\n`);

  // With --ready-json, stdout carries only the ready line.
  const stream = o.readyJson ? process.stderr : process.stdout;
  const out = (s: string) => void stream.write(s + '\n');
  const log = (m: string) => out(`${clock()} ${m}`);

  // `bun --hot` re-runs this module: stop the previous instance (and its actions) first.
  await g.__buttpadHost?.stop();
  g.__buttpadHost = undefined;

  let host: Host;
  try {
    host = await startHost({ configPath: o.config, secretsPath: o.secrets, host: o.host, port: o.port, rotateTokens: o.rotateTokens, tls: o.tls, log });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (e instanceof ConfigLoadError) process.stderr.write(`buttpad: invalid config ${e.path}:\n  ${e.errors.join('\n  ')}\n`);
    else if (err.code === 'EADDRINUSE') process.stderr.write(`buttpad: address in use (${err.message}); pick another --port, or --port 0 for any free one\n`);
    else process.stderr.write(`buttpad: ${err.message ?? String(e)}\n`);
    process.exit(1);
  }
  g.__buttpadHost = host;
  installSignalHandlers(log);
  await printBanner(host, out, o.qr);
  if (o.readyJson) {
    const { pressToken, adminToken } = host.secrets;
    process.stdout.write(JSON.stringify({ event: 'ready', port: host.port, pressToken, adminToken, configPath: host.configPath }) + '\n');
  }
}
