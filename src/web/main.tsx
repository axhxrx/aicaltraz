import { render } from 'preact';
import { App } from './app.tsx';
import { lockdown, readOptions, takeHashToken } from './lib/env.ts';
import { loadFonts } from './lib/fit.ts';

takeHashToken();
lockdown();
loadFonts();
render(<App opts={readOptions()} />, document.getElementById('app')!);
