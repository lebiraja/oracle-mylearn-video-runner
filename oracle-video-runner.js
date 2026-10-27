import { chromium } from 'playwright';

const COURSE_URL = 'https://mylearn.oracle.com/ou/course/oracle-cloud-infrastructure-architect-associate/161028/216197';
const START_ITEM_ID = process.env.START_ITEM_ID ?? '216197'; // Module 5: Networking - Virtual Cloud Network
const PROFILE_DIR = new URL('./.oracle-playwright-profile/', import.meta.url).pathname;
const START_WAIT_MS = Number(process.env.START_WAIT_MS ?? 1000);
const LOAD_TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_MS ?? 90000);
const COMPLETION_TIMEOUT_MS = Number(process.env.COMPLETION_TIMEOUT_MS ?? 15000);
const EXCLUDED = /skill\s*check|assignment|quiz|exam|assessment/i;

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1440, height: 950 },
  args: ['--autoplay-policy=no-user-gesture-required'],
});

try {
  const page = context.pages()[0] ?? await context.newPage();
  console.log(`Opening course: ${COURSE_URL}`);
  await page.goto(COURSE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('Waiting for the signed-in course playlist and video player...');
  await page.waitForSelector('li.playlistComponent', { timeout: LOAD_TIMEOUT_MS });
  await page.waitForSelector('video.vjs-tech', { timeout: LOAD_TIMEOUT_MS });
  await page.waitForFunction(() => {
    const video = document.querySelector('video.vjs-tech');
    return video && video.duration > 0 && video.readyState >= 2;
  }, { timeout: LOAD_TIMEOUT_MS });

  // Disable the site's own autoplay so it cannot enter a quiz between videos.
  const autoplay = page.getByRole('checkbox', { name: /auto play/i });
  if (await autoplay.count().catch(() => 0) && await autoplay.isChecked().catch(() => false)) {
    await autoplay.uncheck().catch(() => {});
  }

  const rows = await readPlaylist(page);
  const startIndex = rows.findIndex((row) => row.href.endsWith(`/${START_ITEM_ID}`));
  if (startIndex < 0) throw new Error(`Start row ${START_ITEM_ID} was not found in the playlist.`);
  const fromStart = rows.slice(startIndex);
  const videos = fromStart.filter((row) => row.duration && !EXCLUDED.test(row.title));
  const pending = videos.filter((row) => !row.completed);
  console.log(`Playlist rows: ${rows.length}; videos from start: ${videos.length}; already complete: ${videos.length - pending.length}; to process: ${pending.length}.`);

  let completed = 0;
  let failures = 0;
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    process.stdout.write(`[${i + 1}/${pending.length}] ${item.title} (${item.duration}) ... `);
    try {
      await finishVideo(page, item);
      completed++;
      console.log('green tick confirmed');
    } catch (error) {
      failures++;
      console.log(`could not confirm (${error.message.split('\n')[0]})`);
    }
    if ((i + 1) % 10 === 0) {
      console.log(`Progress: ${completed} confirmed, ${failures} errors.`);
    }
  }

  const remaining = (await readPlaylist(page)).slice(startIndex).filter((row) =>
    row.duration && !row.completed && !EXCLUDED.test(row.title)
  );
  console.log(`\nFinished. Confirmed ${completed}; errors ${failures}; unfinished video rows from module 5: ${remaining.length}.`);
  if (remaining.length) console.log('Unfinished rows:', remaining.map((row) => row.title).join(' | '));
  console.log('Browser remains open for your review. Press Ctrl+C in this terminal when done.');
  await new Promise(() => {});
} catch (error) {
  console.error(`Runner stopped: ${error.message}`);
  process.exitCode = 1;
  await context.close();
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
  }).filter((row) => row.title && row.href));
}

async function finishVideo(page, item) {
  const video = page.locator('video.vjs-tech');
  const beforeId = await video.getAttribute('data-video-id').catch(() => null);
  const beforeTitle = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return text.match(/Now Playing:\s*(.*)/i)?.[1]?.trim() || '';
  });

  await page.locator(`a[href="${item.href}"]`).click({ timeout: 15000 });
  await page.waitForFunction(({ title, beforeId, beforeTitle }) => {
    const player = document.querySelector('video.vjs-tech');
    if (!player || player.duration <= 0 || player.readyState < 2) return false;
    const body = (document.body?.innerText || '').replace(/\s+/g, '').toLowerCase();
    const expectedNowPlaying = `nowplaying:${title}`.replace(/\s+/g, '').toLowerCase();
    const titleVisible = body.includes(expectedNowPlaying);
    const identityChanged = player.getAttribute('data-video-id') !== beforeId;
    const sameTitle = title.replace(/\s+/g, '').toLowerCase() === beforeTitle.replace(/\s+/g, '').toLowerCase();
    return titleVisible && (identityChanged || !sameTitle);
  }, { title: item.title, beforeId, beforeTitle }, { timeout: 25000 });

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
    const link = document.querySelector(`a[href="${href}"]`);
    return Boolean(link?.closest('li.playlistComponent')?.querySelector('.playListComplete, [title="Completed"]'));
  }, item.href, { timeout: COMPLETION_TIMEOUT_MS });
}
