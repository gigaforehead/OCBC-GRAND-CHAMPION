/* OCBC TestSphere — Express backend */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const pixelmatch = require('pixelmatch');
const { PNG } = require('pngjs');
const { chromium, firefox, webkit } = require('playwright');

const app = express();
app.use(express.json());

const RUNS_DIR = path.join(__dirname, 'runs');
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR);

const state = {
  runs: {} // runId -> { id, url, status, createdAt, results: { [browser]: { screenshot, ok } }, diffs: { [browser]: { against, diffPath, mismatchPct } } }
};

// Serve dashboard
app.use('/dashboard', express.static(path.join(__dirname, 'web')));
// Serve generated artifacts
app.use('/artifacts', express.static(RUNS_DIR));

// API: list runs (newest first)
app.get('/api/runs', (req, res) => {
  const arr = Object.values(state.runs).sort((a,b) => b.createdAt - a.createdAt);
  res.json(arr);
});

// API: get run by id
app.get('/api/run/:id', (req, res) => {
  const run = state.runs[req.params.id];
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json(run);
});

// API: trigger a run
app.post('/api/run', async (req, res) => {
  const url = (req.body && req.body.url) || '';
  if (!/^https?:\/\//i.test(url) && !/^\//.test(url)) {
    return res.status(400).json({ error: 'Provide a valid http(s) URL (or a path served by this server).' });
  }

  const id = uuidv4();
  const run = {
    id,
    url,
    status: 'queued',
    createdAt: Date.now(),
    results: {},
    diffs: {},
    note: 'Baseline: chromium. Diff: firefox & webkit vs chromium.'
  };
  state.runs[id] = run;
  res.json({ id, status: run.status });

  // fire and forget
  run.status = 'running';
  try {
    const dir = path.join(RUNS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });

    const targets = [
      { name: 'chromium', launcher: chromium },
      { name: 'firefox', launcher: firefox },
      { name: 'webkit', launcher: webkit }
    ];

    const viewport = { width: 1280, height: 800 };
    // Take screenshots per browser
    for (const t of targets) {
      const browser = await t.launcher.launch();
      const ctx = await browser.newContext({ viewport });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      // small settle wait for animations
      await page.waitForTimeout(500);
      const outPath = path.join(dir, `${t.name}.png`);
      await page.screenshot({ path: outPath, fullPage: true });
      await browser.close();
      run.results[t.name] = { screenshot: `/artifacts/${id}/${t.name}.png`, ok: true };
    }

    // Diff firefox and webkit against chromium
    const baseline = PNG.sync.read(fs.readFileSync(path.join(dir, 'chromium.png')));
    const baselineArea = baseline.width * baseline.height;
    for (const target of ['firefox', 'webkit']) {
      const targetPng = PNG.sync.read(fs.readFileSync(path.join(dir, `${target}.png`)));
      const { width, height } = baseline;
      // Resize mismatch guard
      if (targetPng.width !== width || targetPng.height !== height) {
        run.diffs[target] = { against: 'chromium', diffPath: null, mismatchPct: 100, note: 'Size differs' };
        continue;
        }
      const diff = new PNG({ width, height });
      const mismatched = pixelmatch(baseline.data, targetPng.data, diff.data, width, height, { threshold: 0.1 });
      const diffPath = path.join(dir, `${target}-vs-chromium-diff.png`);
      fs.writeFileSync(diffPath, PNG.sync.write(diff));
      const mismatchPct = Math.round((mismatched / baselineArea) * 10000) / 100; // 2 dp
      run.diffs[target] = { against: 'chromium', diffPath: `/artifacts/${id}/${target}-vs-chromium-diff.png`, mismatchPct };
    }

    run.status = 'done';
  } catch (e) {
    run.status = 'error';
    run.error = (e && e.message) || String(e);
    console.error('[run error]', e);
  }
});

// Healthcheck
app.get('/api/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`OCBC TestSphere backend on http://localhost:${port}`);
  console.log(`Open dashboard: http://localhost:${port}/dashboard`);
});
