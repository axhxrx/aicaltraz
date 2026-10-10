/**
 * Demo-mode "runner": simulates an action by interpreting a tiny subset of sh (sleep, echo, printf,
 * exit, true, false, `;` `&&` `||`, `>&2`; `@progress`/`@status`/`@result`/`@state` lines are echoes). Anything else is a pretend command that takes a moment
 * and sometimes fails. So the demo config's scripts also work unchanged on a real host.
 */
import type { Action } from '../../core/config.ts';

type Stmt = { argv: string[]; stderr: boolean };
type Chain = { op: ';' | '&&' | '||'; stmt: Stmt }[];

export interface SimHooks {
  exact: boolean;
  line(text: string, stream: 'stdout' | 'stderr'): void;
  exit(code: number): void;
}

export interface SimHandle {
  kill(): void;
}

/** Split on ; && || and newlines (outside quotes), then tokenize each statement. */
export function parseShell(script: string): Chain {
  const chain: Chain = [];
  let op: ';' | '&&' | '||' = ';';
  let buf = '';
  let quote: string | null = null;
  const flush = (next: ';' | '&&' | '||') => {
    const stmt = tokenize(buf);
    if (stmt.argv.length) chain.push({ op, stmt });
    buf = '';
    op = next;
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (quote) {
      if (c === quote) quote = null;
      buf += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      buf += c;
    } else if (c === '#' && /(^|\s)$/.test(buf)) {
      while (i < script.length && script[i] !== '\n') i++;
      flush(';');
    } else if (c === ';' || c === '\n') flush(';');
    else if (script.startsWith('&&', i) || script.startsWith('||', i)) {
      flush(script.startsWith('&&', i) ? '&&' : '||');
      i++;
    } else buf += c;
  }
  flush(';');
  return chain;
}

function tokenize(s: string): Stmt {
  const argv: string[] = [];
  let stderr = false;
  const re = /'([^']*)'|"((?:\\.|[^"\\])*)"|(\S+)/g;
  for (const m of s.matchAll(re)) {
    const tok = m[1] ?? m[2]?.replace(/\\(.)/g, '$1') ?? m[3]!;
    if (m[3] && /^(1?>&2|2>&1)$/.test(m[3])) {
      stderr ||= m[3] !== '2>&1';
      continue;
    }
    argv.push(tok);
  }
  return { argv, stderr };
}

function actionChain(a: Action): Chain {
  if (a.type === 'none') return [];
  if (a.type === 'shell') return parseShell(a.script);
  const name = a.command.split(/[\\/]/).pop() ?? a.command;
  return [{ op: ';', stmt: { argv: [name, ...a.args], stderr: false } }];
}

const FAILS: Record<string, string> = {
  curl: 'curl: (7) Failed to connect: Connection refused',
  ssh: 'ssh: connect to host port 22: No route to host',
  ping: 'ping: Destination Host Unreachable',
};

export function simulate(action: Action, hooks: SimHooks): SimHandle {
  const chain = actionChain(action);
  let killed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = (ms: number) => new Promise<void>((r) => (timer = setTimeout(r, ms)));
  const jitter = (ms: number) => (hooks.exact ? ms : ms * (0.75 + Math.random() * 0.6));

  void (async () => {
    let status = 0;
    for (const { op, stmt } of chain) {
      if (killed) return;
      if ((op === '&&' && status !== 0) || (op === '||' && status === 0)) continue;
      const [cmd = '', ...args] = stmt.argv;
      const out = (t: string) => hooks.line(t, stmt.stderr ? 'stderr' : 'stdout');
      switch (cmd) {
        case 'sleep':
          await wait(jitter(Math.max(0, parseFloat(args[0] ?? '1') || 0) * 1000));
          status = 0;
          break;
        case 'echo':
          out(args.filter((a) => !/^-[neE]+$/.test(a)).join(' '));
          status = 0;
          break;
        case 'printf':
          for (const l of (args[0] ?? '').replace(/%s/g, () => args.splice(1, 1)[0] ?? '').split(/\\n|\n/)) if (l) out(l);
          status = 0;
          break;
        case 'exit':
          if (!killed) hooks.exit(parseInt(args[0] ?? String(status), 10) || 0);
          return;
        case 'true':
        case ':':
          status = 0;
          break;
        case 'false':
          status = 1;
          break;
        default: {
          // A pretend external command.
          await wait(hooks.exact ? 300 : 400 + Math.random() * 1000);
          const fail = !hooks.exact && Math.random() < 0.3;
          if (fail) hooks.line(FAILS[cmd] ?? `${cmd}: device not responding`, 'stderr');
          status = fail ? 1 : 0;
        }
      }
    }
    if (!killed) hooks.exit(status);
  })();

  return {
    kill() {
      killed = true;
      clearTimeout(timer);
    },
  };
}
