// Copies the text-recognition engine and language files from node_modules into vendor/,
// so the app works offline and never fetches anything from a third-party server.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const out = 'vendor/tesseract';
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/core`, { recursive: true });
mkdirSync(`${out}/lang`, { recursive: true });

cpSync('node_modules/tesseract.js/dist/tesseract.min.js', `${out}/tesseract.min.js`);
cpSync('node_modules/tesseract.js/dist/worker.min.js', `${out}/worker.min.js`);
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'])
  cpSync(`node_modules/tesseract.js-core/${f}`, `${out}/core/${f}`);
for (const lang of ['eng', 'deu'])
  cpSync(`node_modules/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`, `${out}/lang/${lang}.traineddata.gz`);
console.log('vendored tesseract into', out);
