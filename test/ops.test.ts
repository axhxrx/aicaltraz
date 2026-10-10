/** Edit-mode draft helpers (src/web/edit/ops.ts): action conversion, new ids, duplicates. */
import { describe, expect, test } from 'bun:test';
import { Config, type Action, type Button } from '../src/core/config.ts';
import { convertAction, copyOf, newButton, newPad, shQuote, simpleWords } from '../src/web/edit/ops.ts';

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
