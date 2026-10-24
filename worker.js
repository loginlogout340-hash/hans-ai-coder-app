/* Hans AI Coder - Cloudflare Worker (backend).
   It keeps your secret keys, talks to the Gemini AI, reads your GitHub repo, and pushes ONLY after you approve in the app.
   Secrets to add in Cloudflare: APP_PASSCODE, GITHUB_TOKEN, GEMINI_API_KEY. Optional text variable: GEMINI_MODEL. */

const GH = 'https://api.github.com';
const MAX_MODEL_CALLS = 9;       // the free Cloudflare plan allows 50 outside requests per call, so we stay below that
const MAX_REQUESTS = 44;
const MAX_CHARS = 60000;         // most of a file the AI reads in one go

const TOOLS = [
  { name: 'list_files', description: 'List the files in the repository. Optional prefix to only list one folder.',
    parameters: { type: 'object', properties: { prefix: { type: 'string', description: 'Folder or path start, for example src/' } } } },
  { name: 'read_file', description: 'Read a file. For big files read part of it with from_line and to_line.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, from_line: { type: 'integer' }, to_line: { type: 'integer' } }, required: ['path'] } },
  { name: 'find_in_file', description: 'Find lines that contain some text in a file. Returns line numbers. Use it for big files.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] } },
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
  async fetch(req, env) {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type,x-app-pass', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    try {
      if (!env.APP_PASSCODE) return reply({ error: 'The Worker has no APP_PASSCODE secret yet. Add it in Cloudflare.' }, 500, cors);
      if ((req.headers.get('x-app-pass') || '') !== env.APP_PASSCODE) return reply({ error: 'Wrong passcode' }, 401, cors);
      const path = new URL(req.url).pathname;
      const body = req.method === 'POST' ? await req.json() : {};
      const ctx = { env, n: 0, repo: body.repo || '', branch: body.branch || '', cache: {}, tree: null, proposal: null, steps: [] };
      if (path === '/ping') return reply({ ok: true, ai: !!env.GEMINI_API_KEY, github: !!env.GITHUB_TOKEN, model: env.GEMINI_MODEL || 'gemini-2.5-flash' }, 200, cors);
      if (path === '/repos') return reply(await listRepos(ctx), 200, cors);
      if (path === '/chat') return reply(await chat(ctx, body), 200, cors);
      if (path === '/push') return reply(await push(ctx, body), 200, cors);
      return reply({ error: 'Not found' }, 404, cors);
    } catch (e) {
      return reply({ error: String((e && e.message) || e) }, 500, cors);
    }
  }
};

function reply(obj, status, cors) { return new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json' }, cors) }); }

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
    if (!ctx.repo) return { error: 'No repository is selected. Tell the user to pick one in Settings.' };
    if (name === 'list_files') {
      ctx.steps.push('📂 Looked at the files' + (a.prefix ? ' in ' + a.prefix : ''));
      const pre = String(a.prefix || '');
      const all = (await getTree(ctx)).filter(t => t.path.indexOf(pre) === 0);
      return { total: all.length, files: all.slice(0, 400).map(t => t.path + ' (' + t.size + ' bytes)') };
    }
    if (name === 'read_file') {
      ctx.steps.push('📄 Read ' + a.path);
      const text = await loadFile(ctx, String(a.path));
      if (text == null) return { error: a.path + ' does not exist.' };
      const lines = text.split('\n'), total = lines.length;
      const from = Math.max(1, a.from_line | 0 || 1);
      let to = a.to_line ? Math.min(total, a.to_line | 0) : total, out = '', i = from - 1;
      for (; i < to; i++) { if (out.length + lines[i].length + 1 > MAX_CHARS) break; out += lines[i] + '\n'; }
      return { path: a.path, total_lines: total, from_line: from, to_line: i, more_after: i < total, text: out };
    }
    if (name === 'find_in_file') {
      ctx.steps.push('🔎 Searched ' + a.path);
      const text = await loadFile(ctx, String(a.path));
      if (text == null) return { error: a.path + ' does not exist.' };
      const q = String(a.text || ''), hits = [];
      text.split('\n').forEach((l, i) => { if (q && l.indexOf(q) >= 0 && hits.length < 25) hits.push({ line: i + 1, text: l.slice(0, 200) }); });
      return { matches: hits };
    }
    if (name === 'propose_changes') return await propose(ctx, a);
    return { error: 'Unknown tool ' + name };
  } catch (e) { return { error: String(e.message || e) }; }
}

