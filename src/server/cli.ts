/** Command line: flags, startup banner with pairing URLs + QR, --ready-json, graceful shutdown. */
import { readFileSync } from 'node:fs';
import { constants, homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import { configWarnings } from './config-warnings.ts';
import { errnoText } from './errors.ts';
import { startHost, VERSION, type Host } from './host.ts';
import { sanitizeLog } from './runner.ts';

export const USAGE = `Usage: buttpad [options]

  --config PATH     config file (default ./buttpad.config.json, or $BUTTPAD_CONFIG);
                    a starter config is written there if it doesn't exist. Paths may
                    start with ~/ (here and below), even quoted
  --secrets PATH    token file (default: buttpad.secrets.json next to the config)
  --host H          listen address (overrides config server.host)
  --port N          listen port (overrides config server.port; 0 = any free port)
  --rotate-tokens   generate new press/admin tokens (paired devices must pair again)
  --no-qr           don't print the pairing QR code
  --ready-json      once listening, print one JSON line to stdout (other output goes to stderr)
  --tls-cert PATH   serve HTTPS with this PEM certificate…
  --tls-key PATH    …and this PEM private key
  --dev             Bun dev mode for working on the web app (HMR, source maps);
                    never on a network you don't trust
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
  dev: boolean;
  help: boolean;
  version: boolean;
}

/**
 * `~` and `~/x` → the home directory, as a shell would have done: `--config=~/x`, a quoted `'~/x'` and
 * `BUTTPAD_CONFIG='~/x'` reach us unexpanded (and would otherwise create a directory named `~`).
 */
export function expandTilde(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || (process.platform === 'win32' && p.startsWith('~\\'))) return join(home, p.slice(2));
  return p;
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
        dev: { type: 'boolean' },
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
  const home = env.HOME || env.USERPROFILE || homedir();
  const path = (p: string) => expandTilde(p, home);
  return {
    config: path(values.config || env.BUTTPAD_CONFIG || './buttpad.config.json'),
    secrets: values.secrets === undefined ? undefined : path(values.secrets),
    host: values.host,
    port,
    rotateTokens: !!values['rotate-tokens'],
    qr: !values['no-qr'],
    readyJson: !!values['ready-json'],
    tls: cert && key ? { cert: path(cert), key: path(key) } : undefined,
    dev: !!values.dev,
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
  for (const w of configWarnings(cfg, host.config.dir)) out(`⚠  ${sanitizeLog(w)}`);

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

const g = globalThis as { __buttpadHost?: Host; __buttpadSignals?: boolean; __buttpadPipes?: boolean };

/**
 * Whether signal number `signo` is ignored by this process, per the SigIgn mask of /proc/self/status
 * (Linux). Before any handler is installed that's the disposition inherited from the parent, e.g.
 * SIGHUP under `nohup`. undefined where it can't be told.
 */
export function signalIgnored(signo: number, status?: string): boolean | undefined {
  if (status === undefined) {
    if (process.platform !== 'linux') return undefined;
    try {
      status = readFileSync('/proc/self/status', 'utf8');
    } catch {
      return undefined;
    }
  }
  const mask = /^SigIgn:\s*([0-9a-f]+)\s*$/im.exec(status)?.[1];
  return mask === undefined ? undefined : ((BigInt(`0x${mask}`) >> BigInt(signo - 1)) & 1n) === 1n;
}

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
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  // Hang-up ends the host, unless it was started to survive one (nohup: SIGHUP inherited as ignored).
  // Where that can't be told (macOS), the handler is installed regardless.
  if (process.platform !== 'win32' && signalIgnored(constants.signals.SIGHUP) !== true) signals.push('SIGHUP');
  for (const sig of signals) process.on(sig, onSignal);
  // Last resort for unexpected exits: don't leave action process groups behind.
  process.on('exit', () => g.__buttpadHost?.state.forceKillAll());
}

/** A log reader that went away (`buttpad | tee log` and tee died) must not take the host down. */
function tolerateBrokenPipes() {
  if (g.__buttpadPipes) return;
  g.__buttpadPipes = true;
  for (const s of [process.stdout, process.stderr])
    s.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE') throw e;
    });
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

  tolerateBrokenPipes();
  // With --ready-json, stdout carries only the ready line.
  const stream = o.readyJson ? process.stderr : process.stdout;
  const out = (s: string) => void stream.write(s + '\n');
  const log = (m: string) => out(`${clock()} ${m}`);

  // `bun --hot` re-runs this module: stop the previous instance (and its actions) first.
  await g.__buttpadHost?.stop();
  g.__buttpadHost = undefined;

  let host: Host;
  try {
    host = await startHost({
      configPath: o.config,
      secretsPath: o.secrets,
      host: o.host,
      port: o.port,
      rotateTokens: o.rotateTokens,
      tls: o.tls,
      development: o.dev,
      log,
    });
  } catch (e) {
    // ListenError, WriteError and the like already say what happened in words; a bare errno gets them.
    const msg = e instanceof Error ? e.message : String(e);
    const file = /^E[A-Z]+: .*'([^']+)'$/.exec(msg)?.[1];
    // It may quote the config file (an invalid config's errors): no escape sequences to the terminal.
    process.stderr.write(`buttpad: ${sanitizeLog(/^E[A-Z]+: /.test(msg) ? `${errnoText(e)}${file ? `: ${file}` : ''}` : msg)}\n`);
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
