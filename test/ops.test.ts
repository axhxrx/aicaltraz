/** Edit-mode draft helpers (src/web/edit/ops.ts): action conversion, new ids, duplicates. */
import { describe, expect, test } from 'bun:test';
import { Config, type Action, type Button } from '../src/core/config.ts';
import { convertAction, copyOf, newButton, newPad, renamePattern, shQuote, simpleWords, stateLookalike, STARTER_SCRIPT, stopTargets } from '../src/web/edit/ops.ts';

const sh = (script: string, more: Partial<Extract<Action, { type: 'shell' }>> = {}): Action => ({ type: 'shell', script, ...more });
const exec = (command: string, args: string[] = [], more: Partial<Extract<Action, { type: 'exec' }>> = {}): Action => ({ type: 'exec', command, args, ...more });

/** stdout of an argv, run directly (no shell), and of a script run by /bin/sh. */
const runArgv = (argv: string[]) => Bun.spawnSync(argv, { env: { ...process.env, HOME: '/home/someone' } }).stdout.toString();
const runSh = (script: string) => Bun.spawnSync(['/bin/sh', '-c', script], { env: { ...process.env, HOME: '/home/someone' } }).stdout.toString();

describe('shell → program', () => {
  test('a plain word list becomes argv', () => {
    expect(convertAction(sh('echo hello world'), 'exec')).toEqual(exec('echo', ['hello', 'world']));
    expect(convertAction(sh('  ls   -la\t/tmp '), 'exec')).toEqual(exec('ls', ['-la', '/tmp']));
    expect(convertAction(sh('dd if=/dev/zero count=1'), 'exec')).toEqual(exec('dd', ['if=/dev/zero', 'count=1']));
    expect(convertAction(sh('./scripts/light.sh --level 80'), 'exec')).toEqual(exec('./scripts/light.sh', ['--level', '80']));
  });

  test('anything a shell would interpret stays a script, run by sh -c', () => {
    for (const script of [
      'ls -d ~', // tilde expansion
      'cat ~/notes.txt',
      'LC_ALL=C date', // an environment assignment, not a program called "LC_ALL=C"
      'FOO=1',
      'echo *', // globs
      'ls a?c',
      'echo [ab]',
      "echo 'hello world'", // quotes
      'echo "x"',
      'echo $HOME', // expansions
      'echo `date`',
      'echo a\\ b',
      'echo a; echo b', // syntax
      'echo a && echo b',
      'echo a | wc -c',
      'echo a > /tmp/x',
      'sleep 1 &',
      'echo a # comment',
      'echo {a,b}',
      '(echo a)',
      'echo a\necho b',
      'cd /tmp', // shell builtins and keywords
      'export A=1',
      'time make',
      'exec sleep 1',
      'echo =ls', // zsh: =cmd expands to its path
      'echo café', // not plainly ASCII: left alone
    ]) {
      expect(simpleWords(script)).toBeNull();
      expect(convertAction(sh(script), 'exec')).toEqual(exec('/bin/sh', ['-c', script]));
    }
    expect(convertAction(sh('echo a; echo b', { shell: '/bin/bash' }), 'exec')).toEqual(exec('/bin/bash', ['-c', 'echo a; echo b']));
  });

  test('a converted simple command does what the script did', () => {
    for (const script of ['echo hello world', 'printf %s,%s a b', 'echo a=b c:d e@f 50% +x -y']) {
      const words = simpleWords(script)!;
      expect(words).not.toBeNull();
      expect(runArgv(words)).toBe(runSh(script));
    }
  });

  test('cwd and env come along; a script with a shell keeps it for sh -c', () => {
    expect(convertAction(sh('make', { cwd: 'proj', env: { A: '1' }, shell: '/bin/zsh' }), 'exec')).toEqual(exec('make', [], { cwd: 'proj', env: { A: '1' } }));
  });
});

