import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Action } from '../src/core/config.ts';
import {
  clip,
  parseDirective,
  pickResultText,
  RESULT_MAX,
  resolveCwd,
  shellArgv,
  startRun,
  stripAnsi,
  Tail,
  TAIL_BYTES,
  type RunSpec,
  type RunUpdate,
} from '../src/server/runner.ts';
import { cleanupTmp, isAlive, tmpDir, waitFor, writeExecutable } from './helpers.ts';

afterAll(cleanupTmp);

const base = tmpDir('buttpad-runner-');
const sh = (script: string, extra: Partial<Extract<Action, { type: 'shell' }>> = {}): Action => ({ type: 'shell', script, shell: '/bin/sh', ...extra });
const exec = (command: string, args: string[] = [], extra: Partial<Extract<Action, { type: 'exec' }>> = {}): Action => ({ type: 'exec', command, args, ...extra });

async function run(action: Action, spec: Partial<RunSpec> = {}) {
  const updates: RunUpdate[] = [];
  const h = startRun({ action, baseDir: base, timeoutMs: 10_000, ...spec }, { onUpdate: (u) => updates.push(u) });
  const outcome = await h.done;
  return { ...outcome, updates, handle: h };
}

describe('pure helpers', () => {
  test('parseDirective', () => {
    expect(parseDirective('hello')).toBeNull();
    expect(parseDirective('@progress 42')).toEqual({ kind: 'progress', value: 42 });
    expect(parseDirective('@progress 12.5%')).toEqual({ kind: 'progress', value: 12.5 });
    expect(parseDirective('@progress soon')).toBeUndefined();
    expect(parseDirective('@status  copying files ')).toEqual({ kind: 'status', text: 'copying files' });
    expect(parseDirective('@status')).toEqual({ kind: 'status', text: '' });
    expect(parseDirective('@result Key light ON 80%')).toEqual({ kind: 'result', text: 'Key light ON 80%' });
    expect(parseDirective('@resulting')).toBeUndefined();
    expect(parseDirective('@foo bar')).toBeUndefined();
    expect(parseDirective(' @status indented')).toBeNull();
  });

  test('pickResultText precedence', () => {
    expect(pickResultText({ result: 'r', lastOut: 'o', lastErr: 'e', failed: true })).toBe('r');
    expect(pickResultText({ lastOut: 'o', lastErr: 'e', failed: true })).toBe('o');
    expect(pickResultText({ lastErr: 'e', failed: true })).toBe('e');
    expect(pickResultText({ lastErr: 'e', failed: false })).toBeUndefined();
    expect(pickResultText({ result: '', lastOut: 'o', failed: false })).toBeUndefined();
    expect(pickResultText({ failed: true })).toBeUndefined();
  });

  test('clip caps at RESULT_MAX code points with an ellipsis', () => {
    expect(clip('  short  ')).toBe('short');
    const long = clip('x'.repeat(500));
    expect(long.length).toBe(RESULT_MAX);
    expect(long).toEndWith('…');
    const emoji = clip('😀'.repeat(300));
    expect(Array.from(emoji).length).toBe(RESULT_MAX);
    expect(clip('😀'.repeat(RESULT_MAX))).toBe('😀'.repeat(RESULT_MAX));
  });

  test('stripAnsi', () => {
    expect(stripAnsi('\x1b[1;32mOK\x1b[0m done \x1b]0;title\x07')).toBe('OK done ');
  });

  test('Tail keeps the last bytes and never starts mid-character', () => {
    const t = new Tail(10);
    t.push(new TextEncoder().encode('0123456789abc'));
    expect(t.text()).toBe('3456789abc');
    t.push(new TextEncoder().encode('é'));
    expect(t.text()).toBe('56789abcé');
    const u = new Tail(5);
    for (const ch of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) u.push(new TextEncoder().encode(ch));
    expect(u.text()).toBe('cdefg');
    const v = new Tail(3);
    v.push(new TextEncoder().encode('xéé')); // 5 bytes; the last 3 start with a continuation byte, which is dropped
    expect(v.text()).toBe('é');
  });

  test('shellArgv per platform', () => {
    // Never $SHELL: a script must behave the same from a terminal and under a service.
    expect(shellArgv('echo hi', undefined, 'linux', { SHELL: '/bin/zsh' })).toEqual({ argv: ['/bin/sh', '-c', 'echo hi'], verbatim: false });
    expect(shellArgv('echo hi', undefined, 'darwin', {})).toEqual({ argv: ['/bin/sh', '-c', 'echo hi'], verbatim: false });
    expect(shellArgv('echo hi', '/bin/bash', 'linux', { SHELL: '/bin/zsh' }).argv[0]).toBe('/bin/bash');
    expect(shellArgv('echo hi', undefined, 'win32', {})).toEqual({ argv: ['cmd.exe', '/d', '/s', '/c', '"echo hi"'], verbatim: true });
    expect(shellArgv('dir', undefined, 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }).argv[0]).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(shellArgv('Get-Date', 'powershell.exe', 'win32', {}).argv).toEqual(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'Get-Date']);
    expect(shellArgv('ls', 'C:\\Git\\bin\\bash.exe', 'win32', {}).argv).toEqual(['C:\\Git\\bin\\bash.exe', '-c', 'ls']);
  });

  test('resolveCwd', () => {
    expect(resolveCwd('/cfg')).toBe('/cfg');
    expect(resolveCwd('/cfg', 'sub/dir')).toBe('/cfg/sub/dir');
    expect(resolveCwd('/cfg', '../x')).toBe('/x');
    expect(resolveCwd('/cfg', '/abs')).toBe('/abs');
    expect(resolveCwd('/cfg', '~')).toBe(homedir());
    expect(resolveCwd('/cfg', '~/x')).toBe(join(homedir(), 'x'));
  });
});

