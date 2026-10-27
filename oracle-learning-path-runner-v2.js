import { chromium } from 'playwright';
import { open, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEARNING_PATH_URL = 'https://mylearn.oracle.com/ou/learning-path/become-an-oci-architect-associate/162234';
// URL.pathname is percent-encoded and starts with `/C:/...` on Windows.
// Convert the module URL to a native filesystem path so Chromium can create it.
const PROFILE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '.oracle-playwright-profile');
const RUNNER_LOCK = resolve(dirname(PROFILE_DIR), '.oracle-playwright-runner.lock');
const START_WAIT_MS = Number(process.env.START_WAIT_MS ?? 1000);
const LOAD_TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_MS ?? 90000);
const COMPLETION_TIMEOUT_MS = Number(process.env.COMPLETION_TIMEOUT_MS ?? 15000);
const SKIP_LESSON = /skill\s*check|practice\s*exam|certification\s*exam|assignment|quiz|assessment|\btest\b/i;
const SKIP_PATH_MODULE = /practice\s*exam|online certification exam/i;

let releaseRunnerLock;
let context;
try {
  releaseRunnerLock = await acquireRunnerLock();
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1440, height: 950 },
    args: ['--autoplay-policy=no-user-gesture-required'],
  });

  const page = context.pages()[0] ?? await context.newPage();
  console.log(`Opening learning path: ${LEARNING_PATH_URL}`);
  await page.goto(LEARNING_PATH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => /Become an OCI Architect Associate/.test(document.body?.innerText || ''), { timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    return /Oracle Cloud Infrastructure Architect Associate/.test(text)
      && /Prepare for Certification/.test(text)
      && Boolean(document.querySelector('[id*="course-"][id*="Label-"]'))
      && Boolean(document.querySelector('[id*="module-"][id*="Label-"]'));
  }, { timeout: LOAD_TIMEOUT_MS });

  const targets = await readPathTargets(page);
  console.log(`Found ${targets.length} eligible course/module pages:`);
  targets.forEach((target, i) => console.log(`  ${i + 1}. ${target.label}`));
  if (!targets.length) throw new Error('No video-capable course/module targets found on the learning path.');

  let totalCompleted = 0;
  let totalFailed = 0;
  for (const target of targets) {
    const targetUrl = target.kind === 'course'
      ? target.href
      : await openPathModule(page, target);
    console.log(`\n=== ${target.label} ===`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('li.playlistComponent', { timeout: LOAD_TIMEOUT_MS });
    // MyLearn renders playlist titles before it hydrates per-lesson progress.
    // Give the progress API time to populate green ticks before deciding what
    // is still pending; otherwise a resumed run would replay completed videos.
    await page.waitForTimeout(5000);

    // Some course/module pages contain reading links instead of videos. Only
    // rows with a lesson duration are candidates; interactive assessments are
    // excluded by name above.
    const lessonByHref = new Map();
    for (const item of await readPlaylist(page)) {
      if (item.duration && item.duration !== '0m' && !SKIP_LESSON.test(item.title) && !lessonByHref.has(item.href)) {
        lessonByHref.set(item.href, item);
      }
    }
    const lessons = [...lessonByHref.values()];
    const pending = lessons.filter((item) => !item.completed);
    console.log(`Timed lessons: ${lessons.length}; already complete: ${lessons.length - pending.length}; to process: ${pending.length}.`);
    if (!pending.length) continue;

    // Content-link modules (for example Exam Topics) have no timed video rows
    // and are skipped. The video player can appear only after selecting a row.
    await disableAutoplay(page);
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      process.stdout.write(`[${i + 1}/${pending.length}] ${item.title} (${item.duration}) ... `);
      try {
        await finishVideo(page, item);
        totalCompleted++;
        console.log('green tick confirmed');
      } catch (error) {
        totalFailed++;
        console.log(`could not confirm (${error.message.split('\n')[0]})`);
      }
    }
  }

  console.log(`\nLearning path scan finished. Green ticks confirmed: ${totalCompleted}; errors: ${totalFailed}.`);
  console.log('The runner did not open lab, practice exam, skill-check, or certification-exam items.');
} catch (error) {
  const message = error.message || String(error);
  if (/ProcessSingleton|profile directory|user data directory|already in use/i.test(message)) {
    console.error('Chromium could not open the runner profile. Close any other Oracle video runner window/process, then try again. Your regular Chrome/Edge windows use a separate profile and can stay open.');
  } else {
    console.error(`Runner stopped: ${message}`);
  }
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  await releaseRunnerLock?.();
}

