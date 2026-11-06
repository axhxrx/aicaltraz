/**
 * Non-blocking checks of a config: what would fail when pressed, found before anyone presses it.
 * Commands resolve as the runner resolves them (relative to the action's working folder, else PATH,
 * from the action's own env if it sets one). Each warning names its button:
 *
 *   pad "lights" › button "all-on": command not found: /srv/bp/scripts/lite.sh
 */
import { accessSync, closeSync, constants, openSync, readSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { buttonKey, type Button, type Config } from '../core/config.ts';
import { expandHome, resolveCwd, shellArgv } from './runner.ts';

export const MAX_WARNINGS = 50;

const isWindows = process.platform === 'win32';
const hasSep = (p: string) => p.includes('/') || (isWindows && p.includes('\\'));

/** First bytes of executables the kernel runs without a #! line: ELF, Mach-O (thin and fat). */
const BINARY_MAGIC = ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'];

function head(path: string, n = 256): Buffer | undefined {
  try {
    const fd = openSync(path, constants.O_RDONLY | (isWindows ? 0 : (constants.O_NONBLOCK ?? 0)));
    try {
      const buf = Buffer.alloc(n);
      return buf.subarray(0, readSync(fd, buf, 0, n, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** What's wrong with the program at `path` (absolute), as the runner would report it at spawn. */
function checkProgram(path: string, what: string, PATH: string | undefined): string | undefined {
  let st;
  try {
    st = statSync(path);
  } catch {
    return `${what} not found: ${path}`;
  }
  if (st.isDirectory()) return `is a directory: ${path}`;
  if (!st.isFile()) return `not a regular file: ${path}`;
  if (isWindows) return undefined;
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return `permission denied (chmod +x?): ${path}`;
  }
  const bytes = head(path);
  if (!bytes || bytes.length === 0) return bytes ? `not executable as a program (it's empty): ${path}` : undefined;
  if (bytes[0] !== 0x23 || bytes[1] !== 0x21) {
    if (BINARY_MAGIC.includes(bytes.subarray(0, 4).toString('hex'))) return undefined;
    return `not executable as a program (missing #! line?): ${path}`;
  }
  const [interp, arg] = bytes.subarray(2).toString('latin1').split('\n')[0]!.trim().split(/\s+/);
  if (!interp) return `interpreter not found (the #! line is empty): ${path}`;
  try {
    if (!statSync(interp).isFile()) throw new Error();
  } catch {
    return `interpreter not found (check the #! line): ${path} wants ${interp}`;
  }
  if (basename(interp) === 'env' && arg && !arg.startsWith('-') && !arg.includes('=') && !Bun.which(arg, { PATH }))
    return `interpreter not found (check the #! line): ${path} wants ${arg}, which isn't on PATH`;
  return undefined;
}

function checkAction(b: Button, baseDir: string, env: Record<string, string | undefined>): string | undefined {
  const a = b.action;
  if (a.type === 'none') return undefined;
  const cwd = resolveCwd(baseDir, a.cwd);
  let dir = false;
  try {
    dir = statSync(cwd).isDirectory();
  } catch {}
  if (!dir) return `cwd not found: ${cwd}`;
  const PATH = a.env?.PATH ?? env.PATH;
  const program = a.type === 'exec' ? expandHome(a.command) : shellArgv(a.script, a.shell).argv[0]!;
  const what = a.type === 'exec' ? 'command' : 'shell';
  if (hasSep(program)) return checkProgram(resolve(cwd, program), what, PATH);
  const found = Bun.which(program, { PATH: PATH ?? '', cwd });
  if (!found) return `${what} not found: ${program} (not on PATH)`;
  return checkProgram(found, what, PATH);
}

/** `stops` patterns that stop nothing (but the button itself, which `stops` never does). */
function deadStops(b: Button, padId: string, cfg: Config): string[] {
  const self = buttonKey(padId, b.id);
  const keys = cfg.pads.flatMap((p) => p.buttons.map((x) => buttonKey(p.id, x.id)));
  return (b.stops ?? []).filter((pattern) => {
    if (pattern === '*') return false;
    const [pad, button] = pattern.split('/') as [string, string];
    return !keys.some((k) => k !== self && (button === '*' ? k.startsWith(`${pad}/`) : k === pattern));
  });
}

/**
 * A script as a POSIX shell parses it, roughly: `code` without quoted strings and comments (what is
 * syntax), `expanded` without single-quoted strings and comments (where `$…` expands: unquoted and
 * in double quotes). Good enough to spot bash syntax without flagging an awk program or an echo.
 */
export function shellViews(script: string): { code: string; expanded: string } {
  let code = '';
  let expanded = '';
  let i = 0;
  const n = script.length;
  /** At the start of a word: where a `#` starts a comment. */
  const wordStart = () => i === 0 || /[\s;&|()<>]/.test(script[i - 1]!);
  while (i < n) {
    const c = script[i]!;
    if (c === '\\') {
      code += '  ';
      expanded += '  ';
      i += 2;
    } else if (c === "'") {
      const end = script.indexOf("'", i + 1);
      const stop = end < 0 ? n : end + 1;
      code += "''";
      expanded += "''";
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && script[j] !== '"') j += script[j] === '\\' ? 2 : 1;
      code += '""';
      expanded += script.slice(i, Math.min(j + 1, n));
      i = j + 1;
    } else if (c === '#' && wordStart()) {
      while (i < n && script[i] !== '\n') i++;
    } else {
      code += c;
      expanded += c;
      i++;
    }
  }
  return { code, expanded };
}

/** Where a command starts: the start of a line, after ; & | ( ) { } !, or after a keyword that takes a command. */
const CMD = String.raw`(?:^|[;&|(){}!]|\b(?:then|do|else|elif|if|while|until|time))[ \t]*`;

/** Bash-only syntax that /bin/sh (dash on Debian, Ubuntu, Raspberry Pi OS) fails on or, worse, runs differently. */
const BASHISMS: { name: string; in: 'code' | 'expanded'; re: RegExp }[] = [
  // dash has no RANDOM: `$((RANDOM % 3))` is always 0 there.
  { name: '$RANDOM', in: 'expanded', re: /\$\{?RANDOM\b|\$\(\([^)]*\bRANDOM\b/ },
  { name: '[[ … ]]', in: 'code', re: new RegExp(`${CMD}\\[\\[[ \\t]`, 'm') },
  { name: 'function name', in: 'code', re: new RegExp(`${CMD}function[ \\t]+[A-Za-z_]`, 'm') },
  { name: 'source', in: 'code', re: new RegExp(`${CMD}source[ \\t]+\\S`, 'm') },
  { name: 'arrays (name=(…))', in: 'code', re: /(?:^|[\s;&|(){}])[A-Za-z_]\w*\+?=\(/m },
  { name: '${var,,} / ${var^^}', in: 'expanded', re: /\$\{[A-Za-z_]\w*(?:,,?|\^\^?)[^}]*\}/ },
  { name: '<<< (here-string)', in: 'code', re: /<<</ },
  { name: '{1..9} (brace ranges)', in: 'code', re: /\{-?(?:\d+|[A-Za-z])\.\.-?(?:\d+|[A-Za-z])(?:\.\.-?\d+)?\}/ },
  // dash reads `cmd &> f` as `cmd &` then `> f`: it runs in the background and f is emptied.
  { name: '&> (redirect both)', in: 'code', re: /&>/ },
];

/** The bash-only syntax in `script` (names, in BASHISMS order). */
export function bashisms(script: string): string[] {
  const views = shellViews(script);
  return BASHISMS.filter((b) => b.re.test(views[b.in])).map((b) => b.name);
}

/** A shell action whose shell is /bin/sh, as written or by default (not bash, zsh…). */
function runsUnderSh(b: Button): boolean {
  if (isWindows || b.action.type !== 'shell') return false;
  const shell = b.action.shell;
  return shell === undefined || ['sh', 'dash', 'ash'].includes(basename(shell));
}

/** Modifier keys: a browser keeps them for shortcuts (keydown with ctrlKey/altKey/metaKey), so on their own they never press a button. */
const MODIFIER_KEYS = new Set(['control', 'ctrl', 'alt', 'option', 'meta', 'cmd', 'command', 'os', 'super', 'win', 'altgraph', 'altgr']);

/** Problems a press would run into, per button, in config order; at most MAX_WARNINGS (+ a count). */
export function configWarnings(cfg: Config, baseDir: string, env: Record<string, string | undefined> = process.env): string[] {
  const out: string[] = [];
  const groups = new Map<string, number>();
  for (const pad of cfg.pads) for (const b of pad.buttons) if (b.group !== undefined) groups.set(b.group, (groups.get(b.group) ?? 0) + 1);
  for (const pad of cfg.pads)
    for (const b of pad.buttons) {
      const where = `pad "${pad.id}" › button "${b.id}"`;
      const problem = checkAction(b, baseDir, env);
      if (problem) out.push(`${where}: ${problem}`);
      if (runsUnderSh(b) && b.action.type === 'shell') {
        const found = bashisms(b.action.script);
        if (found.length)
          out.push(
            `${where}: the script uses bash syntax (${found.slice(0, 3).join(', ')}${found.length > 3 ? ', …' : ''}), but runs with ${b.action.shell ?? '/bin/sh'}, which is not bash on many systems (dash on Debian, Ubuntu, Raspberry Pi OS): add "shell": "bash"`,
          );
      }
      if (b.key !== undefined && MODIFIER_KEYS.has(b.key.trim().toLowerCase()))
        out.push(`${where}: key "${b.key}" never presses it: a modifier key on its own (Control, Alt, Meta/⌘, AltGr) is kept for shortcuts; pick another key`);
      for (const p of deadStops(b, pad.id, cfg)) out.push(`${where}: stops "${p}" matches no other button`);
      if (b.group !== undefined && groups.get(b.group) === 1) out.push(`${where}: group "${b.group}" has no other button: it stops nothing`);
    }
  return out.length > MAX_WARNINGS ? [...out.slice(0, MAX_WARNINGS - 1), `…and ${out.length - MAX_WARNINGS + 1} more`] : out;
}
