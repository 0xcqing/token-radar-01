// The token-radar entry point (Node 22.18+, standard library only, erasable TypeScript).
//
// It reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores every
// protocol that records no token with the comparables model in lib/model.ts, writes the ranked board
// to /output/board.json (or MAKEFUN_OUTPUT_DIR), writes the dashboard's data.js beside the page,
// copies dashboard/ and screenshots/ into /output, and writes /output/dossier.json with the vendored
// make.fun library. The dashboard is static: no framework, no network, every row in data.js.
//
//   mkdir out; set MAKEFUN_OUTPUT_DIR=D:\...\out; node main.ts --input ...\snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot, type BoardRow } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_MIN_COUNT = 3;
const SCREENSHOT_MAX_COUNT = 3;
const SCREENSHOT_MAX_BYTES = 524_288;
const SCREENSHOT_MIN_SHORT = 800;
const SCREENSHOT_MAX_LONG = 1440;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

function chmodSafe(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows and some mounts ignore POSIX modes; the content is what matters.
  }
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true, mode: 0o755 });
chmodSafe(out, 0o755);

function writeOutput(path: string, body: string | Uint8Array): void {
  writeFileSync(path, body, { mode: 0o644 });
  chmodSafe(path, 0o644);
}

writeOutput(join(out, 'board.json'), `${JSON.stringify({ rows: board as BoardRow[] })}\n`);
writeOutput(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping dot entries. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true, mode: 0o755 });
  chmodSafe(to, 0o755);
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    const target = join(to, name);
    copyFileSync(path, target);
    chmodSafe(target, 0o644);
    copied.push(name);
  }
  return copied;
}

const dashboardFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const dashboardBytes = dashboardFiles.reduce((n, name) => n + statSync(join(out, 'dashboard', name)).size, 0);
if (dashboardBytes > TEXT_MAX_BYTES) {
  process.stderr.write(`token radar: dashboard source is ${dashboardBytes} bytes, over the ${TEXT_MAX_BYTES}-byte dossier text cap\n`);
  process.exit(1);
}

interface PngSize {
  width: number;
  height: number;
}

function pngSize(bytes: Uint8Array): PngSize | null {
  if (bytes.length < 24) return null;
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return null;
  const header = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (header !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const shotsDir = join(here, 'screenshots');
const shotNames = existsSync(shotsDir)
  ? readdirSync(shotsDir)
      .filter((name) => !name.startsWith('.'))
      .sort()
  : [];
if (shotNames.length < SCREENSHOT_MIN_COUNT || shotNames.length > SCREENSHOT_MAX_COUNT) {
  process.stderr.write(`token radar: screenshots/ holds ${shotNames.length} image${shotNames.length === 1 ? '' : 's'}: hand in exactly 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shotNames) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
  const path = join(shotsDir, name);
  if (!statSync(path).isFile()) {
    process.stderr.write(`token radar: screenshots/${name} is not a regular file\n`);
    process.exit(1);
  }
  const bytes = readFileSync(path);
  if (bytes.length > SCREENSHOT_MAX_BYTES) {
    process.stderr.write(`token radar: screenshots/${name} is ${bytes.length} bytes, over the 512 KiB cap\n`);
    process.exit(1);
  }
  const size = pngSize(bytes);
  if (size === null) {
    process.stderr.write(`token radar: screenshots/${name} is not a whole PNG\n`);
    process.exit(1);
  }
  const short = Math.min(size.width, size.height);
  const long = Math.max(size.width, size.height);
  if (short < SCREENSHOT_MIN_SHORT || long > SCREENSHOT_MAX_LONG) {
    process.stderr.write(`token radar: screenshots/${name} is ${size.width}x${size.height}: the short side must be at least ${SCREENSHOT_MIN_SHORT} and the long side at most ${SCREENSHOT_MAX_LONG}\n`);
    process.exit(1);
  }
}
const shots = copyFiles(shotsDir, join(out, 'screenshots'));

writeOutput(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES }));

const top = board.slice(0, 5).map((r) => `${r.rank}. ${r.name} ${'$' + Math.round(r.implied_value_usd / 1e6)}M`).join(' | ');
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} pre-token rows scored\n` +
    `token radar: ${radar.comparable_sample} comparable mcap/TVL records, overall median ${radar.overall_multiple.toFixed(3)}x, ${radar.live_size} live-token records set aside\n` +
    `token radar: top ${top}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashboardFiles.length} files, ${dashboardBytes} bytes), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
