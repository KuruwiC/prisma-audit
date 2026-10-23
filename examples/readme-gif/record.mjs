/** Needs ffmpeg on PATH and a Playwright Chromium (`pnpm exec playwright install chromium`) */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const FPS = 20;
const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, 'out', 'prisma-audit-demo.gif');
const preview = process.argv.includes('--preview');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, 'stage.html')).href);
await page.evaluate(() => window.__ready);
const duration = await page.evaluate(() => window.__duration);

const frames = mkdtempSync(join(tmpdir(), 'prisma-audit-gif-'));
try {
  if (preview) {
    const moments = await page.evaluate(() =>
      [...document.querySelectorAll('#scene-tabs span')].map((tab) => tab.textContent),
    );
    let at = 0;
    for (const [index, name] of moments.entries()) {
      const sceneDuration = await page.evaluate((i) => window.__sceneDuration(i), index);
      await page.evaluate((t) => window.__seek(t), at + sceneDuration - 400);
      const file = join(here, `preview-${index + 1}.png`);
      await page.screenshot({ path: file });
      console.log(`${name}: ${file}`);
      at += sceneDuration;
    }
  } else {
    const count = Math.round((duration / 1000) * FPS);
    for (let i = 0; i < count; i += 1) {
      await page.evaluate((t) => window.__seek(t), (i * 1000) / FPS);
      await page.screenshot({ path: join(frames, `${String(i).padStart(4, '0')}.png`) });
    }
    mkdirSync(dirname(output), { recursive: true });
    // One palette for the whole loop, dithered lightly so the dark surfaces stay flat
    execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-y',
      '-framerate',
      String(FPS),
      '-i',
      join(frames, '%04d.png'),
      '-filter_complex',
      'split[a][b];[a]palettegen=max_colors=96:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
      '-loop',
      '0',
      output,
    ]);
    console.log(`${count} frames, ${(statSync(output).size / 1024 / 1024).toFixed(2)} MB: ${output}`);
  }
} finally {
  rmSync(frames, { recursive: true, force: true });
  await browser.close();
}
