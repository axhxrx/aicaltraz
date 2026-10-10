/**
 * ButtPad config schema. This file is the contract every implementation (this Bun server, a future
 * Swift app, whatever) agrees on; `bun run schema` emits it as JSON Schema for non-TS consumers.
 */
import { z } from 'zod';

const env = z.record(z.string(), z.string());

export const ExecAction = z.strictObject({
  type: z.literal('exec'),
  /** Executable path, or a name resolved via PATH. Run directly, no shell. */
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: env.optional(),
});

export const ShellAction = z.strictObject({
  type: z.literal('shell'),
  /** Passed to the shell as a single command string (`sh -c` / `cmd /c`). */
  script: z.string().min(1),
  /** Shell binary. Defaults to $SHELL, else /bin/sh (POSIX) or cmd.exe (Windows). */
  shell: z.string().optional(),
  cwd: z.string().optional(),
  env: env.optional(),
});

export const Action = z.discriminatedUnion('type', [ExecAction, ShellAction]);

export const Trigger = z.enum(['hold', 'tap', 'double']);

/** What a press does while the action is already running. */
export const WhileRunning = z.enum(['ignore', 'cancel', 'queue']);

export const Button = z.strictObject({
  id: z.string().min(1).regex(/^[\w-]+$/, 'letters, digits, _ and - only'),
  label: z.string().default(''),
  /** Any CSS color. The ready-state background. */
  color: z.string().default('#2f6fde'),
  /** Grid placement, 0-based cell coords, spans in cells. */
  x: z.int().min(0),
  y: z.int().min(0),
  w: z.int().min(1).default(1),
  h: z.int().min(1).default(1),
  trigger: Trigger.default('hold'),
  holdMs: z.int().min(100).max(5000).default(500),
  /** How far (CSS px) a finger may slide during a hold before the press cancels. */
  driftPx: z.number().min(0).default(60),
  whileRunning: WhileRunning.default('ignore'),
  /** Require a second press within confirmWindowMs before firing. */
  confirm: z.boolean().default(false),
  confirmWindowMs: z.int().min(500).default(3000),
  timeoutMs: z.int().min(100).default(30_000),
  /** How long SUCCESS/FAILURE stays on screen before going back to READY. */
  resultHoldMs: z.int().min(0).default(2500),
  /** Keyboard key (KeyboardEvent.key) that presses this button, for BLE remotes etc. */
  key: z.string().optional(),
  action: Action,
});

export const Pad = z.strictObject({
  id: z.string().min(1).regex(/^[\w-]+$/, 'letters, digits, _ and - only'),
  name: z.string().min(1),
  cols: z.int().min(1).max(12).default(2),
  rows: z.int().min(1).max(12).default(2),
  buttons: z.array(Button).default([]),
});

export const Config = z
  .strictObject({
    $schema: z.string().optional(),
    version: z.literal(1),
    server: z
      .strictObject({
        host: z.string().default('0.0.0.0'),
        port: z.int().min(1).max(65535).default(8787),
      })
      .prefault({}),
    pads: z.array(Pad).min(1),
  })
  .superRefine((cfg, ctx) => {
    const padIds = new Set<string>();
    cfg.pads.forEach((pad, pi) => {
      if (padIds.has(pad.id)) ctx.addIssue({ code: 'custom', path: ['pads', pi, 'id'], message: `duplicate pad id "${pad.id}"` });
      padIds.add(pad.id);
      const ids = new Set<string>();
      const occupied = new Map<string, string>();
      pad.buttons.forEach((b, bi) => {
        const path = ['pads', pi, 'buttons', bi];
        if (ids.has(b.id)) ctx.addIssue({ code: 'custom', path: [...path, 'id'], message: `duplicate button id "${b.id}"` });
        ids.add(b.id);
        if (b.x + b.w > pad.cols || b.y + b.h > pad.rows) {
          ctx.addIssue({ code: 'custom', path, message: `button "${b.id}" extends outside the ${pad.cols}x${pad.rows} grid` });
          return;
        }
        for (let x = b.x; x < b.x + b.w; x++)
          for (let y = b.y; y < b.y + b.h; y++) {
            const other = occupied.get(`${x},${y}`);
            if (other) ctx.addIssue({ code: 'custom', path, message: `button "${b.id}" overlaps "${other}" at cell ${x},${y}` });
            else occupied.set(`${x},${y}`, b.id);
          }
      });
    });
  });

export type ExecAction = z.infer<typeof ExecAction>;
export type ShellAction = z.infer<typeof ShellAction>;
export type Action = z.infer<typeof Action>;
export type Button = z.infer<typeof Button>;
export type Pad = z.infer<typeof Pad>;
export type Config = z.infer<typeof Config>;
/** Pre-defaults shape, i.e. what a human writes in the file. */
export type ConfigInput = z.input<typeof Config>;

export type ParseResult = { ok: true; config: Config } | { ok: false; errors: string[] };

export function parseConfig(raw: unknown): ParseResult {
  const r = Config.safeParse(raw);
  if (r.success) return { ok: true, config: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
}

export function findButton(cfg: Config, padId: string, buttonId: string): Button | undefined {
  return cfg.pads.find((p) => p.id === padId)?.buttons.find((b) => b.id === buttonId);
}

/** Stable key for a button across pads. */
export const buttonKey = (padId: string, buttonId: string) => `${padId}/${buttonId}`;
