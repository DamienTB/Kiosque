/* Kiosque — édition du matin à swiper, à partir de plusieurs journaux.
   Tout l'état (réglages, édition, liste « À lire ») est gardé sur l'appareil. */
'use strict';

const LANGS = [
  { code: 'fr', label: 'Français' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
  { code: 'en', label: 'English' },
];
const ACCESS_LABEL = { free: 'Gratuit', mixed: 'Mixte', paid: 'Payant' };
const FRESH_HOURS = 30;          // fenêtre « aujourd'hui et la veille »
const MAX_SEEN = 6000;
const MAX_LOG = 5000;

/* ---------- stockage local (protégé : peut être indisponible) ---------- */
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('kiosque.' + key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('kiosque.' + key, JSON.stringify(value)); } catch { /* stockage plein ou bloqué */ }
  },
};

/* ---------- lecture hors connexion ----------
   Chaque matin, GitHub prépare une version texte de chaque article (data/articles/<id>.json).
   Quand on garde un article, l'app télécharge ce texte et ses images dans le cache du téléphone :
   on peut ensuite le lire dans « À lire » sans réseau (dans le train…). */
const ART_CACHE = 'kiosque-articles';
const IMG_CACHE = 'kiosque-images';
const canCache = 'caches' in window;
const artUrl = (id) => new URL('data/articles/' + id.replace(/[^a-z0-9-]/gi, '-') + '.json', location.href).href;
const artImages = (art, lead) => [lead, ...(art.blocks || []).filter((b) => b.t === 'img').map((b) => b.src)].filter(Boolean);
const preloading = new Set();
let askedPersist = false;