describe('program → shell', () => {
  test('a properly quoted command line: it runs the same argv', () => {
    const cases: [string, string[]][] = [
      ['printf', ['[%s]\\n', 'a b', "it's", '~', '~/x', 'x=y', '=ls', '$HOME', '*', '', 'a;b', '`date`', 'back\\slash', 'line\nbreak', 'é']],
      ['printf', ['[%s]\\n', 'plain', '--flag', 'k=v', 'a,b', '50%']],
    ];
    for (const [cmd, args] of cases) {
      const a = convertAction(exec(cmd, args), 'shell') as Extract<Action, { type: 'shell' }>;
      expect(runSh(a.script)).toBe(runArgv([cmd, ...args]));
    }
    expect(convertAction(exec('echo', ['hello', 'world']), 'shell')).toEqual(sh('echo hello world'));
    expect(convertAction(exec('echo', ['~', 'a b', "it's", 'k=v', '']), 'shell')).toEqual(sh(`echo '~' 'a b' 'it'\\''s' k=v ''`));
  });

  test('a command word that would be an assignment or a keyword is quoted', () => {
    expect(shQuote('A=1', true)).toBe("'A=1'");
    expect(shQuote('A=1')).toBe('A=1');
    expect(shQuote('time', true)).toBe("'time'");
    expect(shQuote('time')).toBe('time');
    expect(convertAction(exec('./my tool', ['x']), 'shell')).toEqual(sh("'./my tool' x"));
  });

  test('sh -c SCRIPT unwraps to that script, run by that shell', () => {
    expect(convertAction(exec('/bin/sh', ['-c', 'echo a; echo b']), 'shell')).toEqual(sh('echo a; echo b', { shell: '/bin/sh' }));
    expect(convertAction(exec('bash', ['-c', 'ls -d ~'], { cwd: '/tmp' }), 'shell')).toEqual(sh('ls -d ~', { shell: 'bash', cwd: '/tmp' }));
    // Not a plain -c: left as a command line.
    expect(convertAction(exec('/bin/sh', ['-c', 'echo $0', 'name']), 'shell')).toEqual(sh("/bin/sh -c 'echo $0' name"));
    expect(convertAction(exec('/bin/sh', ['./x.sh']), 'shell')).toEqual(sh('/bin/sh ./x.sh'));
    expect(convertAction(exec('/usr/bin/python3', ['-c', 'print(1)']), 'shell')).toEqual(sh("/usr/bin/python3 -c 'print(1)'"));
  });

  test('round trips keep the behavior', () => {
    for (const script of ['ls -d ~', 'LC_ALL=C date', 'echo a; echo b', "echo 'x y'"]) {
      const back = convertAction(convertAction(sh(script), 'exec'), 'shell') as Extract<Action, { type: 'shell' }>;
      expect(back.script).toBe(script);
      expect(back.shell).toBe('/bin/sh');
    }
    expect(convertAction(convertAction(sh('echo hi there'), 'exec'), 'shell')).toEqual(sh('echo hi there'));
  });
});

describe('new ids and copies', () => {
  const cfg = Config.parse({
    version: 1,
    pads: [{ id: 'main', name: 'Main', cols: 3, rows: 2, buttons: [{ id: 'button-1', x: 0, y: 0, action: sh('true') }] }],
  });
  const pad = cfg.pads[0]!;

  test('a new button stays clear of ids the host still has (e.g. one deleted in the draft)', () => {
    expect(newButton(pad, 1, 0).id).toBe('button-2');
    expect(newButton(pad, 1, 0, ['button-2', 'button-3']).id).toBe('button-4');
    expect(newPad(cfg).id).toBe('pad-2');
    expect(newPad(cfg, ['pad-2']).id).toBe('pad-3');
  });

  test('a copy has a new id and spot but no key binding', () => {
    const b: Button = { ...pad.buttons[0]!, label: 'Lamp', key: 'l' };
    const c = copyOf(b, { x: 2, y: 1, w: 1, h: 1 }, 'lamp-copy');
    expect(c).toMatchObject({ id: 'lamp-copy', label: 'Lamp copy', x: 2, y: 1 });
    expect(c).not.toHaveProperty('key');
    expect(c.action).not.toBe(b.action);
    expect(b.key).toBe('l');
  });
});