describe('exec vs shell', () => {
  test('exec passes args verbatim, no shell', async () => {
    const o = await run(exec('printf', ['%s|', '$HOME', 'a b', '*', '; rm -rf /']));
    expect(o.exitCode).toBe(0);
    expect(o.stdout).toBe('$HOME|a b|*|; rm -rf /|');
    expect(o.text).toBe('$HOME|a b|*|; rm -rf /|');
  });

  test('shell interprets the script', async () => {
    const o = await run(sh('x=$((20 + 22)); echo "answer $x" | tr a-z A-Z'));
    expect(o).toMatchObject({ exitCode: 0, text: 'ANSWER 42' });
  });

  test('custom shell', async () => {
    const o = await run(sh('[[ 1 == 1 ]] && echo "bash: $BASH_VERSION" | cut -c1-5', { shell: 'bash' }));
    expect(o).toMatchObject({ exitCode: 0, text: 'bash:' });
  });

  test('default shell is /bin/sh, whatever $SHELL says', async () => {
    const saved = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    try {
      const o = await run({ type: 'shell', script: 'echo "$0"' });
      expect(o.text).toBe('/bin/sh');
      expect(o.handle.command).toBe(`/bin/sh -c 'echo "$0"'`);
    } finally {
      if (saved === undefined) delete process.env.SHELL;
      else process.env.SHELL = saved;
    }
  });

  test('exit codes and signals', async () => {
    expect(await run(sh('exit 7'))).toMatchObject({ exitCode: 7, signal: null, reason: undefined });
    expect(await run(sh('kill -9 $$'))).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
  });

  test('stdin is not connected', async () => {
    const o = await run(sh('if read -r line; then echo "got $line"; else echo eof; fi'));
    expect(o.text).toBe('eof');
  });
});

