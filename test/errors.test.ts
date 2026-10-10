/**
 * Errors people can act on (QA round 2: admin, rider, chaos): JSON syntax errors with line:column,
 * every validation error in one pass, named by pad/button id with the line in the file; why the
 * host can't listen; and the non-blocking warnings of a save.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Config, parseConfig, type ConfigInput } from '../src/core/config.ts';
import { describeJsonError, explainConfigErrors, findJsonError } from '../src/server/config-errors.ts';
import { readConfigFile } from '../src/server/config-store.ts';
import { configWarnings, MAX_WARNINGS } from '../src/server/config-warnings.ts';
import { listenError, ListenError } from '../src/server/errors.ts';
import { startHost, type Host } from '../src/server/host.ts';
import { toProblems } from '../src/web/edit/problems.ts';
import { cleanupTmp, padConfig, tmpDir, writeExecutable, writeJson } from './helpers.ts';

const hosts: Host[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()));
});
afterAll(cleanupTmp);

const none = { type: 'none' as const };
const btn = (id: string, x: number, y: number, extra: object = {}) => ({ id, x, y, action: none, ...extra });

describe('JSON syntax errors: line, column and what to fix', () => {
  const cases: [string, string][] = [
    ['', 'line 1, column 1: the file is empty'],
    ['{"a": 1,}', 'line 1, column 8: a comma before "}": JSON doesn\'t allow a trailing comma'],
    ['{\n  "pads": [\n    {"id": "x"},\n  ]\n}', 'line 3, column 16: a comma before "]": JSON doesn\'t allow a trailing comma'],
    ['{\n  "a": 1\n  "b": 2\n}', 'line 3, column 3: a comma is missing between "a" and "b"'],
    ['[1 2]', 'line 1, column 4: a comma is missing between two list items'],
    ['{"a": 1 x}', 'line 1, column 9: expected "," or "}" after the value of "a", found "x"'],
    ['{"version": 1', 'line 1, column 14: the file ends before the "{" at line 1, column 1 is closed'],
    ['{\n  "label": "Hello\n}', 'line 2, column 18: a line break inside a string: is the closing " missing? (the string starts at column 12; write \\n for a line break)'],
    ["{'a': 1}", 'line 1, column 2: property names need double quotes ("…"), not single quotes'],
    ['{a: 1}', 'line 1, column 2: property names need double quotes: "a"'],
    ['{"a": tru}', 'line 1, column 7: unexpected tru (did you mean true?)'],
    ['{"a": True}', 'line 1, column 7: True isn\'t JSON: write true, false or null (lowercase)'],
    ['{"a": hold}', 'line 1, column 7: unexpected hold: text needs double quotes ("hold")'],
    ['{"a": 0500}', 'line 1, column 7: numbers can\'t have leading zeros (write 7, not 07)'],
    ['{"a": "C:\\Users"}', 'line 1, column 10: invalid escape "\\U" in a string (write \\\\ for a backslash)'],
    ['// my config\n{}', 'line 1, column 1: comments are not allowed in JSON'],
    ['{"a": 1}}', 'line 1, column 9: unexpected "}" after the end of the JSON (one "}" too many?)'],
    ['{"ü": "日本", "b" 2}', 'line 1, column 17: expected ":" after the property name "b", found "2"'],
  ];
  for (const [text, want] of cases)
    test(JSON.stringify(text), () => {
      let parseError: unknown;
      try {
        JSON.parse(text);
      } catch (e) {
        parseError = e;
      }
      expect(parseError).toBeDefined();
      expect(describeJsonError(text, parseError)).toBe(`invalid JSON at ${want}`);
    });

  test('valid JSON has no error to find', () => {
    expect(findJsonError('{"a": [1, -2.5e3, true, null, "\\u00e9\\n"]}')).toBeUndefined();
  });

  test('a hand-edited file with a syntax error: the host reports where', () => {
    const path = join(tmpDir(), 'c.json');
    writeFileSync(path, '{\n  "version": 1,\n  "pads": [\n    { "id": "p", "name": "P" }\n    { "id": "q", "name": "Q" }\n  ]\n}\n');
    expect(readConfigFile(path)).toMatchObject({ ok: false, errors: ['invalid JSON at line 5, column 5: a comma is missing between two list items'] });
  });
});

describe('validation errors: all in one pass, by name, with the line', () => {
  const broken = (): ConfigInput =>
    ({
      version: 1,
      pads: [
        {
          id: 'lights',
          name: 'Lights',
          cols: 3,
          rows: 2,
          buttons: [
            btn('key', 0, 0, { holdMs: 99999 }),
            btn('fill', 0, 0, { trigger: 'longpress' }), // overlaps key, and a bad trigger
            btn('back', 2, 1, { w: 2, colour: 'red' }), // outside the grid, and an unknown field
            btn('fill', 1, 1, { action: { type: 'exec' } }), // duplicate id, no command
          ],
        },
      ],
    }) as unknown as ConfigInput;

  test('parseConfig reports field errors and grid/id errors together (zod alone stops at the first kind)', () => {
    const r = parseConfig(broken());
    if (r.ok) throw new Error('expected errors');
    expect(r.errors).toEqual([
      'pads.0.buttons.0.holdMs: Too big: expected number to be <=5000',
      'pads.0.buttons.1.trigger: Invalid option: expected one of "hold"|"tap"|"double"',
      'pads.0.buttons.2: Unrecognized key: "colour"',
      'pads.0.buttons.3.action.command: Invalid input: expected string, received undefined',
      'pads.0.buttons.1: button "fill" overlaps "key" at cell 0,0',
      'pads.0.buttons.2: button "back" extends outside the 3x2 grid',
      'pads.0.buttons.3.id: duplicate button id "fill"',
    ]);
    // The editor maps these (index paths) onto its fields: keep that working.
    expect(toProblems(r.errors).map((p) => [p.pad, p.button, p.field])).toEqual([
      [0, 0, 'holdMs'],
      [0, 1, 'trigger'],
      [0, 2, null],
      [0, 3, 'action.command'],
      [0, 1, null],
      [0, 2, null],
      [0, 3, 'id'],
    ]);
  });

  test('the file\'s errors are worded by id, with lines, in file order', () => {
    const raw = broken();
    const text = JSON.stringify(raw, null, 2);
    const r = parseConfig(raw);
    if (r.ok) throw new Error('expected errors');
    expect(explainConfigErrors(raw, r.errors, text)).toEqual([
      'pad "lights" › button "key": holdMs must be ≤ 5000 (line 17)',
      'pad "lights" › button #2: overlaps "key" at cell 0,0 (line 19)',
      'pad "lights" › button #2: trigger must be "hold", "tap" or "double", not "longpress" (line 26)',
      'pad "lights" › button "back": extends outside the 3x2 grid (line 28)',
      'pad "lights" › button "back": unknown field "colour" (did you mean "color"?) (line 36)',
      'pad "lights" › button #4: id "fill" is already used by button #2 (line 39)',
      'pad "lights" › button #4: action.command is missing (line 42)',
    ]);
  });

  test('top-level and pad-level errors, ids that can\'t name anything, and the wording of common mistakes', () => {
    const raw = {
      version: 2,
      sever: {},
      server: { port: '8787' },
      pads: [
        { id: 'a b', name: '', cols: 13, buttons: [{ id: 'x', x: 1.5, y: 0, confirm: 'yes', action: { type: 'exec', command: 'ls', script: 'ls', env: { 'MY VAR': '1' } } }] },
        { id: 'a b', name: 'Two', buttons: [{ id: 'y', x: 0, y: 0 }] },
      ],
    };
    const r = parseConfig(raw);
    if (r.ok) throw new Error('expected errors');
    const lines = explainConfigErrors(raw, r.errors, JSON.stringify(raw, null, 2)).map((l) => l.replace(/ \(line \d+\)$/, ''));
    expect(lines).toEqual([
      'version must be 1, not 2',
      'unknown field "sever" (did you mean "server"?)',
      'server.port must be a number, not the text "8787" (remove the quotes)',
      'pad #1: id "a b" may only use letters, digits, _ and -',
      "pad #1: name can't be empty",
      'pad #1: cols must be ≤ 12',
      'pad #1 › button "x": x must be a whole number, not 1.5',
      'pad #1 › button "x": confirm must be true or false, not the text "yes"',
      'pad #1 › button "x": action: unknown field "script" ("script" is for shell actions)',
      'pad #1 › button "x": action.env: "MY VAR" isn\'t a valid variable name (letters, digits and _ only, not starting with a digit)',
      'pad #2: id "a b" may only use letters, digits, _ and -',
      'pad #2: id "a b" is already used by pad #1',
      'pad #2 › button "y": action is missing',
    ]);
    // Not even an object.
    expect(explainConfigErrors([], (parseConfig([]) as { errors: string[] }).errors, '[]')).toEqual(['the config must be an object ({…}), not a list (line 1)']);
  });

  test('ConfigStore / CLI: a hand edit\'s errors come worded; PUT\'s 400 keeps index paths for the editor', async () => {
    const dir = tmpDir();
    const configPath = join(dir, 'c.json');
    writeJson(configPath, padConfig([btn('a', 0, 0)]));
    const host = await startHost({ configPath, host: '127.0.0.1', port: 0, log: () => {}, debounceMs: 30 });
    hosts.push(host);
    writeJson(configPath, padConfig([btn('a', 0, 0, { holdMs: 5 }), btn('b', 0, 0)]));
    expect(host.config.sync()).toBe('error');
    expect(host.config.fileErrors).toEqual(['pad "p" › button "a": holdMs must be ≥ 100 (line 17)', 'pad "p" › button "b": overlaps "a" at cell 0,0 (line 19)']);
    const url = `http://127.0.0.1:${host.port}/api/config`;
    const headers = { authorization: `Bearer ${host.secrets.adminToken}`, 'content-type': 'application/json' };
    const r = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ config: padConfig([btn('a', 0, 0, { holdMs: 5 })]), baseRev: host.config.diskRev }) });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ errors: ['pads.0.buttons.0.holdMs: Too small: expected number to be >=100'] });
  });
});

describe("why the host can't listen", () => {
  const e = (code: string, syscall = 'listen', message = `${code}: x, ${syscall}`) => Object.assign(new Error(message), { code, syscall });
  test('each errno, explained with where the address came from', () => {
    expect(listenError('0.0.0.0', 8787, e('EADDRINUSE')).message).toBe(
      "can't listen on 0.0.0.0:8787: port 8787 is in use (another ButtPad?); pick another port (server.port), or --port 0 for any free one",
    );
    expect(listenError('192.0.2.7', 8787, e('EADDRNOTAVAIL'), { host: '--host', port: '--port' }).message).toBe(
      'can\'t listen on 192.0.2.7:8787: no network interface on this machine has the address 192.0.2.7 (--host); use "0.0.0.0" to listen on every network interface, or "127.0.0.1" for this machine only',
    );
    expect(listenError('lamp.local', 8787, e('ENOENT')).message).toStartWith('can\'t listen on lamp.local:8787: "lamp.local" (server.host) is neither an IP address nor a host name that resolves;');
    expect(listenError('::1', 80, e('EAFNOSUPPORT')).message).toStartWith("can't listen on [::1]:80: IPv6 isn't available on this machine");
    expect(listenError('0.0.0.0', 80, e('EACCES')).message).toBe("can't listen on 0.0.0.0:80: permission denied: ports below 1024 need extra privileges; pick a port ≥ 1024 (server.port)");
    expect(listenError('0.0.0.0', 8787, e('ENOENT', 'open', "ENOENT: no such file or directory, open '/x/cert.pem'")).message).toBe(
      "can't read the TLS file /x/cert.pem: no such file or directory (ENOENT)",
    );
    expect(listenError('0.0.0.0', 8787, Object.assign(new Error('error:0900006e:PEM routines:OPENSSL_internal:NO_START_LINE'), { code: 'ERR_OSSL_PEM_NO_START_LINE' })).message).toStartWith(
      "can't use the TLS certificate/key: they aren't a valid PEM certificate and private key",
    );
  });

  test('startHost: an address that isn\'t this machine\'s, and a busy port', async () => {
    const dir = tmpDir();
    const configPath = join(dir, 'c.json');
    writeJson(configPath, { ...padConfig([btn('a', 0, 0)]), server: { host: '192.0.2.123' } });
    const bad = await startHost({ configPath, port: 0, log: () => {} }).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(bad).toBeInstanceOf(ListenError);
    expect((bad as ListenError).message).toStartWith("can't listen on 192.0.2.123:0: no network interface on this machine has the address 192.0.2.123 (server.host in the config);");
    const first = await startHost({ configPath, host: '127.0.0.1', port: 0, log: () => {} });
    hosts.push(first);
    const busy = await startHost({ configPath, host: '127.0.0.1', port: first.port, log: () => {}, statePath: join(dir, 'other.state.json') }).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect((busy as ListenError).message).toStartWith(`can't listen on 127.0.0.1:${first.port}: port ${first.port} is in use (another ButtPad?)`);
  });
});

describe('warnings: what would fail when pressed, found at save time', () => {
  const setupDir = () => {
    const dir = tmpDir();
    writeExecutable(join(dir, 'scripts', 'ok.sh'), '#!/bin/sh\necho ok\n');
    writeFileSync(join(dir, 'scripts', 'noexec.sh'), '#!/bin/sh\necho no\n');
    writeExecutable(join(dir, 'scripts', 'noshebang.sh'), 'echo no shebang\n');
    writeExecutable(join(dir, 'scripts', 'badinterp.sh'), '#!/usr/bin/nonexistent-interpreter\necho\n');
    writeExecutable(join(dir, 'scripts', 'envinterp.sh'), '#!/usr/bin/env buttpad-no-such-interpreter\necho\n');
    writeExecutable(join(dir, 'bin', 'mytool'), '#!/bin/sh\necho tool\n');
    mkdirSync(join(dir, 'sub'));
    writeExecutable(join(dir, 'sub', 'here.sh'), '#!/bin/sh\necho here\n');
    return dir;
  };
  const exec = (command: string, extra: object = {}) => ({ type: 'exec' as const, command, ...extra });
  const cfgOf = (buttons: object[]) => Config.parse({ version: 1, pads: [{ id: 'p', name: 'P', cols: 4, rows: 4, buttons }] });

  test('commands resolve like the runner: relative to the working folder, else PATH (the action\'s own, if set)', () => {
    const dir = setupDir();
    const cfg = cfgOf([
      btn('ok', 0, 0, { action: exec('./scripts/ok.sh') }),
      btn('rel-cwd', 1, 0, { action: exec('./here.sh', { cwd: 'sub' }) }),
      btn('path', 2, 0, { action: exec('sh', { args: ['-c', 'true'] }) }),
      btn('own-path', 3, 0, { action: exec('mytool', { env: { PATH: join(dir, 'bin') } }) }),
      btn('none', 0, 1),
      btn('shell', 1, 1, { action: { type: 'shell', script: 'true' } }),
    ]);
    expect(configWarnings(cfg, dir)).toEqual([]);
  });

  test('missing, not executable, no #! line, missing interpreter, missing shell, missing cwd, stops that stop nothing', () => {
    const dir = setupDir();
    const cfg = cfgOf([
      btn('typo', 0, 0, { action: exec('./scripts/lite.sh') }),
      btn('noexec', 1, 0, { action: exec('./scripts/noexec.sh') }),
      btn('nobang', 2, 0, { action: exec('./scripts/noshebang.sh') }),
      btn('interp', 3, 0, { action: exec('./scripts/badinterp.sh') }),
      btn('envinterp', 0, 1, { action: exec('./scripts/envinterp.sh') }),
      btn('notonpath', 1, 1, { action: exec('buttpad-no-such-tool') }),
      btn('dir', 2, 1, { action: exec('./scripts') }),
      btn('shell', 3, 1, { action: { type: 'shell', script: 'true', shell: '/bin/no-such-shell' } }),
      btn('cwd', 0, 2, { action: exec('./x', { cwd: 'nowhere' }) }),
      btn('stops', 1, 2, { stops: ['p/stops', 'p/nope', 'q/*', 'p/*', '*'] }),
    ]);
    const s = join(dir, 'scripts');
    expect(configWarnings(cfg, dir)).toEqual([
      `pad "p" › button "typo": command not found: ${s}/lite.sh`,
      `pad "p" › button "noexec": permission denied (chmod +x?): ${s}/noexec.sh`,
      `pad "p" › button "nobang": not executable as a program (missing #! line?): ${s}/noshebang.sh`,
      `pad "p" › button "interp": interpreter not found (check the #! line): ${s}/badinterp.sh wants /usr/bin/nonexistent-interpreter`,
      `pad "p" › button "envinterp": interpreter not found (check the #! line): ${s}/envinterp.sh wants buttpad-no-such-interpreter, which isn't on PATH`,
      'pad "p" › button "notonpath": command not found: buttpad-no-such-tool (not on PATH)',
      `pad "p" › button "dir": is a directory: ${s}`,
      'pad "p" › button "shell": shell not found: /bin/no-such-shell',
      `pad "p" › button "cwd": cwd not found: ${join(dir, 'nowhere')}`,
      'pad "p" › button "stops": stops "p/stops" matches no other button',
      'pad "p" › button "stops": stops "p/nope" matches no other button',
      'pad "p" › button "stops": stops "q/*" matches no other button',
    ]);
  });

  test('capped, so a big broken config stays readable', () => {
    const buttons = Array.from({ length: 70 }, (_, i) => btn(`b${i}`, i % 10, Math.floor(i / 10), { action: exec('buttpad-no-such-tool') }));
    const cfg = Config.parse({ version: 1, pads: [{ id: 'p', name: 'P', cols: 10, rows: 7, buttons }] });
    const w = configWarnings(cfg, tmpDir());
    expect(w.length).toBe(MAX_WARNINGS);
    expect(w.at(-1)).toBe(`…and ${70 - MAX_WARNINGS + 1} more`);
  });

  test('PUT /api/config: 200 {rev, warnings}; the save itself goes through', async () => {
    const dir = setupDir();
    const configPath = join(dir, 'buttpad.config.json');
    writeJson(configPath, padConfig([btn('a', 0, 0, { action: exec('./scripts/ok.sh') })]));
    const logs: string[] = [];
    const host = await startHost({ configPath, host: '127.0.0.1', port: 0, log: (m) => logs.push(m) });
    hosts.push(host);
    const url = `http://127.0.0.1:${host.port}/api/config`;
    const headers = { authorization: `Bearer ${host.secrets.adminToken}`, 'content-type': 'application/json' };
    const cfg = padConfig([btn('a', 0, 0, { action: exec('./scripts/ok.sh') }), btn('b', 1, 0, { action: exec('./scripts/noexec.sh') })]);
    const r = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ config: cfg, baseRev: host.config.rev }) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({ rev: host.config.rev, warnings: [`pad "p" › button "b": permission denied (chmod +x?): ${join(dir, 'scripts', 'noexec.sh')}`] });
    // Fixing it: no warnings.
    chmodSync(join(dir, 'scripts', 'noexec.sh'), 0o755);
    const again = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ config: { ...cfg, pads: [{ ...cfg.pads[0]!, name: 'Fixed' }] }, baseRev: body.rev }) });
    expect((await again.json()).warnings).toEqual([]);
    // The operator sees them in the log too.
    expect(logs).toContain(`⚠ pad "p" › button "b": permission denied (chmod +x?): ${join(dir, 'scripts', 'noexec.sh')}`);
  });
});
