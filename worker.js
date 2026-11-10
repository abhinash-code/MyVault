// MyVault backend — Cloudflare Worker. Auth: GitHub OAuth (PKCE S256). Storage: private GitHub repo (JSON).
const enc = new TextEncoder(), dec = new TextDecoder();
const SESSION_SECONDS = 2 * 60 * 60, MAX_PER_PART = 200, MAX_PART_BYTES = 500 * 1024, MAX_PARTS = 20;
const DEFAULT_CATS = [
  ['websites', 'Websites', '#3b4fe0'], ['ai-tools', 'AI Tools', '#7c3aed'], ['chrome-extensions', 'Chrome Extensions', '#0e9f6e'],
  ['software', 'Software', '#0891b2'], ['android-apps', 'Android Apps', '#65a30d'], ['developer-tools', 'Developer Tools', '#475569'],
  ['programming', 'Programming Resources', '#d97706'], ['courses', 'Courses', '#db2777'], ['services', 'Useful Services', '#0d9488'], ['other', 'Other', '#6b7280'],
].map(([id, name, color]) => ({ id, name, color, builtin: true }));
const DEFAULT_SETTINGS = { theme: 'system', defaultSort: 'newest' };

class E extends Error { constructor(s, c, m) { super(m); this.s = s; this.c = c; } }
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ub64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const rnd = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const hkey = (s) => crypto.subtle.importKey('raw', enc.encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
async function sign(p, secret) { const body = b64u(enc.encode(JSON.stringify(p))); return body + '.' + b64u(await crypto.subtle.sign('HMAC', await hkey(secret), enc.encode(body))); }
async function verify(t, secret) {
  const [b, g] = (t || '').split('.'); if (!b || !g) return null;
  try { if (!(await crypto.subtle.verify('HMAC', await hkey(secret), ub64u(g), enc.encode(b)))) return null; return JSON.parse(dec.decode(ub64u(b))); } catch { return null; }
}
const SEC = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const send = (status, obj, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC, ...extra } });
const ok = (data, message = 'OK') => send(200, { success: true, data, message });