describe('output protocol', () => {
  test('@progress/@status become updates; @result wins', async () => {
    // Lines that should coalesce into one update are written at once: separate writes may be read apart.
    const o = await run(sh("printf '@status starting\\n@progress 10\\n'; sleep 0.2; printf '@progress 60\\n@status nearly\\nplain line\\n@result all good\\nafter\\n'"));
    expect(o.exitCode).toBe(0);
    expect(o.text).toBe('all good');
    expect(o.updates[0]).toEqual({ status: 'starting', progress: 10 });
    expect(o.updates.at(-1)).toEqual({ progress: 60, status: 'nearly' });
    expect(o.stdout).toContain('@progress 60\n');
  });

  test('the last @result wins; an empty @result means no text', async () => {
    expect((await run(sh('echo "@result one"; echo "@result two"'))).text).toBe('two');
    expect((await run(sh('echo "@result"; echo trailing'))).text).toBeUndefined();
  });

  test('without @result: last non-empty, non-@ stdout line', async () => {
    const o = await run(sh('echo first; echo "  second  "; echo; echo "@status ignored"; echo "@weird"; printf "\\n\\n"'));
    expect(o.text).toBe('second');
  });

  test('failure with no stdout uses the last stderr line; success does not', async () => {
    expect(await run(sh('echo "@status x"; echo "warning: one" >&2; echo "error: two" >&2; echo >&2; exit 1'))).toMatchObject({ exitCode: 1, text: 'error: two' });
    expect(await run(sh('echo out; echo err >&2; exit 1'))).toMatchObject({ text: 'out' });
    expect((await run(sh('echo noise >&2'))).text).toBeUndefined();
  });

  test('result text is truncated to 200 chars and ANSI-stripped', async () => {
    const o = await run(sh(`printf '\\033[31m%s\\033[0m\\n' "$(printf 'y%.0s' $(seq 1 300))"`));
    expect(o.text!.length).toBe(200);
    expect(o.text).toStartWith('yyy');
    expect(o.text).toEndWith('…');
  });

  test('carriage-return progress output and CRLF', async () => {
    const o = await run(sh("printf '10%%\\r50%%\\r100%%\\r\\n@progress 30\\r\\n'"));
    expect(o.text).toBe('100%');
    expect(o.updates.at(-1)).toEqual({ progress: 30 });
  });

  test('a last line without newline still counts', async () => {
    expect((await run(sh("printf 'no newline'"))).text).toBe('no newline');
  });

  test('a last line without newline counts even while a background process holds the pipe open', async () => {
    const o = await run(sh("sleep 2 & printf '@result photo 0042 saved'"));
    o.handle.forceKill();
    expect(o).toMatchObject({ exitCode: 0, text: 'photo 0042 saved' });
  });

  test('protocol lines are UTF-8, split across chunks', async () => {
    const o = await run(sh("printf '@result Gr\\303'; sleep 0.1; printf '\\274\\303\\237e\\n'"));
    expect(o.text).toBe('Grüße');
  });

  test('progress updates are coalesced', async () => {
    const o = await run(sh('i=0; while [ $i -le 500 ]; do echo "@progress $((i / 5))"; i=$((i + 1)); done'));
    expect(o.updates.length).toBeLessThan(50);
    expect(o.updates.at(-1)).toEqual({ progress: 100 });
  });

  test('throttling and durations use a monotonic clock: a wall-clock step back changes nothing', async () => {
    const realNow = Date.now;
    const updates: number[] = [];
    const t0 = performance.now();
    const h = startRun(
      { action: sh('i=1; while [ $i -le 12 ]; do echo "@progress $((i * 8))"; sleep 0.1; i=$((i + 1)); done'), baseDir: base, timeoutMs: 10_000 },
      { onUpdate: () => updates.push(performance.now() - t0) },
    );
    await waitFor(() => updates.length >= 2, 3000, 'first updates');
    const stepAt = performance.now() - t0;
    Date.now = () => realNow() - 30_000; // NTP steps the clock back mid-run
    let o;
    try {
      o = await h.done;
    } finally {
      Date.now = realNow;
    }
    // Without a monotonic clock: none until the final flush.
    expect(updates.filter((t) => t > stepAt).length).toBeGreaterThan(3);
    expect(o.durationMs).toBeGreaterThan(0);
    expect(o.durationMs).toBeLessThan(performance.now() - t0 + 1);
  });
});

describe('a firehose of output', () => {
  for (const script of ['yes', 'yes >&2'])
    test(`(${script}) does not starve the event loop, and its timeout fires on time`, async () => {
      let last = performance.now();
      let maxLag = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxLag = Math.max(maxLag, now - last - 20);
        last = now;
      }, 20);
      try {
        const o = await run(sh(script), { timeoutMs: 800 });
        expect(o.reason).toBe('timeout');
        // Without yielding to the event loop: lags of seconds, and the timeout fires seconds late.
        expect(o.durationMs).toBeLessThan(800 + 700);
        expect(maxLag).toBeLessThan(500);
      } finally {
        clearInterval(timer);
      }
    });
});

