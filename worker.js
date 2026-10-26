/* Hans AI Coder - Cloudflare Worker v3 (many free AIs, automatic fallback, faster, build checking).
   It keeps your secret keys, tries your free AIs one after another, reads your GitHub repo, and pushes ONLY after you approve in the app.
   Required secrets: APP_PASSCODE, GITHUB_TOKEN, and at least one AI key (GEMINI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY ...).
   See the README for the full list. */

const GH = 'https://api.github.com';
const MAX_MODEL_CALLS = 10;      // AI answers in one message (each may use tools)
const MAX_REQUESTS = 44;         // the free Cloudflare plan allows 50 outside requests per call, so we stay below that
const MAX_CHARS = 60000;         // most of a file the AI reads in one go
const PER_PROVIDER = 3;          // models tried per provider before moving on
const MAX_ATTEMPTS = 8;          // model tries for one AI answer

/* The free AI providers, fastest first. A provider is used only when its key is set. */
const PROVIDERS = [
  { id: 'groq', base: 'https://api.groq.com/openai/v1', key: 'GROQ_API_KEY', fb: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'] },
  { id: 'cerebras', base: 'https://api.cerebras.ai/v1', key: 'CEREBRAS_API_KEY', fb: ['gpt-oss-120b', 'llama-3.3-70b'] },
  { id: 'gemini', kind: 'gemini', key: 'GEMINI_API_KEY', per: 4, vision: true },
  { id: 'mistral', base: 'https://api.mistral.ai/v1', key: 'MISTRAL_API_KEY', fb: ['codestral-latest', 'mistral-large-latest'] },
  { id: 'nvidia', base: 'https://integrate.api.nvidia.com/v1', key: 'NVIDIA_API_KEY', fb: [] },
  { id: 'openrouter', base: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY', freeOnly: true, fb: ['qwen/qwen3-coder:free', 'openai/gpt-oss-120b:free'] },
  { id: 'zai', base: 'https://api.z.ai/api/paas/v4', key: 'ZAI_API_KEY', only: /flash/i, fb: ['glm-4.7-flash', 'glm-4.5-flash'] },
  { id: 'ollama', base: 'https://ollama.com/v1', key: 'OLLAMA_API_KEY', fb: ['gpt-oss:120b'] },
  { id: 'hetzner', base: 'https://inference.hetzner.com/api/v1', key: 'HETZNER_API_KEY', fb: [] },
  { id: 'itera', base: 'https://api.iteracompute.com/v1', key: 'ITERACOMPUTE_API_KEY', fb: [] },
  { id: 'tokenharbor', base: 'https://tokenharbor.ai/v1', key: 'TOKENHARBOR_API_KEY', fb: [] },
  { id: 'modelscope', base: 'https://api-inference.modelscope.cn/v1', key: 'MODELSCOPE_API_KEY', fb: [] },
  { id: 'cloudflare', kind: 'cf', bind: 'AI', fb: ['@cf/openai/gpt-oss-120b', '@cf/qwen/qwen2.5-coder-32b-instruct', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'] }
];

/* Which models to prefer when a provider lists many. Earlier in the list is better for coding. */
const SKIP = /whisper|embed|guard|safeguard|tts|speech|audio|transcri|image|vision|-vl|vl-|ocr|rerank|moderat|diffusion|flux|video|translat|classif|reward/i;
const PREF = [/coder|codestral|devstral/i, /gpt-oss[-:]?120b/i, /kimi/i, /glm-?[3-9]/i, /deepseek/i, /qwen/i, /llama.*(70|405)b/i, /mistral-(large|medium)|magistral/i, /nemotron/i, /gpt-oss/i, /llama/i, /mistral|ministral/i, /gemma/i];

/* memory that lives while the Worker stays warm */
function addStep(ctx, text) { ctx.steps.push(text); if (ctx.emit) ctx.emit({ t: 'step', v: text }); }
const ST = globalThis.__HANS || (globalThis.__HANS = { cool: {}, cache: {} });

const TOOLS = [
  { name: 'list_files', description: 'List the files in the repository. Optional prefix to only list one folder.',
    parameters: { type: 'object', properties: { prefix: { type: 'string', description: 'Folder or path start, for example src/' } } } },
  { name: 'read_file', description: 'Read a file. For big files read part of it with from_line and to_line.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, from_line: { type: 'integer' }, to_line: { type: 'integer' } }, required: ['path'] } },
  { name: 'find_in_file', description: 'Find lines that contain some text in a file. Returns line numbers. Use it for big files.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] } },
  { name: 'list_workflow_runs', description: 'List the latest GitHub Actions builds (status and result) for the repository.',
    parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'How many runs, 1 to 10' } } } },
  { name: 'get_build_errors', description: 'Get the error lines from a failed GitHub Actions build. Without run_id it uses the latest failed build.',
    parameters: { type: 'object', properties: { run_id: { type: 'integer' } } } },
  { name: 'propose_changes', description: 'Propose code changes for the user to review. Nothing is pushed until the user approves. For an existing file prefer edits (find and replace). The find text must be copied exactly from the file and appear only once.',
    parameters: { type: 'object', properties: {
      summary: { type: 'string', description: 'One short sentence about what the change does' },
      changes: { type: 'array', items: { type: 'object', properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'Full new content. Use for new files or small files.' },
        edits: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] } },
        delete: { type: 'boolean' } }, required: ['path'] } } }, required: ['summary', 'changes'] } }
];

