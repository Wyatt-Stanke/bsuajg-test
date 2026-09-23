// The service worker: the game plays offline, and a newer build is downloaded whole before it replaces the one in use.
//
// It has no version of its own. The build it serves is named by version.json at the site root (src/offline.mjs writes
// it into every build): the project's semver version, an id that is the hash of the whole file list, and every file
// with its hash, its size, and whether the game needs it before the first frame (the music is streamed on demand, so
// it doesn't). Each build lives in its own cache, barkley-build-<id>; which one is served is kept in barkley-meta.
//
// A check downloads the files of a newer build into that build's own cache, taking from the caches already on disk
// every file whose hash hasn't changed. That build starts being served once the files the game needs to start are in,
// and the build it replaces is deleted only once every one of its files is in, so a download cut off halfway leaves
// what the player already had untouched and picks up where it stopped next time.

const META = 'barkley-meta';
const BUILD = 'barkley-build-';
const WORKERS = 4; // downloads at a time

const scope = self.registration.scope; // always ends in /
const at = (p) => new URL(p, scope).href;
const STATE = at('.state'); // in META: the build being served
const MANIFEST = at('.manifest'); // in each build's cache: that build's version.json

let syncing = null; // the running check, so two of them never download the same build twice
const pinned = new Map(); // client id -> the build id the page loaded with, so one page never mixes two builds

self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'check') e.waitUntil(check());
});

// ---- what is being served

const json = async (cache, url) => {
  const r = await cache.match(url);
  return r ? r.json() : null;
};
const state = async () => json(await caches.open(META), STATE);
const manifest = async (id) => json(await caches.open(BUILD + id), MANIFEST);
// path -> hash, for the files two builds have in common
const hashes = (m) => new Map(m.files.map((f) => [f[0], f[1]]));

// ---- the check: download a newer build, then serve it

function check() {
  if (!syncing) syncing = sync().catch(tell).finally(() => (syncing = null));
  return syncing;
}