describe('new buttons and the none action', () => {
  const pad = Config.parse({ version: 1, pads: [{ id: 'main', name: 'Main', buttons: [] }] }).pads[0]!;

  test("a new button's action fails, saying it isn't set up (no ✓ for nothing)", () => {
    expect(newButton(pad, 0, 0).action).toEqual(sh(STARTER_SCRIPT));
    const out = Bun.spawnSync(['/bin/sh', '-c', STARTER_SCRIPT]);
    expect(out.exitCode).toBe(1);
    expect(out.stderr.toString().trim()).toBe('No action set — edit this button');
  });

  test('switching a placeholder (or nothing) starts the other type blank: no sample `sh -c` args', () => {
    const blankExec = exec('');
    expect(convertAction(sh(STARTER_SCRIPT), 'exec')).toEqual(blankExec);
    expect(convertAction(sh("echo '@status working'; sleep 1; echo 'Done'"), 'exec')).toEqual(blankExec);
    expect(convertAction({ type: 'none' }, 'exec')).toEqual(blankExec);
    expect(convertAction({ type: 'none' }, 'shell')).toEqual({ type: 'shell', script: '' });
    // Set up in any way (a folder, a shell, a changed script): it means something, and is kept.
    expect(convertAction(sh(STARTER_SCRIPT, { cwd: '/x' }), 'exec')).toEqual(exec('/bin/sh', ['-c', STARTER_SCRIPT], { cwd: '/x' }));
    expect(convertAction(sh(`${STARTER_SCRIPT} `), 'exec')).toEqual(exec('/bin/sh', ['-c', `${STARTER_SCRIPT} `]));
  });

  test('to none: nothing is kept', () => {
    expect(convertAction(sh('echo hi', { cwd: '/tmp', env: { A: '1' } }), 'none')).toEqual({ type: 'none' });
    expect(convertAction(exec('ls'), 'none')).toEqual({ type: 'none' });
  });
});

describe('stop patterns', () => {
  test('renames carry them along; deletes drop them', () => {
    expect(renamePattern('main/lamp', 'main/lamp', 'main/desk-lamp')).toBe('main/desk-lamp');
    expect(renamePattern('main/lamp2', 'main/lamp', 'main/x')).toBe('main/lamp2');
    expect(renamePattern('main/*', 'main/lamp', 'main/x')).toBe('main/*');
    expect(renamePattern('main/lamp', 'main/lamp', null)).toBeNull();
    // A pad: its `pad/…` patterns.
    expect(renamePattern('main/lamp', 'main', 'studio')).toBe('studio/lamp');
    expect(renamePattern('main/*', 'main', 'studio')).toBe('studio/*');
    expect(renamePattern('mainx/*', 'main', 'studio')).toBe('mainx/*');
    expect(renamePattern('*', 'main', 'studio')).toBe('*');
    expect(renamePattern('main/*', 'main', null)).toBeNull();
    expect(renamePattern('*', 'main', null)).toBe('*');
  });

  test('what a pattern names (itself left out), or null for nothing', () => {
    const cfg = Config.parse({
      version: 1,
      pads: [
        { id: 'a', name: 'A', buttons: [{ id: 'x', x: 0, y: 0, action: { type: 'none' } }, { id: 'y', x: 1, y: 0, action: { type: 'none' } }] },
        { id: 'b', name: 'B', buttons: [] },
      ],
    });
    const ids = (p: string, self?: { pad: string; button: string }) => stopTargets(cfg, p, self)?.map((t) => `${t.pad.id}/${t.button.id}`) ?? null;
    expect(ids('*', { pad: 'a', button: 'x' })).toEqual(['a/y']);
    expect(ids('a/*')).toEqual(['a/x', 'a/y']);
    expect(ids('b/*')).toEqual([]);
    expect(ids('a/y')).toEqual(['a/y']);
    expect(ids('a/zz')).toBeNull();
    expect(ids('zz/*')).toBeNull();
  });
});

describe('READY colors that read as a result', () => {
  test('reds read as FAILURE, greens as SUCCESS; the palette and other hues are fine', () => {
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
    /** Each color → what it reads like, so a failure names the color. */
    const looks = (colors: string[]) => Object.fromEntries(colors.map((c) => [c, stateLookalike(hex(c))]));
    const all = (colors: string[], v: ReturnType<typeof stateLookalike>) => Object.fromEntries(colors.map((c) => [c, v]));
    const reds = ['#e3262b', '#d62828', '#ff0000', '#8b0000', '#b91c1c', '#e11d48', '#f87171'];
    const greens = ['#2bd46e', '#22c55e', '#00ff00', '#008000', '#16a34a', '#10b981', '#84cc16'];
    const fine = ['#2f6fde', '#facc15', '#db2777', '#7c3aed', '#f97316', '#0891b2', '#4338ca', '#0d9488', '#c026d3', '#f4f4f5', '#ea580c', '#ffb3b3', '#14532d'];
    expect(looks(reds)).toEqual(all(reds, 'failure'));
    expect(looks(greens)).toEqual(all(greens, 'success'));
    expect(looks(fine)).toEqual(all(fine, null));
  });
});
