const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript'), assert = require('node:assert/strict');
const { test } = require('node:test');
const root = path.join(__dirname, '..');
function load(file, deps = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => id in deps ? deps[id] : require(id),
    URL, URLSearchParams, AbortController, console, setTimeout, clearTimeout, ...globals });
  return exports;
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
const row = (id = 'work') => ({ id: 1, anime_id: id, anime_title: id, episode_number: 1,
  watch_time: 120, duration: 120, is_completed: true, watch_url: '/watch/' + id + '/1', updated_at: '2026-10-20T00:00:00Z' });
const response = { json: (body, init) => ({ body, ...init }) };

function promotion({ count = 45, detail = async () => null, sql: customSql } = {}) {
  let now = 0;
  const calls = [], cursors = [];
  const rows = Array.from({ length: count }, (_, i) => row(String(i).padStart(3, '0')));
  const sql = customSql || (async (strings, ...values) => {
    if (String(strings).includes('SELECT *')) {
      const cursor = values[1]; cursors.push(cursor);
      return [...rows.filter(r => r.anime_id > cursor), ...rows.filter(r => r.anime_id <= cursor)].slice(0, values[2]);
    }
    throw Error('unexpected write');
  });
  const api = load('src/lib/historyPromotion.ts', {
    './db': { getDb: () => sql, getSubtitleEpisodeStart: async () => 1 },
    './providers': { getProviderByAnimeId: id => ({ getAnimeDetail: async () => { calls.push(id); return detail(id); } }) },
  }, { Date: class extends Date { static now() { return now; } } });
  return { run: api.checkAndPromoteNewEpisodes, calls, cursors, setTime: n => { now = n; } };
}

test('saved history and per-work GET requests never wait on provider discovery', async () => {
  let discoveries = 0;
  const saved = [row()];
  const api = load('src/app/api/anime/history/route.ts', {
    'next/server': { NextResponse: response },
    '@/lib/auth': { getSessionUser: async () => ({ username: 'viewer' }), getCurrentUserId: async () => 'viewer' },
    '@/lib/db': { getDb: () => async () => saved, initDb: async () => {} },
    '@/lib/historyPromotion': { checkAndPromoteNewEpisodes: () => { discoveries++; return new Promise(() => {}); } },
  });
  for (const query of ['', '?anime_id=work']) {
    const result = await api.GET({ url: 'https://app.example/api/anime/history' + query });
    assert.equal(result.body.items, saved); assert.equal(result.headers['Cache-Control'], 'private, no-store');
  }
  assert.equal(discoveries, 0);
});

test('refresh endpoint authenticates the viewer and awaits discovery on its own request', async () => {
  let user = null, called = [], ready = deferred();
  const api = load('src/app/api/anime/history/refresh/route.ts', {
    'next/server': { NextResponse: class { constructor(body, init) { this.status = init.status; } static json = response.json; } },
    '@/lib/auth': { getSessionUser: async () => user },
    '@/lib/db': { getDb: () => ({}), initDb: async () => {} },
    '@/lib/historyPromotion': { checkAndPromoteNewEpisodes: id => { called.push(id); return ready.promise; } },
  });
  assert.equal((await api.POST()).status, 401); assert.equal(called.length, 0);
  user = { username: 'viewer' };
  let finished = false; const result = api.POST().then(r => { finished = true; return r; });
  await flush(); assert.equal(finished, false); assert.deepEqual(called, ['viewer']);
  ready.resolve(true); assert.equal((await result).body.changed, true);
});

test('refreshes share one in-flight check and preserve the ten-minute per-user interval', async () => {
  const gate = deferred(), p = promotion({ count: 1, detail: () => gate.promise });
  const a = p.run('viewer'), b = p.run('viewer'); assert.equal(a, b);
  await flush(); assert.equal(p.calls.length, 1); gate.resolve(null); await a;
  await p.run('viewer'); assert.equal(p.calls.length, 1);
  p.setTime(600000); await p.run('viewer'); assert.equal(p.calls.length, 2);
  await p.run('another-viewer'); assert.equal(p.calls.length, 3);
});

