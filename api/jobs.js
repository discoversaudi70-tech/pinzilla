// PinForge Jobs API
// Uses /tmp file storage — persists across warm instances in same region
// Falls back to global memory if file ops fail

const fs   = require('fs');
const path = require('path');

const STORE_FILE = '/tmp/pf_jobs.json';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-PinForge-Extension',
};

// ─── PERSISTENT STORE ─────────────────────────────────────────
function readStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      return { jobs: data.jobs || [], extTs: data.extTs || 0 };
    }
  } catch {}
  if (!global._pf) global._pf = { jobs: [], extTs: 0 };
  return global._pf;
}

function writeStore(store) {
  try { fs.writeFileSync(STORE_FILE, JSON.stringify(store)); } catch {}
  global._pf = store; // also keep in memory as backup
}

module.exports = function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  if (req.headers['x-pinforge-extension']) {
    const store = readStore();
    store.extTs = Date.now();
    writeStore(store);
  }

  const { action } = req.query;
  const store = readStore();

  // ── PING ────────────────────────────────────────────────────
  if (action === 'ping') {
    res.json({
      pinforge: true,
      extensionOnline: Date.now() - (store.extTs || 0) < 30000,
      pending: store.jobs.filter(j => j.status === 'pending').length,
      working: store.jobs.filter(j => j.status === 'working').length,
      total:   store.jobs.length,
    });
    return;
  }

  // ── QUEUE ────────────────────────────────────────────────────
  if (action === 'queue') {
    res.json({ jobs: store.jobs.slice(-100).map(j => ({ id: j.id, url: j.url, status: j.status, error: j.error || null })) });
    return;
  }

  // ── NEXT ────────────────────────────────────────────────────
  if (action === 'next' && req.method === 'GET') {
    store.jobs.forEach(j => {
      if (j.status === 'working' && Date.now() - new Date(j.startedAt || 0).getTime() > 360000) {
        j.status = 'error'; j.error = 'Timed out';
      }
    });
    const busy = store.jobs.find(j => j.status === 'working');
    if (busy) { writeStore(store); res.json({ job: null }); return; }
    const next = store.jobs.find(j => j.status === 'pending');
    if (!next) { writeStore(store); res.json({ job: null }); return; }
    next.status = 'working'; next.startedAt = new Date().toISOString();
    writeStore(store);
    res.json({ job: { id: next.id, url: next.url, prompt: next.prompt, provider: next.provider } });
    return;
  }

  // ── ENQUEUE ──────────────────────────────────────────────────
  if (action === 'enqueue' && req.method === 'POST') {
    const body = req.body || {};
    const incoming = body.jobs || [];
    if (!Array.isArray(incoming)) { res.status(400).json({ error: 'jobs must be array' }); return; }
    let added = 0;
    for (const j of incoming) {
      if (!j.id || !j.prompt) continue;
      if (store.jobs.find(x => x.id === j.id)) continue;
      store.jobs.push({ id: j.id, url: j.url || '', prompt: j.prompt, provider: j.provider || 'claude',
        status: 'pending', result: null, error: null, createdAt: new Date().toISOString(), startedAt: null });
      added++;
    }
    writeStore(store);
    res.json({ ok: true, added, total: store.jobs.length });
    return;
  }

  // ── COMPLETE ─────────────────────────────────────────────────
  if (action === 'complete' && req.method === 'POST') {
    const body = req.body || {};
    const { jobId, result } = body;
    if (!jobId) { res.status(400).json({ error: 'Missing jobId' }); return; }
    let job = store.jobs.find(j => j.id === jobId);
    if (!job) {
      job = { id: jobId, url: '', prompt: '', provider: '', status: 'pending', result: null, error: null, createdAt: new Date().toISOString(), startedAt: null };
      store.jobs.push(job);
    }
    job.status = 'done'; job.result = result; job.completedAt = new Date().toISOString();
    writeStore(store);
    res.json({ ok: true });
    return;
  }

  // ── FAIL ─────────────────────────────────────────────────────
  if (action === 'fail' && req.method === 'POST') {
    const body = req.body || {};
    const { jobId, error } = body;
    if (!jobId) { res.status(400).json({ error: 'Missing jobId' }); return; }
    let job = store.jobs.find(j => j.id === jobId);
    if (!job) {
      job = { id: jobId, url: '', prompt: '', provider: '', status: 'pending', result: null, error: null, createdAt: new Date().toISOString(), startedAt: null };
      store.jobs.push(job);
    }
    job.status = 'error'; job.error = error;
    writeStore(store);
    res.json({ ok: true });
    return;
  }

  // ── RESULTS ──────────────────────────────────────────────────
  if (action === 'results' && req.method === 'GET') {
    res.json({
      results: store.jobs
        .filter(j => j.status === 'done' || j.status === 'error')
        .map(j => ({ id: j.id, status: j.status, result: j.result, error: j.error }))
    });
    return;
  }

  // ── DOWNLOAD ─────────────────────────────────────────────────
  if (action === 'download' && req.method === 'GET') {
    res.json({ jobs: store.jobs.filter(j => j.status === 'pending') });
    return;
  }

  // ── CLEAR ────────────────────────────────────────────────────
  if (action === 'clear' && req.method === 'POST') {
    const body = req.body || {};
    const { ids } = body;
    if (Array.isArray(ids)) store.jobs = store.jobs.filter(j => !ids.includes(j.id));
    writeStore(store);
    res.json({ ok: true, remaining: store.jobs.length });
    return;
  }

  // ── RESET ────────────────────────────────────────────────────
  if (action === 'reset' && req.method === 'POST') {
    store.jobs = [];
    writeStore(store);
    res.json({ ok: true });
    return;
  }

  res.status(400).json({ error: 'Unknown action: ' + action });
};
