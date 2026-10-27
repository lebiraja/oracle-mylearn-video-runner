# Oracle MyLearn learning-path video runner

This Playwright helper opens the **Become an OCI Architect Associate** learning path and progresses through unfinished timed video lessons in its course and eligible modules. It uses the visible Oracle MyLearn player, waits briefly for playback, seeks near the end, then waits for the lesson's green completion tick before moving on.

## What it handles

- The Oracle Cloud Infrastructure Architect Associate course and its timed video lessons
- Timed video lessons in the **Oracle University Lab** and **Prepare for Certification**, including Sample Exam Questions
- Existing green ticks are checked and completed lessons are skipped

It leaves the Practice Exam, skill checks, quizzes, assignments, assessments, certification exams, and other non-video content for you. It only processes playlist rows with a positive lesson duration and a Brightcove video player; the Lab's 0-minute activity guide is therefore left alone. In this learning path, Exam Topics is presented as a content link, so it is not treated as a video.

> Seeking to the end records course progress without watching the lesson. Use this only where permitted by your course and account rules. The runner does not take or complete assessments.

## Requirements

- Node.js 20 or newer
- An Oracle MyLearn account with access to this learning path
- Playwright's Chromium browser (installed by the command below)

The runner supports Windows, macOS, and Linux. Use PowerShell or Command Prompt on Windows, or Terminal on macOS/Linux.

## Run

```text
git clone https://github.com/lebiraja/oracle-mylearn-video-runner.git
cd oracle-mylearn-video-runner
npm install
npx playwright install chromium
npm start
```

A visible browser opens. Sign in to Oracle if prompted; the runner waits for the learning path and starts automatically. Keep the terminal open to see progress. It closes its browser when done. If interrupted, run `npm start` again; Oracle's saved green ticks let it skip completed videos.

## Options

Each video plays for one second before seeking close to the end. You can change the wait and timeouts:

PowerShell:

```powershell
$env:START_WAIT_MS = "1000"; $env:LOAD_TIMEOUT_MS = "120000"; $env:COMPLETION_TIMEOUT_MS = "20000"; npm start
```

Command Prompt:

```bat
set START_WAIT_MS=1000 && set LOAD_TIMEOUT_MS=120000 && set COMPLETION_TIMEOUT_MS=20000 && npm start
```

macOS/Linux:

```sh
START_WAIT_MS=1000 LOAD_TIMEOUT_MS=120000 COMPLETION_TIMEOUT_MS=20000 npm start
```

- `START_WAIT_MS`: playback time before seeking (default `1000`)
- `LOAD_TIMEOUT_MS`: wait for the learning path, playlist, and player (default `90000`)
- `COMPLETION_TIMEOUT_MS`: wait for Oracle's completion tick (default `15000`)

## Privacy and troubleshooting

Oracle login cookies and browser state stay in `.oracle-playwright-profile/` on your computer. The runner resolves this folder as a native path on Windows, macOS, and Linux. That folder is ignored by Git; never upload or share it. Each person should clone the repo and sign in with their own Oracle account.

- **It waits for the learning path:** finish signing in and wait for the path page to load.
- **Chromium is missing:** run `npx playwright install chromium`.
- **Some lessons fail:** the terminal reports rows without a confirmed green tick. Rerun after the browser closes to retry unfinished videos.
- **MyLearn changed:** this helper relies on MyLearn playlist and Brightcove player markup, which may change over time.