test('more than 20 completed works rotate and wrap without starving later works', async () => {
  const p = promotion();
  await p.run('viewer'); p.setTime(600000); await p.run('viewer');
  p.setTime(1200000); await p.run('viewer');
  assert.deepEqual(p.cursors, ['', '019', '039']);
  assert.equal(new Set(p.calls).size, 45); assert.equal(p.calls.length, 60);
});

test('budget exhaustion advances only past the attempted batch, not all 20 selected works', async () => {
  let p;
  p = promotion({ detail: async () => { p.setTime(7000); return null; } });
  await p.run('viewer'); assert.equal(p.calls.length, 5);
  p.setTime(607000); await p.run('viewer'); assert.equal(p.cursors[1], '004');
});

test('failed candidate queries can retry immediately instead of caching failure for ten minutes', async () => {
  let attempts = 0;
  const p = promotion({ sql: async () => { if (++attempts === 1) throw Error('temporary DB failure'); return []; } });
  await assert.rejects(p.run('viewer'));
  assert.equal(await p.run('viewer'), false); assert.equal(attempts, 2);
});

function historyComponent() {
  const states = [], effects = [], refs = [], requests = [];
  let stateIndex = 0, refIndex = 0, first = true;
  const fetch = (url, options = {}) => { const task = deferred(); requests.push({ url, options, ...task }); return task.promise; };
  const api = load('src/components/HistoryList.tsx', {
    react: { useState: initial => { const i = stateIndex++; if (first) states[i] = initial;
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
      useEffect: fn => { if (first) effects.push(fn); },
      useRef: initial => { const i = refIndex++; return refs[i] ||= { current: initial }; } },
    'next/link': { __esModule: true, default: 'a' },
    'lucide-react': { Clock: 'i', Film: 'i', CheckCircle2: 'i', X: 'i' },
  }, { fetch, window: { confirm: () => true } });
  const render = () => { stateIndex = 0; refIndex = 0; const tree = api.default({ initialItems: [row()] }); first = false; return tree; };
  const cleanup = [];
  return { render, mount: () => effects.forEach(fn => cleanup.push(fn())), unmount: () => cleanup.forEach(fn => fn?.()), states, requests };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const reply = body => ({ ok: true, json: async () => body });

test('client renders saved rows before refresh, then updates only after the independent refresh completes', async () => {
  const c = historyComponent(), initial = c.render();
  assert.ok(nodes(initial).some(n => n.props?.href === '/watch/work/1'));
  assert.equal(c.requests.length, 0); c.mount(); assert.equal(c.requests[0].url, '/api/anime/history/refresh');
  assert.equal(c.states[0][0].episode_number, 1);
  c.requests[0].resolve(reply({ success: true, changed: true })); await flush();
  assert.equal(c.requests[1].url, '/api/anime/history');
  c.requests[1].resolve(reply({ success: true, items: [{ ...row(), episode_number: 2, watch_time: 0 }] }));
  await flush(); assert.equal(c.states[0][0].episode_number, 2); assert.equal(c.states[3], false); c.unmount();
});

test('failed refresh preserves the saved list', async () => {
  const c = historyComponent(); c.render(); c.mount(); c.requests[0].resolve({ ok: false }); await flush();
  assert.equal(c.states[0][0].anime_id, 'work'); assert.equal(c.states[3], false); assert.equal(c.requests.length, 1); c.unmount();
});

test('deletion and unmount ignore late refresh responses even when fetch ignores abort', async () => {
  for (const action of ['item', 'all', 'unmount']) {
    const c = historyComponent(); const tree = c.render(); c.mount();
    c.requests[0].resolve(reply({ success: true, changed: true })); await flush();
    if (action === 'unmount') c.unmount();
    else {
      const button = nodes(tree).find(n => n.type === 'button' && (action === 'item'
        ? n.props.title === '이 기록 삭제' : n.props.children === '전체 기록 삭제'));
      void button.props.onClick({ preventDefault() {}, stopPropagation() {} });
      assert.equal(c.states[0].length, 0);
    }
    c.requests[1].resolve(reply({ success: true, items: [{ ...row(), episode_number: 2 }] })); await flush();
    assert.equal(c.states[0].length, action === 'unmount' ? 1 : 0);
    assert.equal(c.requests[1].options.signal.aborted, true);
    if (action !== 'unmount') { c.requests[2].resolve(reply({ success: true })); await flush(); c.unmount(); }
  }
});

test('Postgres rotation, microsecond timestamps, progress preservation and deleted-source guards',
  { skip: !process.env.REVIEWED_TEST_DATABASE_URL }, async () => {
    const postgres = require('postgres'), url = process.env.REVIEWED_TEST_DATABASE_URL;
    const schema = `history_refresh_${process.pid}_${Date.now()}`, admin = postgres(url, { max: 1 });
    let sql;
    try {
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      sql = postgres(url, { max: 3, connection: { search_path: schema } });
      await sql.unsafe(`CREATE TABLE anime_history (
        id SERIAL PRIMARY KEY,user_id TEXT,anime_id TEXT,anime_title TEXT,anime_poster TEXT,
        episode_number INT,episode_title TEXT,watch_url TEXT,watch_time REAL DEFAULT 0,duration REAL DEFAULT 0,
        is_completed BOOLEAN,updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,UNIQUE(user_id,anime_id,episode_number))`);
      for (const user of ['normal', 'deleted', 'progress', 'updated']) await sql`
        INSERT INTO anime_history(user_id,anime_id,anime_title,episode_number,watch_url,is_completed,updated_at)
        VALUES(${user},'work','Work',1,'/watch/work/1',TRUE,'2026-10-20 00:00:00.123456+00')`;
      await sql`INSERT INTO anime_history(user_id,anime_id,episode_number,watch_time,duration,is_completed,updated_at)
        VALUES('progress','work',2,80,120,FALSE,'2026-10-19')`;
      let onDetail = async () => {};
      const api = load('src/lib/historyPromotion.ts', {
        './db': { getDb: () => sql, getSubtitleEpisodeStart: async () => 13 },
        './providers': { getProviderByAnimeId: () => ({ getAnimeDetail: async (id, options) => {
          assert.equal(options.subtitleEpisodeStart, 13); await onDetail();
          return { title: 'Work', poster: '', sub_episodes: [
            { number: 3, title: '3', watch_url: '/watch/work/3' }, { number: 2, title: '2', watch_url: '/watch/work/2' }] };
        } }) },
      });
      assert.equal(await api.checkAndPromoteNewEpisodes('normal'), true);
      const normal = await sql`SELECT * FROM anime_history WHERE user_id='normal' ORDER BY episode_number`;
      assert.equal(normal.length, 2); assert.equal(normal[1].episode_number, 2); assert.equal(normal[1].watch_time, 0);
      assert.equal(await api.checkAndPromoteNewEpisodes('progress'), false);
      assert.equal((await sql`SELECT watch_time FROM anime_history WHERE user_id='progress' AND episode_number=2`)[0].watch_time, 80);
      // A change inside the same millisecond must still invalidate the snapshot.
      onDetail = async () => { await sql`UPDATE anime_history
        SET updated_at='2026-10-20 00:00:00.123457+00' WHERE user_id='updated'`; };
      assert.equal(await api.checkAndPromoteNewEpisodes('updated'), false);
      assert.equal((await sql`SELECT * FROM anime_history WHERE user_id='updated'`).length, 1);
      onDetail = async () => { await sql`DELETE FROM anime_history WHERE user_id='deleted'`; };
      assert.equal(await api.checkAndPromoteNewEpisodes('deleted'), false);
      assert.equal((await sql`SELECT * FROM anime_history WHERE user_id='deleted'`).length, 0);
      // Actual query ordering must cover all 45 works across three visits.
      for (let i = 0; i < 45; i++) await sql`INSERT INTO anime_history(user_id,anime_id,episode_number,is_completed)
        VALUES('rotation',${String(i).padStart(3,'0')},1,TRUE)`;
      let now = 0; const visited = [];
      const rotating = load('src/lib/historyPromotion.ts', {
        './db': { getDb: () => sql, getSubtitleEpisodeStart: async () => 1 },
        './providers': { getProviderByAnimeId: id => ({ getAnimeDetail: async () => { visited.push(id); return null; } }) },
      }, { Date: class extends Date { static now() { return now; } } });
      for (let i = 0; i < 3; i++) { now = i * 600000; await rotating.checkAndPromoteNewEpisodes('rotation'); }
      assert.equal(new Set(visited).size, 45); assert.equal(visited.length, 60);
    } finally { await sql?.end(); await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

test('history SSR returns saved rows without invoking episode discovery', async () => {
  let discoveries = 0;
  const empty = () => null, deps = {
    'next/headers': { cookies: async () => ({ get: () => ({ value: 'reanime' }) }) },
    'next/link': { __esModule: true, default: 'a' }, 'next/navigation': {},
    '@/lib/auth': { requireAuth: async () => ({ username: 'viewer' }), getCurrentUserId: async () => 'viewer' },
    '@/lib/db': { getEnabledStreamingProviders: async () => ['reanime'], getDb: () => async () => [row()], initDb: async () => {} },
    '@/lib/providers': { getProvider: () => ({}), LINKKF_GENRES: [], LINKKF_YEARS: [], LINKKF_TYPES: [], REANIME_GENRES: [] },
    '@/lib/providers/ohli24': {}, '@/lib/subtitles': {}, '@/lib/linkedReanimeCatalog': {}, '@/lib/koreanSubtitleCatalog': {},
    '@/lib/catalogSearchPagination': { searchCatalogVideoPage: async ({page, readPage}) => readPage(page) }, '@/lib/catalogVideoLinkStatus': { applyCatalogVideoLinkStatus: async items => items }, '@/lib/adminWorkTitles': { applyAdminWorkTitles: async items => items }, '@/lib/anissiaSearchStages': {},
    '@/lib/cloudflareAnimeSearch': {}, '@/lib/manualSubtitleSearch': {},
    '@/lib/animeSearchMode': { resolveAnimeSearchMode: () => 'page', shouldUseLocalDbFallback: () => false },
    '@/lib/historyPromotion': { checkAndPromoteNewEpisodes: () => { discoveries++; return new Promise(() => {}); } },
    'lucide-react': new Proxy({}, { get: () => empty }),
  };
  for (const name of ['Navbar', 'AnimeCard', 'HistoryList', 'ReanimeFeedFallback', 'AnissiaDbSearchFallback', 'AnikotoCatalogFilters']) {
    deps['@/components/' + name] = { __esModule: true, default: name };
  }
  const page = load('src/app/page.tsx', deps);
  const tree = await page.default({ searchParams: Promise.resolve({ tab: 'history' }) });
  const history = nodes(tree).find(n => n.type === 'HistoryList');
  assert.equal(history.props.initialItems[0].anime_id, 'work'); assert.equal(discoveries, 0);
});

test('a throttled refresh still reads changes another tab may have saved since SSR', async () => {
  const c = historyComponent(); c.render(); c.mount();
  c.requests[0].resolve(reply({ success: true, changed: false })); await flush();
  assert.equal(c.requests[1].url, '/api/anime/history');
  c.requests[1].resolve(reply({ success: true, items: [{ ...row(), episode_number: 2 }] })); await flush();
  assert.equal(c.states[0][0].episode_number, 2); c.unmount();
});