export default {
  async fetch(req, env, ectx) {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-app-pass,x-stream', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    try {
      if (!env.APP_PASSCODE) return reply({ error: 'The Worker has no APP_PASSCODE secret yet. Add it in Cloudflare.' }, 500, cors);
      if ((req.headers.get('x-app-pass') || '') !== env.APP_PASSCODE) return reply({ error: 'Wrong passcode' }, 401, cors);
      const url = new URL(req.url), path = url.pathname;
      const body = req.method === 'POST' ? await req.json() : {};
      const ctx = { env, n: 0, repo: body.repo || '', branch: body.branch || '', cache: {}, tree: null, proposal: null, steps: [], cur: null };
      if (path === '/ping') return reply(ping(env), 200, cors);
      if (path === '/repos') return reply(await listRepos(ctx), 200, cors);
      if (path === '/chat') return (req.headers.get('x-stream') === '1' || url.searchParams.get('stream') === '1') ? streamChat(ctx, body, cors, ectx) : reply(await chat(ctx, body), 200, cors);
      if (path === '/push') return reply(await push(ctx, body), 200, cors);
      return reply({ error: 'Not found' }, 404, cors);
    } catch (e) {
      return reply({ error: String((e && e.message) || e) }, 500, cors);
    }
  }
};

/* answers arrive as live lines: each step shows up while the AI is still working */
function streamChat(ctx, body, cors, ectx) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter(), te = new TextEncoder();
  const emit = o => { try { w.write(te.encode(JSON.stringify(o) + '\n')).catch(() => {}); } catch (e) {} };
  ctx.emit = emit; emit({ t: 'hello' });
  const job = chat(ctx, body)
    .then(r => emit(Object.assign({ t: 'done' }, r)), e => emit({ t: 'done', reply: 'Something went wrong: ' + String((e && e.message) || e), steps: ctx.steps, proposal: null, via: ctx.via || '' }))
    .then(() => w.close().catch(() => {}));
  if (ectx && ectx.waitUntil) ectx.waitUntil(job);
  return new Response(readable, { headers: Object.assign({ 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' }, cors) });
}
function reply(obj, status, cors) { return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json' }, cors) }); }
function ping(env) {
  const ps = activeProviders(env).map(p => p.id), now = Date.now();
  const cooling = Object.keys(ST.cool).filter(k => ST.cool[k] > now).map(k => ({ name: k.replace(/^p:/, ''), seconds: Math.round((ST.cool[k] - now) / 1000) }));
  return { ok: true, github: !!env.GITHUB_TOKEN, ai: ps.length > 0, providers: ps, cooling };
}

/* ---------------- GitHub ---------------- */
async function gh(ctx, path, opt) {
  if (!ctx.env.GITHUB_TOKEN) throw new Error('The Worker has no GITHUB_TOKEN secret yet.');
  if (++ctx.n > MAX_REQUESTS + 4) throw new Error('Too many steps in one request. Ask for a smaller task.');
  opt = opt || {};
  const r = await fetch(GH + path, {
    method: opt.method || 'GET',
    headers: { authorization: 'Bearer ' + ctx.env.GITHUB_TOKEN, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'hans-ai-coder', 'content-type': 'application/json' },
    body: opt.body ? JSON.stringify(opt.body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('GitHub ' + r.status + ': ' + (j.message || 'error')); e.status = r.status; throw e; }
  return j;
}
const enc = p => p.split('/').map(encodeURIComponent).join('/');
function decode64(b64) { const bin = atob(String(b64).replace(/\n/g, '')); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); }

async function listRepos(ctx) {
  const j = await gh(ctx, '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
  return { repos: j.map(r => ({ name: r.full_name, branch: r.default_branch, private: !!r.private })) };
}
/* the full text of a file, or null when it does not exist */
async function loadFile(ctx, path) {
  if (path in ctx.cache) return ctx.cache[path];
  let text = null;
  try {
    const j = await gh(ctx, '/repos/' + ctx.repo + '/contents/' + enc(path) + '?ref=' + encodeURIComponent(ctx.branch));
    if (Array.isArray(j)) throw new Error(path + ' is a folder, not a file.');
    if (j.content && j.encoding === 'base64') text = decode64(j.content);
    else { const b = await gh(ctx, '/repos/' + ctx.repo + '/git/blobs/' + j.sha); text = decode64(b.content); }
  } catch (e) { if (e.status !== 404) throw e; }
  ctx.cache[path] = text;
  return text;
}
async function getTree(ctx) {
  if (!ctx.tree) { const j = await gh(ctx, '/repos/' + ctx.repo + '/git/trees/' + encodeURIComponent(ctx.branch) + '?recursive=1'); ctx.tree = (j.tree || []).filter(t => t.type === 'blob'); }
  return ctx.tree;
}

/* find and replace. Each find text must be in the file exactly once. */
function applyEdits(text, edits, path) {
  edits.forEach((e, i) => {
    const f = String(e.find == null ? '' : e.find);
    if (!f) throw new Error('Edit ' + (i + 1) + ' for ' + path + ' has an empty find text.');
    const n = text.split(f).length - 1;
    if (n !== 1) throw new Error('Edit ' + (i + 1) + ' for ' + path + ': the find text was found ' + n + ' times (it must be exactly 1). Read the file again and copy the text exactly.');
    text = text.replace(f, () => String(e.replace == null ? '' : e.replace));
  });
  return text;
}

/* ---------------- the tools the AI can use ---------------- */
async function runTool(ctx, name, a) {
  try {
    a = a && typeof a === 'object' ? a : {};
    if (!ctx.repo) return { error: 'No repository is selected. Tell the user to pick one in Settings.' };
    if (name === 'list_files') {
      addStep(ctx, '📂 Looked at the files' + (a.prefix ? ' in ' + a.prefix : ''));
      const pre = String(a.prefix || '');
      const all = (await getTree(ctx)).filter(t => t.path.indexOf(pre) === 0);
      return { total: all.length, files: all.slice(0, 400).map(t => t.path + ' (' + t.size + ' bytes)') };
    }
    if (name === 'read_file') {
      addStep(ctx, '📄 Read ' + a.path);
      const text = await loadFile(ctx, String(a.path));
      if (text == null) return { error: a.path + ' does not exist.' };
      const lines = text.split('\n'), total = lines.length;
      const from = Math.max(1, a.from_line | 0 || 1);
      const to = a.to_line ? Math.min(total, a.to_line | 0) : total;
      let out = '', i = from - 1;
      for (; i < to; i++) { if (out.length + lines[i].length + 1 > MAX_CHARS) break; out += lines[i] + '\n'; }
      return { path: a.path, total_lines: total, from_line: from, to_line: i, more_after: i < total, text: out };
    }
    if (name === 'find_in_file') {
      addStep(ctx, '🔎 Searched ' + a.path);
      const text = await loadFile(ctx, String(a.path));
      if (text == null) return { error: a.path + ' does not exist.' };
      const q = String(a.text || ''), hits = [];
      text.split('\n').forEach((l, i) => { if (q && l.indexOf(q) >= 0 && hits.length < 25) hits.push({ line: i + 1, text: l.slice(0, 200) }); });
      return { matches: hits };
    }
    if (name === 'list_workflow_runs') {
      addStep(ctx, '🔨 Checked the latest builds');
      const j = await gh(ctx, '/repos/' + ctx.repo + '/actions/runs?per_page=' + Math.max(1, Math.min(10, a.limit | 0 || 5)));
      return { runs: (j.workflow_runs || []).map(r => ({ id: r.id, workflow: r.name, status: r.status, result: r.conclusion, branch: r.head_branch, commit: String((r.head_commit && r.head_commit.message) || '').split('\n')[0].slice(0, 80), when: r.created_at })) };
    }
    if (name === 'get_build_errors') return await buildErrors(ctx, a);
    if (name === 'propose_changes') return await propose(ctx, a);
    return { error: 'Unknown tool ' + name };
  } catch (e) { return { error: String(e.message || e) }; }
}

/* the plain-text log of a build job (GitHub sends it as a redirect) */
async function ghText(ctx, path) {
  if (++ctx.n > MAX_REQUESTS + 4) throw new Error('Too many steps in one request. Ask for a smaller task.');
  const r = await fetch(GH + path, { headers: { authorization: 'Bearer ' + ctx.env.GITHUB_TOKEN, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'hans-ai-coder' }, redirect: 'follow' });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error('GitHub ' + r.status + ': ' + (j.message || 'error')); }
  return await r.text();
}
function errorLines(log) {
  const L = String(log).split('\n').map(l => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').replace(/\u001b\[[0-9;]*m/g, ''));
  const tail = L.slice(-500), re = /error|failed|failure|exception|cannot|could not|not found|what went wrong|unresolved|no such file/i;
  const keep = new Set();
  tail.forEach((l, i) => { if (re.test(l)) for (let k = Math.max(0, i - 2); k <= Math.min(tail.length - 1, i + 2); k++) keep.add(k); });
  const out = keep.size ? tail.filter((l, i) => keep.has(i)) : tail.slice(-80);
  let t = out.join('\n'); if (t.length > 7000) t = t.slice(-7000);
  return t;
}
async function buildErrors(ctx, a) {
  let id = a.run_id | 0;
  if (!id) {
    const j = await gh(ctx, '/repos/' + ctx.repo + '/actions/runs?status=failure&per_page=1');
    const r = j.workflow_runs && j.workflow_runs[0];
    if (!r) return { message: 'There are no failed builds.' };
    id = r.id;
  }
  addStep(ctx, '🧯 Read the build errors');
  const jobs = await gh(ctx, '/repos/' + ctx.repo + '/actions/runs/' + id + '/jobs?per_page=20');
  const bad = (jobs.jobs || []).filter(x => x.conclusion === 'failure');
  if (!bad.length) return { run_id: id, message: 'That build has no failed job.', jobs: (jobs.jobs || []).map(x => ({ name: x.name, status: x.status, result: x.conclusion })) };
  const job = bad[0], step = (job.steps || []).find(x => x.conclusion === 'failure');
  let log;
  try { log = await ghText(ctx, '/repos/' + ctx.repo + '/actions/jobs/' + job.id + '/logs'); }
  catch (e) { return { run_id: id, job: job.name, failed_step: step && step.name, error: 'Could not read the log: ' + e.message + ' (the GitHub token needs the Actions permission set to Read).' }; }
  return { run_id: id, job: job.name, failed_step: step ? step.name : null, log: errorLines(log) };
}

async function propose(ctx, a) {
  const files = [];
  const list = Array.isArray(a.changes) ? a.changes : [];
  if (!list.length) return { error: 'No changes were given.' };
  for (const c of list) {
    const path = String((c && c.path) || '').replace(/^\/+/, '');
    if (!path) return { error: 'A change has no path.' };
    if (c.delete) { if ((await loadFile(ctx, path)) == null) return { error: path + ' does not exist, so it cannot be deleted.' }; files.push({ path, status: 'deleted' }); continue; }
    const before = await loadFile(ctx, path);
    if (Array.isArray(c.edits) && c.edits.length) {
      if (before == null) return { error: path + ' does not exist. Use content to create it.' };
      applyEdits(before, c.edits, path);   /* throws a clear error the AI can read and fix */
      files.push({ path, status: 'modified', edits: c.edits.map(e => ({ find: String(e.find), replace: String(e.replace == null ? '' : e.replace) })) });
    } else if (typeof c.content === 'string') {
      files.push(before == null ? { path, status: 'new', content: c.content } : { path, status: 'modified', content: c.content, before: before.length < 200000 ? before : null });
    } else return { error: 'The change for ' + path + ' needs content, edits, or delete.' };
  }
  ctx.proposal = { summary: String(a.summary || 'Update code'), files };
  addStep(ctx, '📝 Prepared ' + files.length + ' file change' + (files.length > 1 ? 's' : ''));
  return { saved: true, note: 'The proposal is saved. The user must approve it in the app before anything is pushed. Do not say it is pushed. Briefly tell the user what you changed.' };
}

/* ---------------- many free AIs, one after another ---------------- */
function activeProviders(env) {
  const have = PROVIDERS.filter(p => p.kind === 'cf' ? !!env[p.bind] : !!env[p.key]);
  const order = String(env.PROVIDER_ORDER || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!order.length) return have;
  const rank = id => { const i = order.indexOf(id); return i < 0 ? 999 : i; };
  return have.slice().sort((a, b) => rank(a.id) - rank(b.id));
}
const cooling = k => (ST.cool[k] || 0) > Date.now();
const coolFor = (k, ms) => { ST.cool[k] = Date.now() + ms; };
const nid = () => 'c' + Array.from(crypto.getRandomValues(new Uint8Array(4)), b => b.toString(16).padStart(2, '0')).join('');
function nums(s) { return (String(s).match(/\d+/g) || []).map(Number); }
function newer(a, b) { const x = nums(a), y = nums(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] || 0) - (x[i] || 0); if (d) return d; } return 0; }
function rank(ids, p) {
  return ids.filter(id => !SKIP.test(id) && (!p.only || p.only.test(id)))
    .map(id => ({ id, s: PREF.findIndex(r => r.test(id)) })).filter(x => x.s >= 0)
    .sort((a, b) => a.s - b.s || newer(a.id, b.id)).map(x => x.id);
}
function httpErr(status, msg, headers) { const e = new Error(String(msg || 'error').slice(0, 220)); e.status = status; e.headers = headers; return e; }

async function post(ctx, url, headers, body, method) {
  if (++ctx.n > MAX_REQUESTS + 4) throw new Error('Too many steps in one request. Ask for a smaller task.');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(url, { method: method || 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw httpErr(r.status, (j.error && (j.error.message || j.error)) || j.message || ('HTTP ' + r.status), r.headers);
    return j;
  } catch (e) {
    if (e.name === 'AbortError') throw httpErr(408, 'timed out');
    if (!e.status) throw httpErr(503, e.message || 'network error');
    throw e;
  } finally { clearTimeout(t); }
}

/* the models a provider offers, best coding models first (remembered for 6 hours) */
async function modelsFor(ctx, p) {
  const ov = ctx.env[p.id.toUpperCase() + '_MODELS'];
  if (ov) return String(ov).split(',').map(s => s.trim()).filter(Boolean);
  const c = ST.cache[p.id]; if (c && Date.now() < c.until) return c.list;
  let list = null;
  try {
    if (p.kind === 'gemini') {
      const j = await post(ctx, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=300', { 'x-goog-api-key': ctx.env[p.key] }, null, 'GET');
      const ids = (j.models || []).filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0).map(m => String(m.name).replace(/^models\//, ''));
      list = ids.filter(id => /^gemini-\d/.test(id) && /flash/.test(id) && !SKIP.test(id) && !/live|preview-tts|robotics|computer|exp-/.test(id))
        .sort((a, b) => newer(a, b) || (/lite/.test(a) ? 1 : 0) - (/lite/.test(b) ? 1 : 0));
    } else if (p.kind === 'cf') {
      list = ctx.env.CLOUDFLARE_MODELS ? String(ctx.env.CLOUDFLARE_MODELS).split(',').map(s => s.trim()).filter(Boolean) : p.fb.slice();
    } else {
      const j = await post(ctx, p.base + '/models', { authorization: 'Bearer ' + ctx.env[p.key] }, null, 'GET');
      let items = Array.isArray(j) ? j : (j.data || []);
      if (p.freeOnly) items = items.filter(m => /:free$/.test(m.id) || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0));
      list = rank(items.map(m => m.id || m.name).filter(Boolean), p);
    }
  } catch (e) { if (e.status === 401 || e.status === 403 || /Too many steps/.test(e.message)) throw e; }
  if (!list || !list.length) { ST.cache[p.id] = { until: Date.now() + 10 * 60e3, list: p.fb.slice() }; return p.fb.slice(); }
  ST.cache[p.id] = { until: Date.now() + 6 * 3600e3, list };
  return list;
}

/* our own neutral chat history is turned into each provider's format */
function toOpenAI(system, hist) {
  const m = [{ role: 'system', content: system }];
  hist.forEach(h => {
    if (h.r === 'user') m.push({ role: 'user', content: h.t });
    else if (h.r === 'model') {
      const o = { role: 'assistant', content: h.t || null };
      if (h.calls && h.calls.length) o.tool_calls = h.calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
      m.push(o);
    } else h.results.forEach(r => m.push({ role: 'tool', tool_call_id: r.id, content: JSON.stringify(r.res).slice(0, 70000) }));
  });
  return m;
}
function toGemini(hist, model) {
  const c = [];
  hist.forEach(h => {
    if (h.r === 'user') c.push({ role: 'user', parts: [{ text: h.t }].concat((h.imgs || []).map(im => ({ inlineData: { mimeType: im.mime, data: im.data } }))) });
    else if (h.r === 'model') {
      if (h.raw && h.raw.model === model) { c.push({ role: 'model', parts: h.raw.parts }); return; }
      const parts = [];
      if (h.t) parts.push({ text: h.t });
      (h.calls || []).forEach((k, i) => { const p = { functionCall: { name: k.name, args: k.args || {} } }; if (i === 0) p.thoughtSignature = 'skip_thought_signature_validator'; parts.push(p); });
      c.push({ role: 'model', parts });
    } else c.push({ role: 'user', parts: h.results.map(r => ({ functionResponse: { name: r.name, response: r.res && typeof r.res === 'object' ? r.res : { result: r.res } } })) });
  });
  return c;
}
function parseOpenAI(msg) {
  const text = Array.isArray(msg.content) ? msg.content.map(x => x.text || '').join('') : String(msg.content || '');
  const calls = (msg.tool_calls || []).map(t => {
    let args = t.function && t.function.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch (e) { args = {}; } }
    return { id: nid(), name: t.function && t.function.name, args: args || {} };
  }).filter(c => c.name);
  return { text: text.trim(), calls };
}

async function tryModel(ctx, p, model, system, hist, withTools) {
  let out;
  if (p.kind === 'gemini') {
    const body = { systemInstruction: { parts: [{ text: system }] }, contents: toGemini(hist, model), generationConfig: { temperature: 0.3 } };
    if (withTools) body.tools = [{ functionDeclarations: TOOLS }];
    const j = await post(ctx, 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', { 'x-goog-api-key': ctx.env[p.key] }, body);
    const cand = j.candidates && j.candidates[0], parts = cand && cand.content && cand.content.parts;
    if (!parts || !parts.length) throw httpErr(502, 'no answer' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : ''));
    out = { text: parts.filter(x => x.text && !x.thought).map(x => x.text).join('').trim(), calls: parts.filter(x => x.functionCall).map(x => ({ id: nid(), name: x.functionCall.name, args: x.functionCall.args || {} })), raw: { model, parts } };
  } else if (p.kind === 'cf') {
    if (++ctx.n > MAX_REQUESTS + 4) throw new Error('Too many steps in one request. Ask for a smaller task.');
    const input = { messages: toOpenAI(system, hist), max_tokens: 6000, temperature: 0.3 };
    if (withTools) input.tools = TOOLS.map(t => ({ type: 'function', function: t }));
    const j = await ctx.env[p.bind].run(model, input);
    const msg = j && j.choices && j.choices[0] && j.choices[0].message;
    if (msg) out = parseOpenAI(msg);
    else {
      const r = (j && (j.response != null ? j : j.result)) || {};
      out = parseOpenAI({ content: typeof r.response === 'string' ? r.response : '', tool_calls: (r.tool_calls || []).map(t => ({ function: { name: t.name, arguments: t.arguments } })) });
    }
  } else {
    const body = { model, messages: toOpenAI(system, hist), temperature: 0.3, max_tokens: 6000 };
    if (withTools) { body.tools = TOOLS.map(t => ({ type: 'function', function: t })); body.tool_choice = 'auto'; }
    const j = await post(ctx, p.base + '/chat/completions', { authorization: 'Bearer ' + ctx.env[p.key] }, body);
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    if (!msg) throw httpErr(502, 'no answer');
    out = parseOpenAI(msg);
  }
  if (!out.text && !out.calls.length) throw httpErr(502, 'empty answer');
  return out;
}
function untilMidnightUtc() { const d = new Date(); return Math.min(6 * 3600e3, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime() + 5000); }
function penalty(e, p, model) {
  const s = e.status | 0, msg = String(e.message || '');
  if (s === 429) {
    const ra = e.headers && Number(e.headers.get && e.headers.get('retry-after'));
    coolFor(p.id + '/' + model, ra > 0 ? Math.min(ra, 900) * 1000 : (/per day|daily|\bRPD\b|day/i.test(msg) ? untilMidnightUtc() : 90e3));
  } else if (s === 401) coolFor('p:' + p.id, 30 * 60e3);
  else if (s === 400 || s === 403 || s === 404 || s === 422) coolFor(p.id + '/' + model, 30 * 60e3);
  else coolFor(p.id + '/' + model, 45e3);
}

/* one AI answer: use the AI we already used in this message, otherwise walk the list until one works */
async function callModel(ctx, system, hist, withTools) {
  let provs = activeProviders(ctx.env);
  if (!provs.length) throw new Error('No AI key is set yet. Add GEMINI_API_KEY (or another AI key) in Cloudflare.');
  if (hist.some(h => h.imgs && h.imgs.length)) { provs = provs.filter(p => p.vision); if (!provs.length) throw new Error('Pictures need a Gemini key. Add GEMINI_API_KEY in Cloudflare, or send your question without the picture.'); }
  const tried = []; let attempts = 0;
  const attempt = async (p, m) => {
    attempts++;
    try {
      const out = await tryModel(ctx, p, m, system, hist, withTools);
      const via = p.id + ' · ' + m;
      if ((ctx.via && ctx.via !== via) || (tried.length && ctx.via !== via)) addStep(ctx, '🔁 Switched to ' + via);
      ctx.cur = { p, m }; ctx.via = via; out.model = m; if (ctx.emit) ctx.emit({ t: 'via', v: via });
      return out;
    } catch (e) {
      if (/Too many steps/.test(e.message)) throw e;
      tried.push(p.id + '/' + m + ': ' + String(e.message).slice(0, 80));
      penalty(e, p, m);
      return null;
    }
  };
  if (ctx.cur && !cooling(ctx.cur.p.id + '/' + ctx.cur.m) && !cooling('p:' + ctx.cur.p.id)) { const o = await attempt(ctx.cur.p, ctx.cur.m); if (o) return o; }
  for (const p of provs) {
    if (cooling('p:' + p.id)) continue;
    let models; try { models = await modelsFor(ctx, p); } catch (e) { if (/Too many steps/.test(e.message)) throw e; coolFor('p:' + p.id, 30 * 60e3); tried.push(p.id + ': key problem'); continue; }
    let used = 0;
    for (const m of models) {
      if (used >= (p.per || PER_PROVIDER) || attempts >= MAX_ATTEMPTS || ctx.n >= MAX_REQUESTS) break;
      if (cooling(p.id + '/' + m) || (ctx.cur && ctx.cur.p.id === p.id && ctx.cur.m === m)) continue;
      used++;
      const o = await attempt(p, m); if (o) return o;
      if (cooling('p:' + p.id)) break;
    }
  }
  throw new Error('All your free AIs are busy or out of quota right now. Wait a minute and try again, or add another AI key. (' + (tried.slice(-4).join(' | ') || 'none ready') + ')');
}

async function chat(ctx, body) {
  const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-20).filter(m => m && m.text);
  while (msgs.length && msgs[0].role === 'assistant') msgs.shift();
  if (!msgs.length) return { error: 'Say something first.' };
  let system;
  if (ctx.repo) {
    let list = '';
    try { const t = await getTree(ctx); list = '\n\nFiles in the repository (path, bytes):\n' + t.slice(0, 150).map(f => f.path + ' ' + f.size).join('\n') + (t.length > 150 ? '\n...and ' + (t.length - 150) + ' more (use list_files with a prefix)' : ''); }
    catch (e) { list = '\n\n(Could not read the file list: ' + String(e.message).slice(0, 120) + ')'; }
    system = 'You are Hans AI Coder, a careful coding assistant working inside the GitHub repository ' + ctx.repo + ' (branch ' + ctx.branch + '). ' +
      'Look at the code with read_file and find_in_file before you change it. To change code call propose_changes. For existing files prefer edits with find text copied exactly from the file that appears only once; use content only for new or small files. ' +
      'For a failed build use get_build_errors, read the files it points to, then propose a fix. Use list_workflow_runs to see the latest builds. ' +
      'You can NOT push. The user reviews and approves your proposal in the app, so never say it is pushed. Answer fast. Do not call tools you do not need. Keep answers short and easy to read on a phone. If the request is unclear, ask one question.' + list;
  } else system = 'You are Hans AI Coder, a friendly coding assistant. No GitHub repository is selected yet, so you cannot read or change files. Answer questions and tell the user to pick a repository in Settings to work on code. Keep answers short.';
  const hist = msgs.map(m => ({ r: m.role === 'assistant' ? 'model' : 'user', t: String(m.text).slice(0, 90000) }));
  const imgs = (Array.isArray(body.images) ? body.images : []).filter(x => x && x.data && /^image\/(png|jpe?g|webp|gif)$/.test(x.mime || '') && String(x.data).length < 2.5e6).slice(0, 4);
  if (imgs.length) { for (let k = hist.length - 1; k >= 0; k--) if (hist[k].r === 'user') { hist[k].imgs = imgs.map(x => ({ mime: x.mime, data: x.data })); break; } }
  let text = '';
  try {
    for (let i = 0; i < MAX_MODEL_CALLS; i++) {
      const out = await callModel(ctx, system, hist, !!ctx.repo);
      hist.push({ r: 'model', t: out.text, calls: out.calls, raw: out.raw });
      if (!out.calls.length) { text = out.text; break; }
      const results = await Promise.all(out.calls.map(async c => ({ id: c.id, name: c.name, res: await runTool(ctx, c.name, c.args) })));
      hist.push({ r: 'tool', results });
      if (i === MAX_MODEL_CALLS - 1) text = 'I ran out of steps for one message. Ask me to continue, or give me a smaller task.';
    }
  } catch (e) { text = 'Something went wrong: ' + String(e.message || e); }
  return { reply: text || 'Done.', steps: ctx.steps, proposal: ctx.proposal, via: ctx.via || '' };
}

/* ---------------- push (only after you approve in the app) ---------------- */
async function push(ctx, body) {
  if (!ctx.repo || !ctx.branch) throw new Error('Pick a repository first.');
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) throw new Error('Nothing to push.');
  const entries = [];
  for (const f of files) {
    const path = String(f.path || '').replace(/^\/+/, '');
    if (f.status === 'deleted') entries.push({ path, mode: '100644', type: 'blob', sha: null });
    else if (Array.isArray(f.edits) && f.edits.length) {
      const cur = await loadFile(ctx, path);
      if (cur == null) throw new Error(path + ' is not in the repository any more.');
      entries.push({ path, mode: '100644', type: 'blob', content: applyEdits(cur, f.edits, path) });
    } else if (typeof f.content === 'string') entries.push({ path, mode: '100644', type: 'blob', content: f.content });
    else throw new Error('Nothing to write for ' + path);
  }
  const base = await gh(ctx, '/repos/' + ctx.repo + '/git/ref/heads/' + enc(ctx.branch));
  const baseSha = base.object.sha;
  let target = ctx.branch;
  if (body.newBranch) {
    target = String(body.newBranch).replace(/[^A-Za-z0-9._\/-]/g, '-').slice(0, 60);
    await gh(ctx, '/repos/' + ctx.repo + '/git/refs', { method: 'POST', body: { ref: 'refs/heads/' + target, sha: baseSha } });
  }
  const commit = await gh(ctx, '/repos/' + ctx.repo + '/git/commits/' + baseSha);
  const tree = await gh(ctx, '/repos/' + ctx.repo + '/git/trees', { method: 'POST', body: { base_tree: commit.tree.sha, tree: entries } });
  const msg = String(body.message || 'Update from Hans AI Coder').slice(0, 200);
  const made = await gh(ctx, '/repos/' + ctx.repo + '/git/commits', { method: 'POST', body: { message: msg, tree: tree.sha, parents: [baseSha] } });
  await gh(ctx, '/repos/' + ctx.repo + '/git/refs/heads/' + enc(target), { method: 'PATCH', body: { sha: made.sha } });
  return { ok: true, sha: made.sha, branch: target, url: 'https://github.com/' + ctx.repo + '/commit/' + made.sha };
}
// END OF worker.js
