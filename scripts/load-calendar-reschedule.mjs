import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Share the real helper with the older isolated CommonJS service harnesses.
const result = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/services/calendar-reschedule.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs',
});
const module = { exports: {} };
new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports);
export default module.exports;