// ---------- GitHub storage ----------
const branch = (env) => env.GITHUB_DATA_BRANCH || 'main';
const gh = (env, path, init = {}) => fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_DATA_REPO}/${path}`, {
  ...init, headers: { Authorization: `Bearer ${env.GITHUB_PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'myvault-worker', 'X-GitHub-Api-Version': '2022-11-28' },
});
function ghFail(r, what) {
  if (r.status === 429 || (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0')) return new E(429, 'RATE_LIMIT', 'GitHub API rate limit reached. Try again in a few minutes.');
  return new E(502, 'GITHUB_ERROR', `GitHub ${what} failed (${r.status}). Check the PAT and repository settings.`);
}
async function getFile(env, p) {
  const r = await gh(env, `contents/${p}?ref=${branch(env)}`);
  if (r.status === 404) return null; if (!r.ok) throw ghFail(r, 'read');
  const j = await r.json();
  return { sha: j.sha, data: JSON.parse(dec.decode(Uint8Array.from(atob(j.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)))) };
}
async function putFile(env, p, data, sha, msg) {
  let bin = ''; for (const b of enc.encode(JSON.stringify(data, null, 1))) bin += String.fromCharCode(b);
  const r = await gh(env, `contents/${p}`, { method: 'PUT', body: JSON.stringify({ message: msg, content: btoa(bin), branch: branch(env), ...(sha ? { sha } : {}) }) });
  if (r.status === 409 || r.status === 422) throw new E(409, 'CONFLICT', 'Data changed on another device. Please sync and retry.');
  if (!r.ok) throw ghFail(r, 'write');
  return (await r.json()).content.sha;
}
async function load(env) {
  const m = await getFile(env, 'manifest.json');
  const manifest = m ? m.data : { schema: 1, partitions: [] };
  const parts = await Promise.all(manifest.partitions.map(async (p) => {
    const f = await getFile(env, p.path); const items = f?.data?.items || [];
    return { path: p.path, sha: f?.sha || null, items, orig: JSON.stringify(items) };
  }));
  const c = await getFile(env, 'data/categories.json');
  const cats = c ? c.data : { categories: DEFAULT_CATS, settings: DEFAULT_SETTINGS };
  return { mSha: m?.sha || null, manifest, parts, cats, catSha: c?.sha || null, origCats: c ? JSON.stringify(c.data) : '' };
}
async function save(env, st, msg) {
  let dirty = false;
  for (const p of st.parts) if (JSON.stringify(p.items) !== p.orig) { p.sha = await putFile(env, p.path, { schema: 1, items: p.items }, p.sha, msg); dirty = true; }
  if (JSON.stringify(st.cats) !== st.origCats) { await putFile(env, 'data/categories.json', st.cats, st.catSha, msg); dirty = true; }
  if (dirty) {
    const total = st.parts.reduce((n, p) => n + p.items.length, 0);
    await putFile(env, 'manifest.json', { schema: 1, updatedAt: new Date().toISOString(), total, limits: { perPart: MAX_PER_PART, maxBytes: MAX_PART_BYTES, maxParts: MAX_PARTS },
      partitions: st.parts.map((p) => ({ id: p.path.match(/part-(\d+)/)[1], path: p.path, count: p.items.length })) }, st.mSha, msg);
  }
}
// Reload + reapply on conflict (limited retries). fn must be idempotent. GitHub Contents API is NOT transactional.
async function mutate(env, msg, fn) {
  for (let i = 0; i < 4; i++) {
    try { const st = await load(env); const out = fn(st); await save(env, st, msg); return out; }
    catch (e) { if (!(e instanceof E && e.c === 'CONFLICT') || i === 3) throw e; }
  }
}
const allItems = (st) => st.parts.flatMap((p) => p.items);
function place(st, item) {
  let p = st.parts[st.parts.length - 1];
  if (!p || p.items.length >= MAX_PER_PART || enc.encode(JSON.stringify(p.items)).length > MAX_PART_BYTES) {
    if (st.parts.length >= MAX_PARTS) throw new E(507, 'STORAGE_FULL', 'Library storage is full. Export a backup and remove old items.');
    p = { path: `data/items/part-${String(st.parts.length + 1).padStart(4, '0')}.json`, sha: null, items: [], orig: '[]' }; st.parts.push(p);
  }
  p.items.push(item);
}
function findItem(st, id) { for (const p of st.parts) { const i = p.items.findIndex((x) => x.id === id); if (i >= 0) return { p, i, item: p.items[i] }; } throw new E(404, 'NOT_FOUND', 'Resource not found.'); }

// ---------- validation ----------
const str = (v, max, label, req) => { v = typeof v === 'string' ? v.trim() : ''; if (req && !v) throw new E(400, 'VALIDATION_ERROR', `${label} is required`); if (v.length > max) throw new E(400, 'VALIDATION_ERROR', `${label} is too long (max ${max})`); return v; };
function cleanUrl(u) {
  u = str(u, 2000, 'URL', true); let x; try { x = new URL(u); } catch { throw new E(400, 'VALIDATION_ERROR', 'A valid URL is required'); }
  if (!['http:', 'https:'].includes(x.protocol)) throw new E(400, 'VALIDATION_ERROR', 'Only http and https URLs are allowed'); return x.href;
}
function cleanFields(b, st, partial) {
  const o = {}, has = (k) => !partial || k in b;
  if (has('name')) o.name = str(b.name, 200, 'Name', true);
  if (has('url')) o.url = cleanUrl(b.url);
  if (has('categoryId')) { if (!st.cats.categories.some((c) => c.id === b.categoryId)) throw new E(400, 'VALIDATION_ERROR', 'Choose a valid category'); o.categoryId = b.categoryId; }
  if (has('description')) o.description = str(b.description, 1000, 'Description');
  if (has('notes')) o.notes = str(b.notes, 5000, 'Notes');
  if (has('tags')) { const t = Array.isArray(b.tags) ? b.tags : []; if (t.length > 20) throw new E(400, 'VALIDATION_ERROR', 'Maximum 20 tags'); o.tags = [...new Set(t.map((x) => str(x, 40, 'Tag').toLowerCase()).filter(Boolean))]; }
  if (has('status')) { if (!['read', 'unread'].includes(b.status || 'unread')) throw new E(400, 'VALIDATION_ERROR', 'Invalid status'); o.status = b.status || 'unread'; }
  if (has('favorite')) o.favorite = b.favorite === true;
  return o;
}
const cleanColor = (c) => (/^#[0-9a-fA-F]{6}$/.test(c) ? c : '#3b4fe0');

// ---------- auth ----------
const cors = (env, req) => { const o = req.headers.get('Origin'); return o && o === env.FRONTEND_ORIGIN ? { 'Access-Control-Allow-Origin': o, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS', 'Access-Control-Max-Age': '600' } : { Vary: 'Origin' }; };
async function session(env, req) {
  const m = /^Bearer (.+)$/.exec(req.headers.get('Authorization') || ''); const c = m && await verify(m[1], env.SESSION_SIGNING_SECRET);
  if (!c || c.iss !== 'myvault' || c.aud !== 'myvault-web' || c.exp < Date.now() / 1000 || String(c.sub) !== String(env.ALLOWED_GITHUB_ID)) throw new E(401, 'UNAUTHENTICATED', 'Session expired or invalid. Please sign in again.');
  return c;
}
async function authStart(env, url) {
  const verifier = rnd(48), state = rnd(24);
  const challenge = b64u(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  const cookie = await sign({ state, verifier, exp: Math.floor(Date.now() / 1000) + 600 }, env.OAUTH_STATE_SECRET);
  const q = new URLSearchParams({ client_id: env.GITHUB_OAUTH_CLIENT_ID, redirect_uri: `${url.origin}/auth/github/callback`, state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'read:user', allow_signup: 'false' });
  return new Response(null, { status: 302, headers: { Location: 'https://github.com/login/oauth/authorize?' + q, 'Set-Cookie': `mv_oauth=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`, ...SEC } });
}
async function authCallback(env, req, url) {
  const back = (k, v) => new Response(null, { status: 302, headers: { Location: `${env.FRONTEND_URL}#${k}=${encodeURIComponent(v)}`, 'Set-Cookie': 'mv_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=0', ...SEC } });
  const c = await verify(/(?:^|; )mv_oauth=([^;]+)/.exec(req.headers.get('Cookie') || '')?.[1], env.OAUTH_STATE_SECRET);
  if (!c || c.exp < Date.now() / 1000 || !url.searchParams.get('state') || url.searchParams.get('state') !== c.state || !url.searchParams.get('code')) return back('error', 'Login could not be verified. Please try again.');
  const tr = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_OAUTH_CLIENT_ID, client_secret: env.GITHUB_OAUTH_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: `${url.origin}/auth/github/callback`, code_verifier: c.verifier }) });
  const tj = await tr.json().catch(() => ({})); if (!tj.access_token) return back('error', 'GitHub sign-in failed.');
  const ur = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${tj.access_token}`, 'User-Agent': 'myvault-worker', Accept: 'application/vnd.github+json' } });
  const u = await ur.json().catch(() => ({}));
  if (!u.id || String(u.id) !== String(env.ALLOWED_GITHUB_ID)) return back('error', 'This GitHub account is not authorized.');
  const now = Math.floor(Date.now() / 1000);
  return back('token', await sign({ iss: 'myvault', aud: 'myvault-web', sub: String(u.id), login: u.login, iat: now, exp: now + SESSION_SECONDS, jti: rnd(12) }, env.SESSION_SIGNING_SECRET));
}

// ---------- API ----------
const view = (st) => ({ items: allItems(st), categories: st.cats.categories, settings: { ...DEFAULT_SETTINGS, ...st.cats.settings }, syncedAt: new Date().toISOString() });
async function api(env, req, url) {
  const c = await session(env, req), path = url.pathname, M = req.method; let m;
  const body = async () => { try { const b = await req.json(); if (b && typeof b === 'object') return b; } catch {} throw new E(400, 'VALIDATION_ERROR', 'Invalid JSON body'); };
  if (path === '/api/me' && M === 'GET') return ok({ id: c.sub, login: c.login, expiresAt: c.exp * 1000 });
  if (path === '/api/health' && M === 'GET') return ok({ status: 'ok', time: new Date().toISOString() });
  if ((path === '/api/items' || path === '/api/categories' || path === '/api/backup/export') && M === 'GET') { const v = view(await load(env)); return ok(path === '/api/backup/export' ? { schema: 1, exportedAt: v.syncedAt, items: v.items, categories: v.categories, settings: v.settings } : v); }
  if (path === '/api/items' && M === 'POST') {
    const b = await body(), id = typeof b.id === 'string' && /^[\w-]{8,40}$/.test(b.id) ? b.id : crypto.randomUUID();
    const r = await mutate(env, 'Add item', (st) => { const ex = allItems(st).find((x) => x.id === id); if (ex) return ex; const t = new Date().toISOString();
      const it = { id, ...{ description: '', notes: '', tags: [], status: 'unread', favorite: false }, ...cleanFields(b, st, false), createdAt: t, updatedAt: t, deletedAt: null, lastViewedAt: null }; place(st, it); return it; });
    return send(201, { success: true, data: r, message: 'Resource saved' });
  }
  if ((m = /^\/api\/items\/([\w-]+)(?:\/(restore|permanent-delete|view))?$/.exec(path))) {
    const [, id, act] = m;
    if (M === 'PATCH' && !act) { const b = await body();
      return ok(await mutate(env, 'Update item', (st) => { const f = findItem(st, id);
        if (b.expectedUpdatedAt && b.expectedUpdatedAt !== f.item.updatedAt) throw new E(409, 'CONFLICT', 'This resource was changed on another device. Sync and try again.');
        const n = { ...f.item, ...cleanFields(b, st, true), updatedAt: new Date().toISOString() }; f.p.items[f.i] = n; return n; }), 'Resource updated');
    }
    if (M === 'DELETE' && !act) return ok(await mutate(env, 'Trash item', (st) => { const f = findItem(st, id); if (!f.item.deletedAt) f.p.items[f.i] = { ...f.item, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; return f.p.items[f.i]; }), 'Moved to Trash');
    if (M === 'POST' && act === 'restore') return ok(await mutate(env, 'Restore item', (st) => { const f = findItem(st, id); f.p.items[f.i] = { ...f.item, deletedAt: null, updatedAt: new Date().toISOString() }; return f.p.items[f.i]; }), 'Restored');
    if (M === 'POST' && act === 'permanent-delete') { await mutate(env, 'Delete item', (st) => { for (const p of st.parts) p.items = p.items.filter((x) => !(x.id === id && x.deletedAt)); }); return ok({ id }, 'Permanently deleted'); }
    if (M === 'POST' && act === 'view') return ok(await mutate(env, 'Mark viewed', (st) => { const f = findItem(st, id); f.p.items[f.i] = { ...f.item, lastViewedAt: new Date().toISOString() }; return f.p.items[f.i]; }));
  }
  if (path === '/api/trash/empty' && M === 'POST') { const n = await mutate(env, 'Empty trash', (st) => { let k = 0; for (const p of st.parts) { const a = p.items.length; p.items = p.items.filter((x) => !x.deletedAt); k += a - p.items.length; } return k; }); return ok({ removed: n }, 'Trash emptied'); }
  if (path === '/api/settings' && M === 'PUT') { const b = await body();
    return ok(await mutate(env, 'Update settings', (st) => { const s = { ...DEFAULT_SETTINGS, ...st.cats.settings };
      if (['light', 'dark', 'system'].includes(b.theme)) s.theme = b.theme; if (['newest', 'oldest', 'az', 'za', 'updated', 'viewed'].includes(b.defaultSort)) s.defaultSort = b.defaultSort; st.cats.settings = s; return s; }), 'Settings saved'); }
  if (path === '/api/categories' && M === 'POST') { const b = await body(), name = str(b.name, 40, 'Name', true);
    return send(201, { success: true, message: 'Category added', data: await mutate(env, 'Add category', (st) => { const ex = st.cats.categories.find((x) => x.name.toLowerCase() === name.toLowerCase()); if (ex) return ex;
      const k = { id: 'c-' + crypto.randomUUID().slice(0, 8), name, color: cleanColor(b.color), builtin: false }; st.cats.categories.push(k); return k; }) }); }
  if ((m = /^\/api\/categories\/([\w-]+)$/.exec(path))) {
    const id = m[1];
    if (M === 'PATCH') { const b = await body(); return ok(await mutate(env, 'Update category', (st) => { const k = st.cats.categories.find((x) => x.id === id); if (!k) throw new E(404, 'NOT_FOUND', 'Category not found');
      if ('name' in b) k.name = str(b.name, 40, 'Name', true); if ('color' in b) k.color = cleanColor(b.color); return k; }), 'Category updated'); }
    if (M === 'DELETE') { const to = url.searchParams.get('reassignTo');
      await mutate(env, 'Delete category', (st) => { const k = st.cats.categories.find((x) => x.id === id); if (!k) return; if (k.builtin) throw new E(400, 'VALIDATION_ERROR', 'Default categories cannot be deleted');
        const used = allItems(st).filter((x) => x.categoryId === id);
        if (used.length) { if (!to || to === id || !st.cats.categories.some((x) => x.id === to)) throw new E(409, 'CATEGORY_IN_USE', `${used.length} resource(s) use this category. Choose another category to move them to.`); for (const p of st.parts) p.items = p.items.map((x) => (x.categoryId === id ? { ...x, categoryId: to, updatedAt: new Date().toISOString() } : x)); }
        st.cats.categories = st.cats.categories.filter((x) => x.id !== id); });
      return ok({ id }, 'Category deleted'); }
  }
  if (path === '/api/backup/import' && M === 'POST') { const b = await body();
    if (b.schema !== 1 || !Array.isArray(b.items) || b.items.length > 5000) throw new E(400, 'VALIDATION_ERROR', 'Unsupported or invalid backup file');
    const r = await mutate(env, 'Import backup (merge)', (st) => { let added = 0, skipped = 0;
      for (const k of Array.isArray(b.categories) ? b.categories : []) if (k && /^[\w-]{1,40}$/.test(k.id) && !st.cats.categories.some((x) => x.id === k.id)) st.cats.categories.push({ id: k.id, name: str(k.name, 40, 'Category', true), color: cleanColor(k.color), builtin: false });
      const ids = new Set(allItems(st).map((x) => x.id)), urls = new Set(allItems(st).map((x) => x.url));
      for (const x of b.items) { if (!x || !/^[\w-]{8,40}$/.test(x.id || '') || ids.has(x.id) || urls.has(x.url)) { skipped++; continue; }
        const t = new Date().toISOString(); const f = cleanFields({ ...x, categoryId: st.cats.categories.some((k) => k.id === x.categoryId) ? x.categoryId : 'other' }, st, false);
        place(st, { id: x.id, ...{ description: '', notes: '', tags: [], status: 'unread', favorite: false }, ...f, createdAt: x.createdAt || t, updatedAt: t, deletedAt: x.deletedAt || null, lastViewedAt: null }); ids.add(x.id); urls.add(f.url); added++; }
      return { added, skipped }; });
    return ok(r, `Imported ${r.added}, skipped ${r.skipped}`); }
  throw new E(404, 'NOT_FOUND', 'Unknown endpoint');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), cx = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cx });
    try {
      let res;
      if (url.pathname === '/auth/github/start' && req.method === 'GET') res = await authStart(env, url);
      else if (url.pathname === '/auth/github/callback' && req.method === 'GET') res = await authCallback(env, req, url);
      else if (url.pathname === '/auth/logout' && req.method === 'POST') res = ok({}, 'Signed out on this device. Existing tokens stay valid until they expire.');
      else if (url.pathname.startsWith('/api/')) res = await api(env, req, url);
      else throw new E(404, 'NOT_FOUND', 'Not found');
      const h = new Headers(res.headers); for (const [k, v] of Object.entries(cx)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    } catch (e) {
      const known = e instanceof E; if (!known) e = new E(500, 'DEBUG', 'DEBUG: ' + (e && e.message));
      return send(known ? e.s : 500, { success: false, error: { code: known ? e.c : 'SERVER_ERROR', message: e.message } }, cx);
    }
  },
};
