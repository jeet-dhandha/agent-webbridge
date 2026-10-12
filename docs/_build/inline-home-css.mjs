// Regenerates the inlined, purged, minified CSS block in docs/index.html.
// Run after editing assets/site.css or assets/home.css, or after changing index.html markup:
//   node docs/_build/inline-home-css.mjs
// Dev-only: shells out to npx purgecss + lightningcss (nothing is added to package.json).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'awb-css-'));
const read = (f) => readFileSync(join(docs, f), 'utf8');
const sh = (...a) => execFileSync('npx', ['--yes', ...a], { stdio: ['ignore', 'pipe', 'inherit'] });

writeFileSync(join(tmp, 'all.css'), read('assets/site.css') + '\n' + read('assets/home.css'));
// "done" is toggled by site.js (copy button), so purge can't see it in the HTML.
sh('purgecss', '--css', join(tmp, 'all.css'), '--content', join(docs, 'index.html'),
  '--safelist', 'done', '--keyframes', '--font-face', '--variables', '-o', join(tmp, 'out/'));
sh('lightningcss-cli', '--minify', join(tmp, 'out/all.css'), '-o', join(tmp, 'min.css'));

const css = readFileSync(join(tmp, 'min.css'), 'utf8').trim();
const html = read('index.html');
const re = /<!--css:start-->[\s\S]*?<!--css:end-->/;
if (!re.test(html)) throw new Error('index.html is missing the <!--css:start-->…<!--css:end--> markers');
writeFileSync(join(docs, 'index.html'), html.replace(re, () => `<!--css:start--><style>${css}</style><!--css:end-->`));
console.log(`inlined ${css.length} bytes of CSS into index.html`);
