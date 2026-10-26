// Browser-Treiber für ELVIS (Playwright, headless Chromium). Liest Befehle zeilenweise von stdin.
// Voraussetzung: .claude/skills/run-elvis/start.sh lief (Cookie in $ELVIS_RUN_DIR/cookie).
//
//   view <lat> <lon> <zoom>     Startausschnitt der Karte (vor dem ersten nav)
//   layers <aircraft|ships|…>   Kartenebenen einschalten (vor dem ersten nav), z. B. „layers aircraft ships“
//   size <breite> <höhe>        Fenstergröße (vor dem ersten nav), Vorgabe 1400 900
//   nav <pfad>                  z. B. /karte, /einstellungen#verkehr
//   wait <selector>             auf ein Element warten (30 s)
//   waittext <text>             auf Text im Seiteninhalt warten (40 s)
//   gone <text>                 warten, bis Text verschwunden ist (40 s)
//   click <selector>            klicken (Playwright-Selector, z. B. text=Objekte)
//   clickcenter <selector>      Mausklick auf das passende Element nächst der Kartenmitte (Kartenmarker)
//   fill <selector> | <text>    Eingabe (React-tauglich)
//   press <taste>               z. B. Escape, Enter
//   sleep <ms>
//   text <selector>             Textinhalt ausgeben
//   count <selector>            Anzahl ausgeben
//   ss <name>                   Screenshot nach $ELVIS_RUN_DIR/shots/<name>.png
//   errors                      Konsolenfehler ausgeben
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const RUN = process.env.ELVIS_RUN_DIR ?? join(process.env.TMPDIR ?? tmpdir(), 'elvis-run');
const WEB = `http://localhost:${process.env.ELVIS_RUN_WEB_PORT ?? 5183}`;

/** Playwright ist kein Projektpaket: PLAYWRIGHT_DIR oder der npx-Cache (npx -y playwright@1.63.0 …) */
function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_DIR) candidates.push(process.env.PLAYWRIGHT_DIR);
  const npx = join(homedir(), '.npm/_npx');
  if (existsSync(npx)) for (const d of readdirSync(npx)) candidates.push(join(npx, d, 'node_modules/playwright'));
  for (const c of candidates) if (existsSync(join(c, 'package.json'))) return createRequire(join(c, 'package.json'))(c);
  throw new Error('Playwright nicht gefunden: npx -y playwright@1.63.0 install chromium (oder PLAYWRIGHT_DIR setzen)');
}

const { chromium } = loadPlaywright();
const cookie = readFileSync(join(RUN, 'cookie'), 'utf8').trim();
const shots = join(RUN, 'shots');
mkdirSync(shots, { recursive: true });

const init = { view: null, layers: null, size: { width: 1400, height: 900 } };
const errors = [];
let browser;
let page;

async function ensurePage() {
  if (page) return page;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: init.size });
  await ctx.addCookies([{ name: 'elvis_session', value: cookie, url: WEB }]);
  await ctx.addInitScript(({ view, layers }) => {
    if (view) localStorage.setItem('elvis.map.view', JSON.stringify(view));
    if (layers) localStorage.setItem('elvis.map.layers', JSON.stringify(layers));
  }, init);
  page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  return page;
}

async function run(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = line.trim().slice(cmd.length).trim();
  switch (cmd) {
    case 'view':
      init.view = { lat: Number(rest[0]), lon: Number(rest[1]), zoom: Number(rest[2]) };
      return;
    case 'layers':
      init.layers = { aircraft: rest.includes('aircraft'), ships: rest.includes('ships') };
      return;
    case 'size':
      init.size = { width: Number(rest[0]), height: Number(rest[1]) };
      return;
  }
  const p = await ensurePage();
  switch (cmd) {
    case 'nav':
      await p.goto(WEB + arg);
      return;
    case 'wait':
      await p.waitForSelector(arg, { timeout: 30_000 });
      return;
    case 'waittext':
      await p.waitForFunction((t) => document.body.textContent?.includes(t), arg, { timeout: 40_000 });
      return;
    case 'gone':
      await p.waitForFunction((t) => !document.body.textContent?.includes(t), arg, { timeout: 40_000 });
      return;
    case 'click':
      await p.click(arg);
      return;
    case 'clickcenter': {
      const { width, height } = init.size;
      const all = p.locator(arg);
      const pts = await all.evaluateAll((els, c) => els.map((e) => { const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; return { x, y, d: Math.hypot(x - c.x, y - c.y) }; }), { x: width / 2 + 125, y: height / 2 + 30 });
      if (!pts.length) throw new Error(`kein Element für ${arg}`);
      // Mausklick auf die Stelle: überlappende Marker (Hafen) würden Playwrights Element-Klick blockieren
      const best = pts.reduce((a, b) => (b.d < a.d ? b : a));
      await p.mouse.click(best.x, best.y);
      return;
    }
    case 'fill': {
      const [sel, text] = arg.split(/\s*\|\s*/);
      await p.fill(sel, text ?? '');
      return;
    }
    case 'press':
      await p.keyboard.press(arg);
      return;
    case 'sleep':
      await p.waitForTimeout(Number(arg));
      return;
    case 'text':
      console.log(`${arg}: ${(await p.textContent(arg))?.trim()}`);
      return;
    case 'count':
      console.log(`${arg}: ${await p.locator(arg).count()}`);
      return;
    case 'ss': {
      const file = join(shots, `${arg || 'screenshot'}.png`);
      await p.screenshot({ path: file });
      console.log(`screenshot ${file}`);
      return;
    }
    case 'errors':
      console.log(`errors: ${errors.length ? errors.join('\n') : 'keine'}`);
      return;
    default:
      throw new Error(`unbekannter Befehl: ${cmd}`);
  }
}

const rl = createInterface({ input: process.stdin });
try {
  for await (const line of rl) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    await run(line);
  }
} catch (err) {
  console.error(`FEHLER: ${err.message}`);
  if (page) await page.screenshot({ path: join(shots, 'fehler.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
}