async function preload(entry) {
  if (!canCache || entry.stored || !entry.offline || preloading.has(entry.id)) return;
  preloading.add(entry.id);
  try {
    if (!askedPersist) { askedPersist = true; navigator.storage?.persist?.().catch(() => {}); }
    const res = await fetch(artUrl(entry.id));
    if (!res.ok) throw new Error(res.status);
    const art = await res.clone().json();
    await (await caches.open(ART_CACHE)).put(artUrl(entry.id), res);
    const ic = await caches.open(IMG_CACHE);
    await Promise.all(artImages(art, entry.image).map(async (u) => {
      try {
        if (await ic.match(u)) return;
        // images d'autres sites : réponse « opaque », mais le navigateur sait l'afficher depuis le cache
        await ic.put(u, await fetch(u, { mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer' }));
      } catch { /* image indisponible : l'article reste lisible */ }
    }));
    const cur = saved.find((x) => x.id === entry.id);
    if (!cur) { forget(entry.id, entry.image); return; }
    cur.stored = true;
    cur.offline = art.partial ? 'partial' : 'full';
    store.set('saved', saved);
    if (!$('#view-saved').hidden) renderSaved();
  } catch { /* pas de réseau ou pas de version hors connexion : on réessaiera plus tard */ }
  finally { preloading.delete(entry.id); }
}

async function forget(id, lead) {
  if (!canCache) return;
  try {
    const ac = await caches.open(ART_CACHE);
    const res = await ac.match(artUrl(id));
    if (!res) return;
    const art = await res.json();
    const keep = new Set(saved.filter((s) => s.id !== id).map((s) => s.image));
    const ic = await caches.open(IMG_CACHE);
    await Promise.all(artImages(art, lead).filter((u) => !keep.has(u)).map((u) => ic.delete(u)));
    await ac.delete(artUrl(id));
  } catch { /* rien de grave */ }
}

// rattrape les articles gardés sans réseau, ou avant que leur version hors connexion soit connue
function syncOffline() {
  if (!canCache || !navigator.onLine) return;
  const byId = Object.fromEntries((pool?.items || []).map((it) => [it.id, it]));
  for (const s of saved) {
    if (s.stored || s.read) continue;
    if (!s.offline && byId[s.id]?.offline) { s.offline = byId[s.id].offline; store.set('saved', saved); }
    preload(s);
  }
}
window.addEventListener('online', syncOffline);

/* ---------- état ---------- */
let SOURCES = [];                 // depuis sources.json
let SRC = {};                     // id -> source
let pool = null;                  // data/pool.json
let settings = null;
let edition = store.get('edition', null);
let saved = store.get('saved', []);
let seen = new Set(store.get('seen', []));
let log = store.get('log', []);
let savedFilter = 'unread';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/* ---------- dates ---------- */
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  if (localDay(d) === localDay()) return `il y a ${Math.round(mins / 60)} h`;
  const y = new Date(); y.setDate(y.getDate() - 1);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (localDay(d) === localDay(y)) return `hier, ${hm}`;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ', ' + hm;
}

function dayLabel(dayStr) {
  if (dayStr === localDay()) return "Aujourd'hui";
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (dayStr === localDay(y)) return 'Hier';
  const [Y, M, D] = dayStr.split('-').map(Number);
  return new Date(Y, M - 1, D).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

/* ---------- réglages ---------- */
function loadSettings() {
  const s = store.get('settings', {});
  const out = {
    size: s.size || 40,
    weights: Object.assign({ fr: 40, pt: 20, it: 20, en: 20 }, s.weights || {}),
    sources: {},
  };
  for (const src of SOURCES) {
    const prev = (s.sources || {})[src.id] || {};
    out.sources[src.id] = {
      enabled: prev.enabled ?? !!src.enabled,
      subscribed: prev.subscribed ?? !!src.subscribed,
    };
  }
  return out;
}
const saveSettings = () => store.set('settings', settings);
const isEnabled = (id) => settings.sources[id]?.enabled;
const isSubscribed = (id) => settings.sources[id]?.subscribed;

/* ---------- composition de l'édition ---------- */
function candidates(exclude) {
  const now = Date.now();
  const all = (pool?.items || []).filter((it) => SRC[it.source] && isEnabled(it.source) && !exclude.has(it.id));
  const fresh = all.filter((it) => !it.published || now - new Date(it.published) < FRESH_HOURS * 3600e3);
  return fresh.length >= 10 ? fresh : all;
}

function compose(n, exclude) {
  const cands = candidates(exclude);
  const byLang = {};
  for (const it of cands) (byLang[SRC[it.source].lang] ||= []).push(it);

  // quotas par langue, proportionnels aux poids, avec redistribution si une langue manque d'articles
  const quota = {};
  let active = LANGS.map((l) => l.code).filter((c) => byLang[c]?.length && settings.weights[c] > 0);
  let remaining = n;
  while (remaining > 0 && active.length) {
    const sumW = active.reduce((s, c) => s + settings.weights[c], 0);
    let given = 0;
    const next = [];
    for (const c of active) {
      const want = Math.max(1, Math.round((remaining * settings.weights[c]) / sumW));
      const room = byLang[c].length - (quota[c] || 0);
      const take = Math.min(want, room, remaining - given);
      quota[c] = (quota[c] || 0) + take;
      given += take;
      if (byLang[c].length - quota[c] > 0) next.push(c);
    }
    remaining -= given;
    if (given === 0) break;
    active = next;
  }

  // dans chaque langue : tourniquet entre journaux, du plus récent au plus ancien
  const picked = {};
  for (const [c, q] of Object.entries(quota)) {
    const bySrc = {};
    for (const it of byLang[c]) (bySrc[it.source] ||= []).push(it);
    const queues = Object.values(bySrc).map((arr) => arr.sort((a, b) => (b.published || '').localeCompare(a.published || '')));
    queues.sort((a, b) => (b[0].published || '').localeCompare(a[0].published || ''));
    const out = [];
    while (out.length < q && queues.some((qq) => qq.length)) {
      for (const qq of queues) { if (qq.length && out.length < q) out.push(qq.shift()); }
    }
    picked[c] = out;
  }

  // on entrelace les langues pour qu'elles soient réparties sur toute l'édition
  const merged = [];
  for (const [c, arr] of Object.entries(picked)) {
    arr.forEach((it, k) => merged.push({ it, key: (k + 0.5) / arr.length, li: LANGS.findIndex((l) => l.code === c) }));
  }
  merged.sort((a, b) => a.key - b.key || a.li - b.li);
  return merged.map((m) => m.it);
}

function newEdition() {
  // l'édition précédente rejoint les articles déjà vus
  if (edition) {
    for (const it of edition.items) seen.add(it.id);
    const arr = Array.from(seen);
    seen = new Set(arr.slice(Math.max(0, arr.length - MAX_SEEN)));
    store.set('seen', Array.from(seen));
  }
  edition = { date: localDay(), composedAt: new Date().toISOString(), poolAt: pool.generatedAt, items: compose(settings.size, seen), pos: 0, decisions: {} };
  store.set('edition', edition);
}

function recompose() {
  const decided = edition.items.slice(0, edition.pos);
  const exclude = new Set([...seen, ...decided.map((i) => i.id)]);
  edition.items = decided.concat(compose(Math.max(0, settings.size - decided.length), exclude));
  edition.poolAt = pool.generatedAt;
  store.set('edition', edition);
  render();
  toast("Édition recomposée");
}

/* ---------- décisions ---------- */
function decide(action) {
  const item = edition.items[edition.pos];
  if (!item) return;
  edition.decisions[item.id] = action;
  edition.pos++;
  if (action === 'keep' && !saved.some((s) => s.id === item.id)) {
    const offline = item.offline || pool?.items.find((it) => it.id === item.id)?.offline;
    const entry = Object.assign({}, item, { savedAt: new Date().toISOString(), day: edition.date, read: false, offline, stored: false });
    saved.unshift(entry);
    store.set('saved', saved);
    preload(entry);
  }
  log.push({ id: item.id, source: item.source, lang: SRC[item.source]?.lang, category: item.category, action, t: Date.now() });
  if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
  store.set('log', log);
  store.set('edition', edition);
}

function undo() {
  if (!edition || edition.pos === 0) return;
  edition.pos--;
  const item = edition.items[edition.pos];
  const action = edition.decisions[item.id];
  delete edition.decisions[item.id];
  if (action === 'keep') { saved = saved.filter((s) => s.id !== item.id); store.set('saved', saved); forget(item.id, item.image); }
  log.pop(); store.set('log', log);
  store.set('edition', edition);
  renderStack(); renderProgress(); renderSavedCount();
}

/* ---------- rendu : badges ---------- */
function accessBadge(srcId) {
  const src = SRC[srcId];
  if (!src) return null;
  if (isSubscribed(srcId)) return h('span', { class: 'acc sub' }, 'Abonné');
  return h('span', { class: 'acc ' + src.access }, ACCESS_LABEL[src.access]);
}
function metaLine(item) {
  const src = SRC[item.source] || { name: item.source, lang: '?' };
  return [
    h('span', { class: 'lang' }, src.lang.toUpperCase()),
    h('span', { class: 'src' }, src.name),
    accessBadge(item.source),
    item.published ? h('span', null, relTime(item.published)) : null,
  ];
}
function img(src, alt) {
  const el = h('img', { src, alt: alt || '', loading: 'lazy', referrerpolicy: 'no-referrer', decoding: 'async' });
  el.addEventListener('error', () => { el.parentElement?.classList.add('noimg-fallback'); el.remove(); });
  return el;
}

/* ---------- rendu : pile de cartes ---------- */
function cardEl(item, depth) {
  const src = SRC[item.source] || { name: item.source };
  const media = item.image
    ? h('div', { class: 'card-img' }, img(item.image), h('div', { class: 'fallback-name' }, src.name))
    : h('div', { class: 'card-img noimg' }, src.name);
  const el = h('article', { class: 'card' + (depth === 1 ? ' behind' : depth === 2 ? ' behind2' : ''), 'aria-hidden': depth ? 'true' : null },
    h('div', { class: 'stamp keep' }, 'GARDER'),
    h('div', { class: 'stamp skip' }, 'PASSER'),
    media,
    h('div', { class: 'card-body' },
      h('div', { class: 'meta' }, metaLine(item)),
      h('h2', null, item.title),
      item.summary ? h('p', null, item.summary) : null,
    ),
  );
  return el;
}

function renderStack() {
  const stack = $('#stack');
  stack.replaceChildren();
  const items = edition?.items || [];
  const pos = edition?.pos || 0;
  const done = pos >= items.length;
  $('#btn-skip').disabled = done;
  $('#btn-keep').disabled = done;
  $('#btn-undo').disabled = pos === 0;
  $('#hint').hidden = done || pos > 2;

  if (!items.length) {
    stack.append(h('div', { class: 'empty' },
      h('h2', null, 'Aucun article'),
      h('p', null, "Aucun article disponible pour les journaux sélectionnés. Active d'autres journaux dans les réglages."),
      h('button', { class: 'btn', onclick: () => showTab('settings') }, 'Ouvrir les réglages')));
    return;
  }
  if (done) {
    const kept = Object.values(edition.decisions).filter((a) => a === 'keep').length;
    stack.append(h('div', { class: 'empty' },
      h('h2', null, "C'est tout pour ce matin"),
      h('p', null, `Tu as gardé ${kept} article${kept > 1 ? 's' : ''} sur ${items.length}.`, h('br'), "La prochaine édition arrive demain matin."),
      h('button', { class: 'btn primary', onclick: () => showTab('saved') }, 'Voir ma liste À lire')));
    return;
  }
  for (let d = 2; d >= 0; d--) {
    const it = items[pos + d];
    if (it) stack.append(cardEl(it, d));
  }
  attachDrag(stack.lastElementChild, items[pos]);
}

function renderProgress() {
  if (!edition?.items.length) { $('#progress').textContent = ''; return; }
  const p = Math.min(edition.pos + 1, edition.items.length);
  $('#progress').textContent = edition.pos >= edition.items.length ? 'Terminé' : `${p} / ${edition.items.length}`;
}

/* ---------- glisser ---------- */
let busy = false;
function attachDrag(card, item) {
  let startX = 0, startY = 0, dx = 0, dy = 0, t0 = 0, active = false;
  const stampKeep = card.querySelector('.stamp.keep');
  const stampSkip = card.querySelector('.stamp.skip');

  card.addEventListener('pointerdown', (e) => {
    if (busy || e.button > 0) return;
    active = true; startX = e.clientX; startY = e.clientY; dx = dy = 0; t0 = performance.now();
    card.setPointerCapture(e.pointerId);
    card.classList.add('dragging');
  });
  card.addEventListener('pointermove', (e) => {
    if (!active) return;
    dx = e.clientX - startX; dy = e.clientY - startY;
    card.style.transform = `translate(${dx}px, ${dy * 0.3}px) rotate(${dx / 18}deg)`;
    const r = Math.min(1, Math.abs(dx) / 110);
    stampKeep.style.opacity = dx > 0 ? r : 0;
    stampSkip.style.opacity = dx < 0 ? r : 0;
  });
  const end = () => {
    if (!active) return;
    active = false;
    card.classList.remove('dragging');
    const dt = performance.now() - t0;
    const fast = Math.abs(dx) > 40 && dt < 250;
    if (Math.abs(dx) > 110 || fast) {
      fling(dx > 0 ? 'keep' : 'skip', card);
    } else {
      card.style.transform = '';
      stampKeep.style.opacity = stampSkip.style.opacity = 0;
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6 && dt < 400) openDetail(item, true);
    }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

function fling(action, card) {
  if (busy || !edition || edition.pos >= edition.items.length) return;
  card = card || $('#stack .card:last-of-type');
  busy = true;
  if (card) {
    const dir = action === 'keep' ? 1 : -1;
    card.querySelector(`.stamp.${action}`).style.opacity = 1;
    card.style.transform = `translate(${dir * window.innerWidth * 1.2}px, 40px) rotate(${dir * 24}deg)`;
    card.style.opacity = '0';
  }
  setTimeout(() => {
    decide(action);
    busy = false;
    renderStack(); renderProgress(); renderSavedCount();
  }, card ? 230 : 0);
}

/* ---------- détail ---------- */
function openDetail(item, fromStack) {
  const dlg = $('#detail');
  const box = $('#detail-img');
  box.replaceChildren();
  box.className = 'detail-img' + (item.image ? '' : ' noimg');
  if (item.image) box.append(img(item.image));
  $('#detail-meta').replaceChildren(...metaLine(item).filter(Boolean));
  $('#detail-title').textContent = item.title;
  $('#detail-summary').textContent = item.summary || '';
  $('#detail-link').href = item.link;
  $('#detail-actions').hidden = !fromStack;
  dlg.showModal();
}
$('#detail-close').addEventListener('click', () => $('#detail').close());
$('#detail').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('#detail-actions').addEventListener('click', (e) => {
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  $('#detail').close();
  fling(act);
});

/* ---------- À lire ---------- */
function renderSavedCount() {
  const n = saved.filter((s) => !s.read).length;
  const b = $('#saved-count');
  b.hidden = n === 0;
  b.textContent = n;
}

function renderSaved() {
  const list = $('#saved-list');
  list.replaceChildren();
  const items = saved.filter((s) => savedFilter === 'all' || !s.read);
  if (!items.length) {
    list.append(h('p', { class: 'saved-empty' }, savedFilter === 'unread' && saved.length
      ? 'Tout est lu. Bravo !'
      : "Rien pour l'instant. Glisse des articles à droite dans l'édition du matin pour les retrouver ici."));
    return;
  }
  let lastDay = null;
  for (const s of items) {
    if (s.day !== lastDay) { list.append(h('div', { class: 'day' }, dayLabel(s.day))); lastDay = s.day; }
    const row = h('div', { class: 'item' + (s.read ? ' read' : '') },
      h('a', { class: 'open', href: s.link, target: '_blank', rel: 'noopener', onclick: (e) => {
        if (s.stored) { e.preventDefault(); openReader(s); } else setRead(s.id, true);
      } },
        s.image ? h('div', { class: 'thumb' }, img(s.image)) : null,
        h('div', { class: 'txt' }, h('div', { class: 'meta' }, metaLine(s)), h('h3', null, s.title), offlineTag(s))),
      h('div', { class: 'item-actions' },
        h('button', { class: 'icon-btn' + (s.read ? ' on' : ''), 'aria-label': s.read ? 'Marquer comme non lu' : 'Marquer comme lu', onclick: () => setRead(s.id, !s.read) },
          svgIcon('M5 12l5 5L20 7')),
        h('button', { class: 'icon-btn', 'aria-label': 'Retirer de la liste', onclick: () => removeSaved(s.id) },
          svgIcon('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'))));
    list.append(row);
  }
}

function offlineTag(s) {
  if (!s.stored) return null;
  return s.offline === 'partial'
    ? h('span', { class: 'offline partial', title: "Réservé aux abonnés : seul le début est disponible sans réseau" }, svgIcon('M12 4v11M7 10l5 5 5-5M5 20h14'), 'Début hors ligne')
    : h('span', { class: 'offline', title: 'Lisible sans réseau' }, svgIcon('M12 4v11M7 10l5 5 5-5M5 20h14'), 'Hors ligne');
}

/* ---------- liseuse (articles préchargés) ---------- */
async function openReader(s) {
  let art = null;
  try { art = await (await (await caches.open(ART_CACHE)).match(artUrl(s.id)))?.json(); } catch { art = null; }
  if (!art) {   // cache vidé par le téléphone : on retombe sur le site
    s.stored = false; store.set('saved', saved);
    setRead(s.id, true);
    window.open(s.link, '_blank', 'noopener');
    return;
  }
  const body = $('#reader-body');
  const blocks = art.blocks || [];
  const out = [
    h('div', { class: 'meta' }, metaLine(s)),
    h('h1', null, s.title),
    art.byline ? h('p', { class: 'byline' }, art.byline) : null,
  ];
  if (s.image && !blocks.some((b) => b.t === 'img' && b.src === s.image)) out.push(h('figure', null, img(s.image)));
  let list = null;
  for (const b of blocks) {
    if (b.t !== 'li') list = null;
    if (b.t === 'p') out.push(h('p', null, b.text));
    else if (b.t === 'h') out.push(h('h2', null, b.text));
    else if (b.t === 'q') out.push(h('blockquote', null, b.text));
    else if (b.t === 'li') { if (!list) { list = h('ul'); out.push(list); } list.append(h('li', null, b.text)); }
    else if (b.t === 'img') out.push(h('figure', null, img(b.src, b.caption), b.caption ? h('figcaption', null, b.caption) : null));
  }
  if (art.partial) {
    out.push(h('p', { class: 'reader-note' }, "La suite est réservée aux abonnés : seul le début de l'article a pu être enregistré. Ouvre-le sur le site une fois connecté."));
  }
  out.push(h('a', { class: 'btn', href: s.link, target: '_blank', rel: 'noopener' }, "Ouvrir l'article sur le site"));
  body.replaceChildren(...out.filter(Boolean));
  $('#reader-link').href = s.link;
  $('#reader').showModal();
  $('#reader').scrollTop = 0;
  setRead(s.id, true);
}
$('#reader-close').addEventListener('click', () => $('#reader').close());

function svgIcon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d);
  svg.append(p);
  return svg;
}

function setRead(id, read) {
  const s = saved.find((x) => x.id === id);
  if (!s) return;
  s.read = read;
  store.set('saved', saved);
  // laisser le lien s'ouvrir avant de redessiner
  setTimeout(() => { renderSaved(); renderSavedCount(); }, 50);
}

function removeSaved(id) {
  const idx = saved.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const [removed] = saved.splice(idx, 1);
  store.set('saved', saved);
  renderSaved(); renderSavedCount();
  // la version hors connexion n'est effacée qu'une fois le délai d'annulation passé
  const timer = setTimeout(() => { if (!saved.some((x) => x.id === id)) forget(id, removed.image); }, 4500);
  toast('Article retiré', 'Annuler', () => {
    clearTimeout(timer);
    saved.splice(idx, 0, removed);
    store.set('saved', saved);
    renderSaved(); renderSavedCount();
  });
}

$$('.seg button').forEach((b) => b.addEventListener('click', () => {
  savedFilter = b.dataset.filter;
  $$('.seg button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  renderSaved();
}));

/* ---------- Réglages ---------- */
function renderSettings() {
  const size = $('#size');
  size.value = settings.size;
  $('#size-out').textContent = settings.size;
  size.oninput = () => { settings.size = Number(size.value); $('#size-out').textContent = size.value; saveSettings(); };

  const counts = {};
  for (const it of pool?.items || []) counts[it.source] = (counts[it.source] || 0) + 1;

  const lw = $('#lang-weights');
  lw.replaceChildren();
  const pct = () => {
    const tot = LANGS.reduce((s, l) => s + settings.weights[l.code], 0) || 1;
    for (const l of LANGS) $(`#w-out-${l.code}`).textContent = Math.round((settings.weights[l.code] / tot) * 100) + ' %';
  };
  for (const l of LANGS) {
    const input = h('input', { type: 'range', min: 0, max: 100, step: 5, value: settings.weights[l.code], 'aria-label': 'Part ' + l.label });
    input.addEventListener('input', () => { settings.weights[l.code] = Number(input.value); saveSettings(); pct(); });
    lw.append(h('label', { class: 'weight' }, h('span', null, l.label), input, h('output', { id: 'w-out-' + l.code })));
  }
  pct();

  const box = $('#sources');
  box.replaceChildren();
  for (const l of LANGS) {
    const group = h('div', { class: 'lang-group' }, h('h3', null, l.label));
    for (const src of SOURCES.filter((s) => s.lang === l.code)) {
      const st = settings.sources[src.id];
      const n = counts[src.id] || 0;
      const toggle = h('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Afficher ' + src.name });
      toggle.checked = st.enabled;
      toggle.addEventListener('change', () => { st.enabled = toggle.checked; saveSettings(); });
      const sub = h('input', { type: 'checkbox' });
      sub.checked = st.subscribed;
      sub.addEventListener('change', () => { st.subscribed = sub.checked; saveSettings(); renderSettings(); renderStack(); });
      group.append(h('div', { class: 'src-row' },
        h('div', { class: 'name' }, src.name, accessBadge(src.id),
          h('span', { class: 'count' }, n ? `${n} articles` : 'aucun article en ce moment')),
        h('label', { class: 'switch' }, toggle, h('span')),
        src.access !== 'free' ? h('label', { class: 'sub' }, sub, 'Abonné') : null));
    }
    box.append(group);
  }

  if (pool) {
    const d = new Date(pool.generatedAt);
    $('#pool-info').textContent = `Articles mis à jour le ${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${pad(d.getHours())}:${pad(d.getMinutes())} · ${pool.items.length} articles de ${Object.keys(counts).length} journaux`;
  }
}
$('#btn-recompose').addEventListener('click', () => { if (pool && edition) { recompose(); showTab('edition'); } });

/* ---------- onglets ---------- */
function showTab(name) {
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  $$('.tabbar button').forEach((b) => { if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $('#progress').style.visibility = name === 'edition' ? 'visible' : 'hidden';
  if (name === 'saved') renderSaved();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}
$$('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- clavier (ordinateur) ---------- */
document.addEventListener('keydown', (e) => {
  if ($('#detail').open || $('#view-edition').hidden) return;
  if (e.target.matches('input, textarea')) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); fling('keep'); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); fling('skip'); }
  else if (e.key === 'Backspace' || (e.key === 'z' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); undo(); }
  else if (e.key === 'Enter' || e.key === ' ') {
    const it = edition?.items[edition.pos];
    if (it) { e.preventDefault(); openDetail(it, true); }
  }
});
$('#btn-keep').addEventListener('click', () => fling('keep'));
$('#btn-skip').addEventListener('click', () => fling('skip'));
$('#btn-undo').addEventListener('click', undo);

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg, actionLabel, action) {
  const t = $('#toast');
  t.replaceChildren(msg);
  if (actionLabel) {
    t.append(' · ', h('button', { class: 'icon-btn', style: 'color:inherit;font-weight:700;padding:0 4px', onclick: () => { t.hidden = true; action(); } }, actionLabel));
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

/* ---------- démarrage ---------- */
function render() {
  $('#edition-date').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  renderStack(); renderProgress(); renderSavedCount();
}

function showWaiting() {
  $('#stack').replaceChildren(h('div', { class: 'empty' },
    h('h2', null, "L'édition du jour se prépare"),
    h('p', null, "Les journaux du matin n'ont pas encore été relevés. Reviens dans un moment."),
    h('button', { class: 'btn', onclick: () => { newEdition(); render(); } }, 'Voir quand même les articles disponibles')));
  ['#btn-skip', '#btn-keep', '#btn-undo'].forEach((s) => { $(s).disabled = true; });
  $('#progress').textContent = '';
}

async function init() {
  try {
    SOURCES = await fetch('sources.json').then((r) => r.json());
  } catch {
    SOURCES = [];
  }
  SRC = Object.fromEntries(SOURCES.map((s) => [s.id, s]));
  settings = loadSettings();
  saveSettings();

  try {
    pool = await fetch('data/pool.json', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  } catch {
    pool = null;
  }

  $('#edition-date').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  if (!edition || edition.date !== localDay()) {
    if (!pool) {
      $('#stack').replaceChildren(h('div', { class: 'empty' }, h('h2', null, 'Pas de connexion'), h('p', null, "Impossible de récupérer les articles. Vérifie ta connexion et réessaie."),
        h('button', { class: 'btn', onclick: () => location.reload() }, 'Réessayer')));
      renderSavedCount();
      return;
    }
    const poolIsToday = localDay(new Date(pool.generatedAt)) === localDay();
    if (!poolIsToday && edition) { showWaiting(); renderSavedCount(); syncOffline(); return; }
    newEdition();
  }
  render();
  syncOffline();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
init();
