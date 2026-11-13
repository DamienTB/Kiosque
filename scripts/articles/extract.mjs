// Kiosque - prépare la version hors connexion des articles.
// Lit data/pool.json, télécharge chaque article, garde le texte principal (Readability)
// et écrit data/articles/<id>.json. Ajoute à chaque article de pool.json le champ
// "offline" ("full" ou "partial") quand une version hors connexion existe.
// L'application télécharge ensuite ces fichiers pour les articles gardés dans « À lire ».
//
//   cd scripts/articles && npm ci && node extract.mjs [--only lemonde]

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const poolPath = join(root, 'data', 'pool.json');
const outDir = join(root, 'data', 'articles');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';

const CONCURRENCY = 8;
const TIMEOUT_MS = 20000;
const MAX_IMAGES = 4;    // images préchargées par article (place limitée sur le téléphone)
const PARTIAL_WORDS = 250;   // en dessous : probablement réservé aux abonnés (seul le début est lisible)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 KiosqueReader/1.0';

export const fileName = (id) => id.replace(/[^a-z0-9-]/gi, '-') + '.json';

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function absUrl(u, base) {
  if (!u) return null;
  try {
    const url = new URL(u.trim(), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

function imgSrc(el, base) {
  // images paresseuses : data-src, srcset… on prend la meilleure source disponible
  const cand = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original') || el.getAttribute('src');
  if (cand && !cand.startsWith('data:')) return absUrl(cand, base);
  const set = el.getAttribute('srcset') || el.getAttribute('data-srcset');
  if (set) {
    const parts = set.split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
    return absUrl(parts[parts.length - 1], base);
  }
  return null;
}

/* Transforme le HTML de Readability en une liste de blocs simples (texte brut uniquement),
   que l'application affiche sans jamais injecter de HTML venant des journaux. */
function toBlocks(html, base) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const blocks = [];
  let images = 0;
  const walk = (node) => {
    for (const el of node.children) {
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) { const t = clean(el.textContent); if (t) blocks.push({ t: 'h', text: t }); }
      else if (tag === 'p') {
        const t = clean(el.textContent);
        if (t) blocks.push({ t: 'p', text: t });
        else el.querySelectorAll('img').forEach((i) => addImg(i));
      }
      else if (tag === 'blockquote') { const t = clean(el.textContent); if (t) blocks.push({ t: 'q', text: t }); }
      else if (tag === 'ul' || tag === 'ol') {
        for (const li of el.querySelectorAll('li')) { const t = clean(li.textContent); if (t) blocks.push({ t: 'li', text: t }); }
      }
      else if (tag === 'img') addImg(el);
      else if (tag === 'figure' || tag === 'picture') {
        const i = el.querySelector('img');
        if (i) addImg(i, clean(el.querySelector('figcaption')?.textContent));
      }
      else if (tag === 'pre') { const t = el.textContent.trim(); if (t) blocks.push({ t: 'p', text: t }); }
      else if (['script', 'style', 'noscript', 'iframe', 'svg', 'form', 'button', 'aside'].includes(tag)) continue;
      else if (el.children.length) walk(el);
      else { const t = clean(el.textContent); if (t) blocks.push({ t: 'p', text: t }); }
    }
  };
  const addImg = (el, caption) => {
    if (images >= MAX_IMAGES) return;
    const src = imgSrc(el, base);
    const w = Number(el.getAttribute('width') || 0);
    if (!src || (w && w < 120)) return;
    images++;
    blocks.push({ t: 'img', src, caption: caption || clean(el.getAttribute('alt')) || undefined });
  };
  walk(document.body);
  return blocks;
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'fr,en;q=0.8,pt;q=0.6,it;q=0.6' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) throw new Error('pas une page HTML (' + type + ')');
    return { html: await res.text(), finalUrl: res.url || url };
  } finally { clearTimeout(timer); }
}

async function extract(item) {
  const { html, finalUrl } = await fetchPage(item.link);
  const { document } = parseHTML(html);
  const article = new Readability(document, { charThreshold: 300, keepClasses: false }).parse();
  if (!article?.content) throw new Error('texte introuvable');
  const blocks = toBlocks(article.content, finalUrl);
  // le titre est déjà affiché par l'application
  if (blocks[0]?.t === 'h' && blocks[0].text.toLowerCase() === clean(item.title).toLowerCase()) blocks.shift();
  const words = blocks.filter((b) => b.t !== 'img').reduce((n, b) => n + b.text.split(' ').length, 0);
  if (words < 40) throw new Error('texte trop court (' + words + ' mots)');
  return {
    id: item.id, link: item.link, title: item.title,
    byline: clean(article.byline) || undefined,
    words, partial: words < PARTIAL_WORDS,
    blocks,
  };
}

async function main() {
  const pool = JSON.parse(await readFile(poolPath, 'utf8'));
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const todo = pool.items.filter((it) => !only || it.source === only);
  const stats = {};
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const item = todo[next++];
      const st = (stats[item.source] ||= { ok: 0, partial: 0, err: 0, lastErr: '' });
      try {
        const art = await extract(item);
        await writeFile(join(outDir, fileName(item.id)), JSON.stringify(art));
        item.offline = art.partial ? 'partial' : 'full';
        art.partial ? st.partial++ : st.ok++;
      } catch (e) {
        delete item.offline;
        st.err++; st.lastErr = e.name === 'AbortError' ? 'délai dépassé' : e.message;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await writeFile(poolPath, JSON.stringify(pool));
  const rows = Object.entries(stats).map(([src, s]) => ({ journal: src, complets: s.ok, partiels: s.partial, echecs: s.err, erreur: s.lastErr }));
  console.table(rows);
  const total = rows.reduce((n, r) => n + r.complets + r.partiels, 0);
  console.log(`Hors connexion : ${total} / ${todo.length} articles -> ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