describe('tails', () => {
  test(`stdout and stderr tails are capped at ${TAIL_BYTES} bytes`, async () => {
    const o = await run(sh("head -c 100000 /dev/zero | tr '\\0' a; echo END; head -c 50000 /dev/zero | tr '\\0' b >&2; echo ERR >&2; echo '@result big'"));
    expect(o.stdout.length).toBe(TAIL_BYTES);
    expect(o.stdout).toEndWith('aaaEND\n@result big\n');
    expect(o.stderr.length).toBe(TAIL_BYTES);
    expect(o.stderr).toEndWith('bbbERR\n');
    expect(o.text).toBe('big');
  });

  test('live tails are readable while running', async () => {
    const h = startRun({ action: sh('echo early; echo oops >&2; sleep 0.5'), baseDir: base, timeoutMs: 5000 });
    await waitFor(() => h.stdout().includes('early') && h.stderr().includes('oops'), 2000, 'live output');
    await h.done;
  });

  test('huge lines without newlines stay bounded', async () => {
    const o = await run(sh("head -c 300000 /dev/zero | tr '\\0' z; echo; echo done"));
    expect(o.text).toBe('done');
    expect(o.stdout.length).toBe(TAIL_BYTES);
  });
});

describe('timeout, kill and process groups', () => {
  test('timeout kills the run and its grandchildren → reason "timeout"', async () => {
    const t0 = Date.now();
    const o = await run(sh('sleep 30 & echo "@status child $!"; sleep 30'), { timeoutMs: 300 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(o.reason).toBe('timeout');
    expect(o.exitCode).toBeNull();
    expect(o.signal).toBe('SIGTERM');
    const child = Number(/child (\d+)/.exec(o.stdout)![1]);
    await waitFor(() => !isAlive(child), 1000, `grandchild ${child} to die`);
  });

  test('a grandchild that ignores SIGTERM is SIGKILLed after the grace period', async () => {
    const t0 = Date.now();
    const o = await run(sh(`sh -c 'trap "" TERM; echo "@status stubborn $$"; exec sleep 30 >/dev/null 2>&1' & sleep 30`), { timeoutMs: 300, killGraceMs: 1500 });
    expect(o.reason).toBe('timeout');
    const stubborn = Number(/stubborn (\d+)/.exec(o.stdout)![1]);
    if (Date.now() - t0 < 1400) {
      expect(isAlive(stubborn)).toBe(true); // SIGTERM alone didn't do it
      expect(o.handle.dying()).toBe(true);
    }
    await waitFor(() => !isAlive(stubborn), 3000, 'stubborn grandchild to be SIGKILLed');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1500);
    expect(o.handle.dying()).toBe(false);
  });

  test('once a killed group is seen gone, it is never signalled again (its pid may be recycled)', async () => {
    const h = startRun({ action: sh('sleep 30'), baseDir: base, timeoutMs: 10_000, killGraceMs: 5000 });
    expect(h.dying()).toBe(false);
    expect(h.kill()).toBe(true);
    expect(h.dying()).toBe(true);
    await h.done;
    await waitFor(() => !h.dying(), 1000, 'the empty group to be noticed'); // long before the 5 s grace
    const realKill = process.kill;
    const calls: unknown[] = [];
    process.kill = ((...args: Parameters<typeof process.kill>) => (calls.push(args), realKill(...args))) as typeof process.kill;
    try {
      expect(h.alive()).toBe(false);
      expect(h.kill()).toBe(false);
      h.forceKill();
    } finally {
      process.kill = realKill;
    }
    expect(calls).toEqual([]);
  });

  test('a killed group counts as gone once only zombies are left (some inits are slow to reap orphans)', async () => {
    const h = startRun({ action: sh('sleep 30 & echo "@status child $!"; wait'), baseDir: base, timeoutMs: 10_000, killGraceMs: 5000 });
    await waitFor(() => /child \d+/.test(h.stdout()), 2000, 'child pid');
    expect(h.kill()).toBe(true);
    await h.done;
    await waitFor(() => !h.dying(), 500, 'the group to count as gone');
    expect(h.alive()).toBe(false);
  });

  test.skipIf(!Bun.which('setsid'))('kill() reports whether there was anything left to signal', async () => {
    // The shell exits at once; the setsid'd sleep (another process group) keeps stdout open meanwhile.
    const h = startRun({ action: sh('setsid sleep 1 & echo "@result photo taken"'), baseDir: base, timeoutMs: 5000 });
    await waitFor(() => !h.alive(), 2000, 'the shell to exit');
    expect(h.kill()).toBe(false);
    expect(h.dying()).toBe(false);
    expect(await h.done).toMatchObject({ exitCode: 0, signal: null, text: 'photo taken' });
  });

  test('huge timeouts mean "practically never", not "immediately" (timer overflow)', async () => {
    expect(await run(sh('sleep 0.2; echo ok'), { timeoutMs: 1e12 })).toMatchObject({ exitCode: 0, reason: undefined, text: 'ok' });
  });

  test('a run that traps SIGTERM and exits 0 still counts as timed out', async () => {
    const o = await run(sh('trap "echo cleaned up; exit 0" TERM; sleep 30 & wait'), { timeoutMs: 200 });
    expect(o).toMatchObject({ reason: 'timeout', exitCode: 0, text: 'cleaned up' });
  });

  test('kill() terminates the whole tree (cancel)', async () => {
    const h = startRun({ action: sh('sleep 30 & echo "@status child $!"; wait'), baseDir: base, timeoutMs: 10_000 });
    await waitFor(() => /child \d+/.test(h.stdout()), 2000, 'child pid');
    const child = Number(/child (\d+)/.exec(h.stdout())![1]);
    expect(h.alive()).toBe(true);
    expect(h.kill()).toBe(true);
    expect(h.kill()).toBe(true); // idempotent: already on its way down
    const o = await h.done;
    expect(o).toMatchObject({ exitCode: null, signal: 'SIGTERM', reason: undefined });
    await waitFor(() => !isAlive(child) && !isAlive(h.pid!), 1000, 'tree to die');
  });

  test('forceKill() SIGKILLs immediately', async () => {
    const h = startRun({ action: sh('trap "" TERM; sleep 30'), baseDir: base, timeoutMs: 10_000 });
    await Bun.sleep(100);
    h.forceKill();
    expect((await h.done).signal).toBe('SIGKILL');
  });

  test("doesn't wait for background processes holding the pipes", async () => {
    const t0 = Date.now();
    const o = await run(sh('echo "@status bg $(sh -c \'sleep 5 >/dev/null 2>&1 & echo $!\')"; (sleep 3; echo late) & echo "@result done"'));
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(o).toMatchObject({ exitCode: 0, text: 'done' });
    // Clean up what the script left behind.
    o.handle.forceKill();
  });
});

describe('spawn errors', () => {
  test('unknown command → reason "spawn", reported asynchronously', async () => {
    let called = false;
    const h = startRun({ action: exec('buttpad-no-such-command-xyz'), baseDir: base, timeoutMs: 1000 }, { onExit: () => (called = true) });
    expect(called).toBe(false);
    expect(h.pid).toBeUndefined();
    expect(h.alive()).toBe(false);
    const o = await h.done;
    expect(called).toBe(true);
    expect(o).toMatchObject({ exitCode: null, reason: 'spawn', text: 'command not found: buttpad-no-such-command-xyz' });
  });

  // Every client sees the text (no host paths: base names); the admin run log gets `error` in full.
  test('missing path, non-executable file, bad interpreter, missing shell, missing cwd', async () => {
    expect(await run(exec('./nope.sh'))).toMatchObject({ text: 'command not found: nope.sh', error: `command not found: ${join(base, 'nope.sh')}` });
    writeFileSync(join(base, 'plain.txt'), 'echo hi\n');
    expect(await run(exec('./plain.txt'))).toMatchObject({ text: 'permission denied (chmod +x?): plain.txt', error: `permission denied (chmod +x?): ${join(base, 'plain.txt')}` });
    writeExecutable(join(base, 'badshebang.sh'), '#!/no/such/interpreter\necho hi\n');
    expect(await run(exec('./badshebang.sh'))).toMatchObject({
      text: 'interpreter not found (check the #! line): badshebang.sh',
      error: `interpreter not found (check the #! line): ${join(base, 'badshebang.sh')}`,
    });
    expect(await run(sh('true', { shell: '/no/such/shell' }))).toMatchObject({ text: 'shell not found: shell', error: 'shell not found: /no/such/shell' });
    expect(await run(sh('true', { cwd: 'missing-dir' }))).toMatchObject({ reason: 'spawn', text: 'cwd not found: missing-dir', error: `cwd not found: ${join(base, 'missing-dir')}` });
  });

  test('a script without #!, a directory', async () => {
    writeExecutable(join(base, 'noshebang.sh'), 'echo hi\n');
    expect(await run(exec('./noshebang.sh'))).toMatchObject({
      reason: 'spawn',
      text: 'not executable as a program (missing #! line?): noshebang.sh',
      error: `not executable as a program (missing #! line?): ${join(base, 'noshebang.sh')}`,
    });
    mkdirSync(join(base, 'adir'), { recursive: true });
    expect(await run(exec('./adir'))).toMatchObject({ text: 'is a directory: adir', error: `is a directory: ${join(base, 'adir')}` });
    expect((await run(sh('true', { shell: base }))).error).toBe(`is a directory: ${base}`);
  });
});

describe('cwd and env', () => {
  const dir = join(base, 'cwdtest');
  mkdirSync(join(dir, 'sub', 'bin'), { recursive: true });
  writeExecutable(join(dir, 'sub', 'bin', 'where.sh'), '#!/bin/sh\npwd -P\n');

  test('default cwd is the config dir; relative cwd resolves against it; absolute is kept', async () => {
    expect((await run(sh('pwd -P'), { baseDir: dir })).text).toBe(dir);
    expect((await run(sh('pwd -P', { cwd: 'sub' }), { baseDir: dir })).text).toBe(join(dir, 'sub'));
    expect((await run(sh('pwd -P', { cwd: '/' }), { baseDir: dir })).text).toBe('/');
  });

  test('relative exec commands resolve against the cwd', async () => {
    expect((await run(exec('./bin/where.sh', [], { cwd: 'sub' }), { baseDir: dir })).text).toBe(join(dir, 'sub'));
    expect((await run(exec('sub/bin/where.sh'), { baseDir: dir })).text).toBe(dir);
  });

  test('host env + action env + BUTTPAD_* (in that precedence)', async () => {
    process.env.BUTTPAD_TEST_HOST_VAR = 'from-host';
    process.env.BUTTPAD_TEST_OVERRIDE = 'host';
    try {
      const o = await run(sh('echo "$BUTTPAD_TEST_HOST_VAR|$BUTTPAD_TEST_OVERRIDE|$BUTTPAD_PAD|$BUTTPAD_BUTTON|$BUTTPAD_RUN_ID|$BUTTPAD_LABEL"', {
        env: { BUTTPAD_TEST_OVERRIDE: 'action', BUTTPAD_PAD: 'spoofed' },
      }), { env: { BUTTPAD_PAD: 'lights', BUTTPAD_BUTTON: 'key', BUTTPAD_RUN_ID: '7', BUTTPAD_LABEL: 'Key 80%' } });
      expect(o.text).toBe('from-host|action|lights|key|7|Key 80%');
    } finally {
      delete process.env.BUTTPAD_TEST_HOST_VAR;
      delete process.env.BUTTPAD_TEST_OVERRIDE;
    }
  });

  test('exec looks bare commands up in the action PATH', async () => {
    writeExecutable(join(dir, 'tools', 'mytool'), '#!/bin/sh\necho "mytool ran"\n');
    const o = await run(exec('mytool', [], { env: { PATH: `${join(dir, 'tools')}:/usr/bin:/bin` } }), { baseDir: dir });
    expect(o.text).toBe('mytool ran');
  });
});
