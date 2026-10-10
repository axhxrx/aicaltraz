/** Writes schema/buttpad.config.schema.json from the zod config schema (`bun run schema`). */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { Config } from '../src/core/config.ts';

const out = join(import.meta.dir, '..', 'schema', 'buttpad.config.schema.json');
const { $schema, ...rest } = z.toJSONSchema(Config, { io: 'input' });
const schema = {
  $schema,
  title: 'ButtPad config',
  description:
    'Pads of buttons that run actions on the ButtPad host. Not expressible here, but enforced by the host: unique pad ids, unique button ids per pad, buttons inside the grid and not overlapping.',
  ...rest,
};
mkdirSync(dirname(out), { recursive: true });
await Bun.write(out, JSON.stringify(schema, null, 2) + '\n');
console.log(`wrote ${out}`);
