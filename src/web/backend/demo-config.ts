/** The demo's starter pads. Scripts are plain sh, so this config also runs on a real host. */
import type { ConfigInput } from '../../core/config.ts';

const progress = (n: number, seconds: number, status?: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => {
    const s = status ? `echo '@status ${status(i)}'; ` : '';
    return `${s}echo '@progress ${Math.round((i * 100) / n)}'; sleep ${(seconds / n).toFixed(2)}`;
  }).join('; ') + "; echo '@progress 100'";

export const DEMO_CONFIG: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'lights',
      name: 'Lights',
      cols: 2,
      rows: 3,
      buttons: [
        { id: 'key-light', label: 'Key light', color: '#facc15', x: 0, y: 0, key: '1', action: { type: 'shell', script: "echo '@status dimming up'; sleep 0.8; echo 'Key light at 80%'" } },
        { id: 'fill-light', label: 'Fill light', color: '#2f6fde', x: 1, y: 0, trigger: 'tap', key: '2', action: { type: 'shell', script: "sleep 0.5; echo 'Fill on'" } },
        { id: 'strobe', label: 'Strobe', color: '#db2777', x: 0, y: 1, trigger: 'double', key: '3', action: { type: 'shell', script: "echo '@status flash'; sleep 0.6; echo '@status flash flash'; sleep 0.6; echo 'Flashed 3×'" } },
        { id: 'backdrop', label: 'Backdrop sunset', color: '#7c3aed', x: 1, y: 1, key: '4', action: { type: 'shell', script: `${progress(8, 3.2, (i) => (i < 4 ? 'fading in' : 'warming'))}; echo 'Sunset scene on'` } },
        { id: 'all-off', label: 'ALL OFF', color: '#4338ca', x: 0, y: 2, w: 2, holdMs: 800, confirm: true, key: '0', action: { type: 'shell', script: "echo '@status cutting power'; sleep 1.2; echo 'Everything off'" } },
      ],
    },
    {
      id: 'shoot',
      name: 'Shoot',
      cols: 2,
      rows: 3,
      buttons: [
        { id: 'render', label: 'Render preview', color: '#0891b2', x: 0, y: 0, w: 2, whileRunning: 'cancel', timeoutMs: 120_000, key: 'r', action: { type: 'shell', script: `${progress(24, 16, (i) => `encoding frame ${(i + 1) * 25}/600`)}; echo 'preview.mp4 ready'` } },
        { id: 'upload', label: 'Upload selects', color: '#2f6fde', x: 0, y: 1, trigger: 'tap', whileRunning: 'queue', key: 'u', action: { type: 'shell', script: `${progress(6, 2.4, () => 'uploading')}; echo '12 photos uploaded'` } },
        { id: 'relay', label: 'Flash relay', color: '#db2777', x: 1, y: 1, trigger: 'tap', key: 'f', action: { type: 'shell', script: "curl -fsS http://studio-pi.local/relay/1 && echo 'Relay clicked'" } },
        { id: 'fog', label: 'Fog machine', color: '#7c3aed', x: 0, y: 2, timeoutMs: 3000, key: 'g', action: { type: 'shell', script: "echo '@status heating up'; sleep 8; echo 'Fog!'" } },
        { id: 'card', label: 'Card backup', color: '#f97316', x: 1, y: 2, key: 'c', action: { type: 'shell', script: "echo '@status copying'; sleep 1.4; echo 'card full: 0 bytes free' >&2; exit 3" } },
      ],
    },
    {
      id: 'ride',
      name: 'Ride',
      cols: 1,
      rows: 2,
      buttons: [
        { id: 'rec', label: 'REC', color: '#f97316', x: 0, y: 0, key: 'Enter', action: { type: 'shell', script: "echo '@status starting'; sleep 0.9; echo 'Recording'" } },
        { id: 'mark', label: 'Mark clip', color: '#2f6fde', x: 0, y: 1, trigger: 'tap', key: ' ', action: { type: 'shell', script: "sleep 0.3; echo 'Marked 00:14:32'" } },
      ],
    },
  ],
};
