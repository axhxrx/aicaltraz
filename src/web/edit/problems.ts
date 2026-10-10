/**
 * Validation errors ("pads.0.buttons.2.action.command: …", from parseConfig or the host's 400)
 * mapped onto the draft: which pad, which button, which field, in plain words.
 */
import type { Config } from '../../core/config.ts';

export interface Problem {
  pad: number | null;
  button: number | null;
  /** Path inside the button/pad, e.g. `holdMs`, `action.command`, `action.env.FOO`; null = the whole thing. */
  field: string | null;
  message: string;
}

const FIELD: Record<string, string> = {
  id: 'Id',
  name: 'Name',
  cols: 'Columns',
  rows: 'Rows',
  label: 'Label',
  color: 'Color',
  trigger: 'Trigger',
  holdMs: 'Hold time',
  driftPx: 'Finger drift',
  whileRunning: 'While running',
  confirm: 'Confirm',
  confirmWindowMs: 'Confirm window',
  timeoutMs: 'Timeout',
  resultHoldMs: 'Result time',
  key: 'Key',
  action: 'Action',
  'action.type': 'Action type',
  'action.command': 'Command',
  'action.args': 'Arguments',
  'action.script': 'Script',
  'action.shell': 'Shell',
  'action.cwd': 'Working folder',
  'action.env': 'Environment',
};

export function fieldName(field: string): string {
  const arg = /^action\.args\.(\d+)$/.exec(field);
  if (arg) return `Argument ${Number(arg[1]) + 1}`;
  const env = /^action\.env\.(.+)$/.exec(field);
  if (env) return `Variable ${env[1]}`;
  return FIELD[field] ?? field;
}

export function pretty(msg: string): string {
  let m: RegExpExecArray | null;
  if (/^Too small: expected string to have >=1 characters?$/.test(msg)) return "Can't be empty";
  if ((m = /^Too small: expected number to be >=?(.+)$/.exec(msg))) return `Must be at least ${m[1]}`;
  if ((m = /^Too big: expected number to be <=?(.+)$/.exec(msg))) return `Must be at most ${m[1]}`;
  if (/expected int, received number/.test(msg)) return 'Must be a whole number';
  if (/expected number, received/.test(msg)) return 'Must be a number';
  if (/^Too small: expected array to have >=1 items?$/.test(msg)) return 'Needs at least one';
  if (/^duplicate button id/.test(msg)) return 'Another button on this pad has this id';
  if (/^duplicate pad id/.test(msg)) return 'Another pad has this id';
  if (msg === 'letters, digits, _ and - only') return 'Letters, digits, _ and - only';
  return msg;
}

/** Split "path: message" (the message may contain ": " itself). */
export function toProblems(errors: string[]): Problem[] {
  return errors.map((raw) => {
    const at = raw.indexOf(': ');
    const path = at >= 0 ? raw.slice(0, at) : '(root)';
    const message = pretty(at >= 0 ? raw.slice(at + 2) : raw);
    const seg = path.split('.');
    if (seg[0] !== 'pads' || seg.length < 2 || !/^\d+$/.test(seg[1]!)) return { pad: null, button: null, field: path === '(root)' ? null : path, message };
    const pad = Number(seg[1]);
    if (seg[2] === 'buttons' && seg[3] !== undefined && /^\d+$/.test(seg[3])) {
      const rest = seg.slice(4).join('.');
      return { pad, button: Number(seg[3]), field: rest || null, message };
    }
    return { pad, button: null, field: seg.slice(2).join('.') || null, message };
  });
}

/** One line for a list: "Lights › “Fill light” · Command: Can't be empty". */
export function describe(p: Problem, cfg: Config): string {
  const pad = p.pad === null ? null : cfg.pads[p.pad];
  const b = pad && p.button !== null ? pad.buttons[p.button] : null;
  const where = [pad ? pad.name || pad.id : null, b ? (b.label.trim() ? `“${b.label.trim()}”` : b.id) : null].filter(Boolean).join(' › ');
  const what = p.field ? `${fieldName(p.field)}: ${p.message}` : p.message;
  return where ? `${where} · ${what}` : what;
}

/** Field errors of one button (first message per field; '' = the button as a whole). */
export function buttonFieldErrors(list: Problem[], pad: number, button: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of list) if (p.pad === pad && p.button === button && !out.has(p.field ?? '')) out.set(p.field ?? '', p.message);
  return out;
}

export function padFieldErrors(list: Problem[], pad: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of list) if (p.pad === pad && p.button === null && !out.has(p.field ?? '')) out.set(p.field ?? '', p.message);
  return out;
}
