/**
 * The config written when the config file doesn't exist yet: harmless buttons that work anywhere,
 * showing tap and hold, progress, a failure, cancelling, and a stop button (`stops`, action `none`).
 * No READY color near the SUCCESS green or FAILURE red.
 */
import { existsSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config, type ConfigInput } from '../core/config.ts';
import { serializeConfig } from './config-store.ts';

type ButtonInput = NonNullable<ConfigInput['pads'][number]['buttons']>[number];

/** Runs nothing itself: cancels whatever else is running (Count to 5, say). */
const STOP_ALL: ButtonInput = { id: 'stop', label: 'Stop all', color: '#212529', x: 1, y: 2, trigger: 'tap', stops: ['*'], action: { type: 'none' } };

function posixButtons(configPath: string): ButtonInput[] {
  return [
    { id: 'hello', label: 'Hello', color: '#3a86ff', x: 0, y: 0, trigger: 'tap', action: { type: 'shell', script: 'echo "Hello from $(uname -n)"' } },
    { id: 'time', label: 'Time', color: '#457b9d', x: 1, y: 0, trigger: 'tap', action: { type: 'exec', command: 'date', args: ['+%H:%M:%S %a %d %b'] } },
    {
      id: 'disk',
      label: 'Disk free',
      color: '#6a4c93',
      x: 0,
      y: 1,
      trigger: 'tap',
      action: { type: 'shell', script: `df -Ph . | awk 'NR==2 {print $4 " free of " $2}'` },
    },
    {
      id: 'fail',
      label: 'Fail (demo)',
      color: '#8d99ae',
      x: 1,
      y: 1,
      action: { type: 'shell', script: 'echo "this is what a failure looks like" >&2; exit 1' },
    },
    {
      id: 'count',
      label: 'Count to 5',
      color: '#ffb703',
      x: 0,
      y: 2,
      whileRunning: 'cancel',
      action: {
        type: 'shell',
        script: 'for i in 1 2 3 4 5; do echo "@status $i of 5 (press again to cancel)"; echo "@progress $((i * 20))"; sleep 1; done; echo "@result Counted to 5"',
      },
    },
    STOP_ALL,
    {
      id: 'edit-me',
      label: 'How do I change these buttons?',
      color: '#264653',
      x: 0,
      y: 3,
      w: 2,
      trigger: 'tap',
      resultHoldMs: 10000,
      action: { type: 'exec', command: 'echo', args: [`@result Edit ${configPath} (saves reload live) or use Edit mode from the admin URL`] },
    },
  ];
}

function windowsButtons(configPath: string): ButtonInput[] {
  return [
    { id: 'hello', label: 'Hello', color: '#3a86ff', x: 0, y: 0, trigger: 'tap', action: { type: 'shell', script: 'echo Hello from %COMPUTERNAME%' } },
    { id: 'time', label: 'Time', color: '#457b9d', x: 1, y: 0, trigger: 'tap', action: { type: 'shell', script: 'echo %TIME% %DATE%' } },
    { id: 'version', label: 'Windows version', color: '#6a4c93', x: 0, y: 1, trigger: 'tap', action: { type: 'shell', script: 'ver' } },
    {
      id: 'fail',
      label: 'Fail (demo)',
      color: '#8d99ae',
      x: 1,
      y: 1,
      action: { type: 'shell', script: 'echo this is what a failure looks like 1>&2 & exit /b 1' },
    },
    {
      id: 'count',
      label: 'Count to 5',
      color: '#ffb703',
      x: 0,
      y: 2,
      whileRunning: 'cancel',
      action: {
        type: 'shell',
        shell: 'powershell.exe',
        script: '1..5 | % { "@status $_ of 5 (press again to cancel)"; "@progress $($_ * 20)"; Start-Sleep 1 }; "@result Counted to 5"',
      },
    },
    STOP_ALL,
    {
      id: 'edit-me',
      label: 'How do I change these buttons?',
      color: '#264653',
      x: 0,
      y: 3,
      w: 2,
      trigger: 'tap',
      resultHoldMs: 10000,
      action: { type: 'shell', script: `echo @result Edit ${configPath} (saves reload live) or use Edit mode from the admin URL` },
    },
  ];
}

/** Relative path from the config to this checkout's JSON Schema, when running from source. */
function schemaRef(configPath: string): string | undefined {
  try {
    const file = fileURLToPath(new URL('../../schema/buttpad.config.schema.json', import.meta.url));
    if (existsSync(file)) return relative(dirname(configPath), file).split(sep).join('/');
  } catch {}
  return undefined;
}

export function starterConfig(configPath: string, platform: NodeJS.Platform = process.platform): ConfigInput {
  const $schema = schemaRef(configPath);
  return {
    ...($schema ? { $schema } : {}),
    version: 1,
    pads: [
      {
        id: 'host',
        name: 'This computer',
        cols: 2,
        rows: 4,
        buttons: platform === 'win32' ? windowsButtons(configPath) : posixButtons(configPath),
      },
    ],
  };
}

export const starterConfigText = (configPath: string) => serializeConfig(Config.parse(starterConfig(configPath)));