async function propose(ctx, a) {
  const files = [];
  const list = Array.isArray(a.changes) ? a.changes : [];
  if (!list.length) return { error: 'No changes were given.' };
  for (const c of list) {
    const path = String(c.path || '').replace(/^\/+/, '');
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
  ctx.steps.push('📝 Prepared ' + files.length + ' file change' + (files.length > 1 ? 's' : ''));
  return { saved: true, note: 'The proposal is saved. The user must approve it in the app before anything is pushed. Do not say it is pushed. Briefly tell the user what you changed.' };
}

/* ---------------- the AI ---------------- */
async function callAI(ctx, system, contents, withTools) {
  if (!ctx.env.GEMINI_API_KEY) throw new Error('The Worker has no GEMINI_API_KEY secret yet.');
  if (++ctx.n > MAX_REQUESTS + 4) throw new Error('Too many steps in one request. Ask for a smaller task.');
  const model = ctx.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: 0.3 } };
  if (withTools) body.tools = [{ functionDeclarations: TOOLS }];
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': ctx.env.GEMINI_API_KEY }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 429) throw new Error('The free AI limit was reached. Wait a minute and try again.');
    throw new Error('AI error ' + r.status + ': ' + ((j.error && j.error.message) || 'unknown'));
  }
  const cand = j.candidates && j.candidates[0];
  if (!cand || !cand.content) throw new Error('The AI gave no answer' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : '') + '. Try asking again.');
  return cand.content.parts || [];
}

async function chat(ctx, body) {
  const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-20).filter(m => m && m.text);
  if (!msgs.length) return { error: 'Say something first.' };
  const system = ctx.repo
    ? 'You are Hans AI Coder, a careful coding assistant working inside the GitHub repository ' + ctx.repo + ' (branch ' + ctx.branch + '). ' +
      'Look at the code with list_files, read_file and find_in_file before you change it. To change code call propose_changes. For existing files prefer edits with find text copied exactly from the file that appears only once; use content only for new or small files. ' +
      'You can NOT push. The user reviews and approves your proposal in the app, so never say it is pushed. Keep answers short and easy to read on a phone. If the request is unclear, ask one question.'
    : 'You are Hans AI Coder, a friendly coding assistant. No GitHub repository is selected yet, so you cannot read or change files. Answer questions and tell the user to pick a repository in Settings to work on code. Keep answers short.';
  const contents = msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.text).slice(0, 8000) }] }));
  let text = '';
  try {
    for (let i = 0; i < MAX_MODEL_CALLS; i++) {
      const parts = await callAI(ctx, system, contents, !!ctx.repo);
      contents.push({ role: 'model', parts });
      const calls = parts.filter(p => p.functionCall);
      if (!calls.length) { text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim(); break; }
      const out = [];
      for (const p of calls) out.push({ functionResponse: { name: p.functionCall.name, response: await runTool(ctx, p.functionCall.name, p.functionCall.args || {}) } });
      contents.push({ role: 'user', parts: out });
      if (i === MAX_MODEL_CALLS - 1) text = 'I ran out of steps for one message. Ask me to continue, or give me a smaller task.';
    }
  } catch (e) { text = 'Something went wrong: ' + String(e.message || e); }
  return { reply: text || 'Done.', steps: ctx.steps, proposal: ctx.proposal };
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