async function acquireRunnerLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(RUNNER_LOCK, 'wx');
      await handle.writeFile(String(process.pid));
      return async () => {
        await handle.close().catch(() => {});
        await unlink(RUNNER_LOCK).catch(() => {});
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let ownerText = (await readFile(RUNNER_LOCK, 'utf8').catch(() => '')).trim();
      if (!ownerText) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        ownerText = (await readFile(RUNNER_LOCK, 'utf8').catch(() => '')).trim();
      }
      const ownerPid = Number(ownerText);
      if (ownerPid && isProcessRunning(ownerPid)) {
        throw new Error(`Another runner instance (PID ${ownerPid}) is already using the saved browser profile.`);
      }
      if (!ownerText || !Number.isInteger(ownerPid)) {
        throw new Error('The runner lock file exists but its owner could not be read. Wait a moment and retry.');
      }
      // A hard exit can leave the small runner lock behind. Reclaim it when
      // its recorded process is no longer running; Chromium still protects
      // the actual profile directory itself.
      await unlink(RUNNER_LOCK).catch(() => {});
    }
  }
  throw new Error('Could not acquire the runner lock. Check for another runner process and retry.');
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readPathTargets(page) {
  return page.evaluate((skipModules) => {
    const skip = new RegExp(skipModules, 'i');
    const targets = [];
    const seen = new Set();
    // The Course card itself also contains a "Lab" badge, so identify it by
    // the course card/link type rather than excluding links whose full card
    // text mentions a lab.
    const courseLinks = [...document.querySelectorAll('a[href*="/ou/course/"]')]
      .filter((a) => /Course/i.test(a.innerText || ''));
    for (const link of courseLinks) {
      const href = new URL(link.getAttribute('href'), location.href).href;
      if (seen.has(href)) continue;
      seen.add(href);
      targets.push({ kind: 'course', label: (link.innerText || '').replace(/\s+/g, ' ').trim().split(/\s{2,}/)[0] || 'Course', href });
    }

    for (const label of document.querySelectorAll('[id*="module-"][id*="Label-"]')) {
      const name = (label.innerText || '').replace(/\s+/g, ' ').trim();
      const id = label.id.match(/Label-(\d+)$/)?.[1];
      if (!name || !id || skip.test(name)) continue;
      const key = `module:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ kind: 'module', id, label: name });
    }
    return targets;
  }, SKIP_PATH_MODULE.source);
}

async function openPathModule(page, target) {
  // Return to the learning-path overview before opening each module card.
  await page.goto(LEARNING_PATH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction((id) => Boolean(document.querySelector(`[id$="Label-${id}"]`)), target.id, { timeout: LOAD_TIMEOUT_MS });
  const previousUrl = page.url();
  const label = page.locator(`[id$="Label-${target.id}"]`).first();
  const card = label.locator('xpath=ancestor::*[@tabindex="0"][1]');
  await card.click({ timeout: 15000 });
  await page.waitForFunction((oldUrl) => location.href !== oldUrl && location.pathname.includes('/ou/course/'), previousUrl, { timeout: 25000 });
  return page.url();
}

async function readPlaylist(page) {
  return page.locator('li.playlistComponent').evaluateAll((elements) => elements.map((row) => {
    const link = row.querySelector('a.playlist-component-href, a[href]');
    const title = link?.getAttribute('title')?.trim() || '';
    const text = (row.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      title,
      href: link?.getAttribute('href') || '',
      duration: text.match(/\b\d{1,2}m\b/)?.[0] || '',
      completed: Boolean(row.querySelector('.playListComplete, [title="Completed"]')),
    };
  }).filter((item) => item.title && item.href));
}

async function disableAutoplay(page) {
  const autoplay = page.getByRole('checkbox', { name: /auto play/i });
  if (await autoplay.count().catch(() => 0) && await autoplay.isChecked().catch(() => false)) {
    await autoplay.uncheck().catch(() => {});
  }
}

async function finishVideo(page, item) {
  const video = page.locator('video.vjs-tech');
  const beforeId = await page.evaluate(() => document.querySelector('video.vjs-tech')?.getAttribute('data-video-id') || null);
  const beforeTitle = await page.evaluate(() => (document.body?.innerText || '').match(/Now Playing:\s*(.*)/i)?.[1]?.trim() || '');
  const currentRow = await page.locator(`a.playlist-component-href[href="${item.href}"]`).first().evaluate((a) =>
    Boolean(a.closest('li.playlistComponent')?.querySelector('.playListInprogress'))
  ).catch(() => false);
  const titleIsCurrent = normalize(beforeTitle) === normalize(item.title);

  if (!(currentRow && titleIsCurrent)) {
    await page.locator(`a.playlist-component-href[href="${item.href}"]`).first().click({ timeout: 15000 });
  }
  await page.waitForFunction(({ title, beforeId, beforeTitle, currentRow }) => {
    const player = document.querySelector('video.vjs-tech');
    if (!player || player.duration <= 0 || player.readyState < 2) return false;
    const body = (document.body?.innerText || '').replace(/\s+/g, '').toLowerCase();
    const expectedNowPlaying = `nowplaying:${title}`.replace(/\s+/g, '').toLowerCase();
    if (!body.includes(expectedNowPlaying)) return false;
    const identityChanged = player.getAttribute('data-video-id') !== beforeId;
    const sameTitle = title.replace(/\s+/g, '').toLowerCase() === beforeTitle.replace(/\s+/g, '').toLowerCase();
    return identityChanged || !sameTitle || currentRow;
  }, { title: item.title, beforeId, beforeTitle, currentRow }, { timeout: 25000 });

  await video.evaluate(async (player, delay) => {
    player.muted = true;
    await player.play();
    await new Promise((resolve) => setTimeout(resolve, delay));
    player.currentTime = Math.max(0, player.duration - 0.25);
    await player.play();
  }, START_WAIT_MS);
  await page.waitForFunction(() => {
    const player = document.querySelector('video.vjs-tech');
    return player && (player.ended || player.currentTime >= player.duration - 0.5);
  }, { timeout: 18000 });
  await page.waitForFunction((href) => {
    const link = [...document.querySelectorAll('a.playlist-component-href')].find((a) => a.getAttribute('href') === href);
    return Boolean(link?.closest('li.playlistComponent')?.querySelector('.playListComplete, [title="Completed"]'));
  }, item.href, { timeout: COMPLETION_TIMEOUT_MS });
}

function normalize(text) {
  return (text || '').replace(/\s+/g, '').toLowerCase();
}
