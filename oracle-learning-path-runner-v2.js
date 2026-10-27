import { chromium } from 'playwright';

const LEARNING_PATH_URL = 'https://mylearn.oracle.com/ou/learning-path/become-an-oci-architect-associate/162234';
const PROFILE_DIR = new URL('./.oracle-playwright-profile/', import.meta.url).pathname;
const START_WAIT_MS = Number(process.env.START_WAIT_MS ?? 1000);
const LOAD_TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_MS ?? 90000);
const COMPLETION_TIMEOUT_MS = Number(process.env.COMPLETION_TIMEOUT_MS ?? 15000);
const SKIP_LESSON = /skill\s*check|practice\s*exam|certification\s*exam|assignment|quiz|assessment|\btest\b/i;
const SKIP_PATH_MODULE = /lab|practice\s*exam|online certification exam/i;

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1440, height: 950 },
  args: ['--autoplay-policy=no-user-gesture-required'],
});

try {
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
    const lessons = (await readPlaylist(page)).filter((item) => item.duration && !SKIP_LESSON.test(item.title));
    const pending = lessons.filter((item) => !item.completed);
    console.log(`Timed lessons: ${lessons.length}; already complete: ${lessons.length - pending.length}; to process: ${pending.length}.`);
    if (!pending.length) continue;

    // A course with timed video rows has a Brightcove player. Content-link
    // modules (for example Exam Topics) have no timed video rows and are skipped.
    await page.waitForSelector('video.vjs-tech', { timeout: LOAD_TIMEOUT_MS });
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
  console.error(`Runner stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  await context.close();
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
  const beforeId = await video.getAttribute('data-video-id').catch(() => null);
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
