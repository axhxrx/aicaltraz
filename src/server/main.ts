#!/usr/bin/env bun
/** ButtPad host. `bun src/server/main.ts --help` for options; see docs/DESIGN.md. */
import { main } from './cli.ts';

await main(process.argv.slice(2));