async function sync() {
  const r = await fetch(at('version.json') + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('version.json: HTTP ' + r.status);
  const next = await r.json();
  const now = await state();
  if (now && now.id === next.id && now.complete) return tell();
  const cache = await caches.open(BUILD + next.id);
  // a build that is neither the one in use nor the one arriving is a check that was cut off before this one
  const keep = [BUILD + next.id, BUILD + (now && now.id)];
  for (const name of await caches.keys())
    if (name.startsWith(BUILD) && !keep.includes(name)) await caches.delete(name);
  // every file already here, from a check that stopped halfway
  const have = new Set((await cache.keys()).map((q) => q.url));
  // and the files the build in use holds unchanged, which are copied rather than downloaded again
  const from = [];
  for (const name of await caches.keys()) {
    if (!name.startsWith(BUILD) || name === BUILD + next.id) continue;
    const c = await caches.open(name);
    const m = await json(c, MANIFEST);
    if (m) from.push([c, hashes(m)]);
  }

  // the files the game needs to start come first, so it can be played before the music has finished arriving
  const want = next.files.slice().sort((a, b) => b[3] - a[3]);
  const total = { core: 0, all: 0 };
  for (const [, , bytes, core] of want) (total.all += bytes), (total.core += core ? bytes : 0);
  let left = want.filter((f) => f[3]).length;
  const done = { core: 0, all: 0 };
  let i = 0,
    failed = null,
    said = 0;
  const report = () => {
    if (Date.now() - said < 400) return;
    said = Date.now();
    tell({ version: next.version, done: done.all, total: total.all, core: left > 0 });
  };

  const worker = async () => {
    while (i < want.length && !failed) {
      const [p, hash, bytes, core] = want[i++];
      const url = at(p);
      try {
        if (!have.has(url)) {
          let res = null;
          for (const [c, index] of from)
            if (index.get(p) === hash && (res = await c.match(url, { ignoreSearch: true }))) break;
          // cache: reload, so the browser's own copy of a file whose name didn't change is never the one stored
          if (!res) res = await fetch(url, { cache: 'reload' });
          if (!res.ok) throw new Error(p + ': HTTP ' + res.status);
          await cache.put(url, res);
        }
        done.all += bytes;
        if (core) {
          done.core += bytes;
          // everything the game needs to start is here: serve this build from now on
          if (--left === 0) await use(next, false);
        }
        report();
      } catch (e) {
        failed = e;
      }
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  if (failed) throw failed;
  await use(next, true);
  return tell();
}

// Serve this build, and once every file of it is here, drop the ones it replaces.
async function use(next, complete) {
  const cache = await caches.open(BUILD + next.id);
  await cache.put(MANIFEST, new Response(JSON.stringify(next), { headers: { 'content-type': 'application/json' } }));
  const meta = await caches.open(META);
  await meta.put(
    STATE,
    new Response(JSON.stringify({ id: next.id, version: next.version, complete }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  if (complete)
    for (const name of await caches.keys())
      if (name.startsWith(BUILD) && name !== BUILD + next.id) await caches.delete(name);
  tell();
}

// What the Start screen shows: the version being played, and how far a download has got.
async function tell(downloading) {
  const now = await state();
  const msg = {
    type: 'offline',
    version: now ? now.version : null,
    complete: !!(now && now.complete),
    downloading: downloading instanceof Error || !downloading ? null : downloading,
    error: downloading instanceof Error ? String(downloading.message || downloading) : null,
  };
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg);
}

// ---- serving

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.href.startsWith(scope)) return;
  // the update check and the worker itself are always the network's to answer
  if (url.href === at('version.json') || url.href === at('sw.js')) return;
  e.respondWith(serve(req, e.resultingClientId || e.clientId, req.mode === 'navigate'));
});

async function serve(req, client, navigating) {
  const now = await state();
  if (!now) return fetch(req);
  // a page keeps the build it loaded with, so a build that arrives mid-session never mixes into it
  let id = now.id;
  if (navigating) pinned.set(client, id);
  else if (pinned.has(client)) id = pinned.get(client);
  // caches.open makes a cache that isn't there, so never ask it for a build that has since been dropped
  if (id !== now.id && !(await caches.keys()).includes(BUILD + id)) (id = now.id), pinned.delete(client);

  const cache = await caches.open(BUILD + id);
  let hit = await cache.match(req, { ignoreSearch: true });
  // a visit to the site root is a visit to the page
  if (!hit && navigating) hit = await cache.match(at('index.html'));
  // a file this build hasn't downloaded yet, which a build still on disk has unchanged
  if (!hit) hit = await elsewhere(req, id);
  if (hit) return ranged(req, hit);
  return fetch(req);
}

async function elsewhere(req, id) {
  const mine = await manifest(id);
  if (!mine) return null;
  const url = new URL(req.url);
  url.search = '';
  const p = url.href.slice(scope.length);
  const hash = hashes(mine).get(p);
  if (!hash) return null;
  for (const name of await caches.keys()) {
    if (!name.startsWith(BUILD) || name === BUILD + id) continue;
    const c = await caches.open(name);
    const m = await json(c, MANIFEST);
    if (!m || hashes(m).get(p) !== hash) continue;
    const hit = await c.match(url.href);
    if (hit) return hit;
  }
  return null;
}

// A cache holds whole files; Safari asks for a range of one when it plays audio through an <audio> element.
async function ranged(req, res) {
  const range = req.headers.get('range');
  if (!range || res.status !== 200) return res;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) return res;
  const body = await res.arrayBuffer();
  let start = m[1] ? +m[1] : body.byteLength - +m[2];
  let end = m[1] ? (m[2] ? Math.min(+m[2], body.byteLength - 1) : body.byteLength - 1) : body.byteLength - 1;
  if (!(start >= 0) || start > end) return new Response(null, { status: 416, statusText: 'Range Not Satisfiable' });
  const part = body.slice(start, end + 1);
  return new Response(part, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'content-type': res.headers.get('content-type') || 'application/octet-stream',
      'content-length': String(part.byteLength),
      'content-range': `bytes ${start}-${end}/${body.byteLength}`,
    },
  });
}
