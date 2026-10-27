# Oracle MyLearn video runner

A small Playwright script for progressing through the video lessons in the Oracle University course **Oracle Cloud Infrastructure Architect Associate**. It opens a visible browser, waits for the course playlist and player, then handles unfinished videos in playlist order.

The default starting point is **5. Networking - Virtual Cloud Network**. The runner skips lessons that already have Oracle's green completion tick. It ignores skill checks, quizzes, exams, assessments, and assignments, and disables the site's Auto Play control so it does not advance into those items on its own.

> Seeking to the end records course progress without watching the lesson. Use this only where permitted by your course and account rules. This tool does not take or complete assessments.

## Requirements

- Node.js 20 or newer
- An Oracle MyLearn account with access to the course
- Google Chrome or Chromium

## Quick start

```sh
git clone https://github.com/lebiraja/oracle-mylearn-video-runner.git
cd oracle-mylearn-video-runner
npm install
npx playwright install chromium
npm start
```

The first run opens a browser. Sign in to Oracle there if asked; the runner waits for the course playlist and video player, then starts automatically. Keep the terminal open to see progress. Stop it with **Ctrl+C** after it finishes. The browser profile is stored locally in `.oracle-playwright-profile/` so you usually do not need to sign in again.

## Change the starting lesson

By default, processing starts at the module 5 **Module Overview**. To start at another lesson, use the numeric content ID at the end of that lesson's playlist link:

```sh
START_ITEM_ID=205167 npm start
```

The runner includes that lesson if it is an unfinished video. It skips completed lessons before and after the starting point.

## Timing options

The script starts each video, waits one second, seeks close to its end, and waits for Oracle to show the green tick. You can adjust these values:

```sh
START_WAIT_MS=1000 LOAD_TIMEOUT_MS=120000 COMPLETION_TIMEOUT_MS=20000 npm start
```

- `START_WAIT_MS`: playback time before seeking (default `1000`)
- `LOAD_TIMEOUT_MS`: wait for the signed-in playlist and player (default `90000`)
- `COMPLETION_TIMEOUT_MS`: wait for Oracle's completion tick (default `15000`)

## Privacy

Login cookies and browser state stay in `.oracle-playwright-profile/` on your computer. That folder is ignored by Git; do not upload or share it. The script does not send course information to a classifier or other external service.

## Troubleshooting

- **It waits for the playlist:** finish signing in and wait for the course player to appear in the browser.
- **Chromium is missing:** run `npx playwright install chromium`.
- **Some lessons fail:** the terminal reports which rows did not get a confirmed green tick. MyLearn can change its page markup or player behavior; review those rows and rerun the script to retry unfinished videos.
- **Need to restart:** stop with Ctrl+C and run `npm start` again. Completed rows are skipped on the next run.
