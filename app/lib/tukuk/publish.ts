/*
 * tukuk/publish.ts — pakejkan projek WebContainer kepada SATU fail HTML mandiri dan
 * terbitkan ke kedai tukuk.org (/api/publish → /a/<slug> → muncul di /store).
 *
 * Reka bentuk (selari pelan): projek fail tunggal sahaja yang disokong sepenuhnya,
 * kerana pautan terbitan dihidang dalam sandbox opaque-origin (lihat src/publish.js
 * di repo utama) yang tidak boleh merujuk aset luar. Oleh itu:
 *   • MODE 1 — projek yang `index.html`-nya sudah mandiri (skrip inline / CDN /
 *     importmap, atau src ke fail JS SETEMPAT yang tidak meng-import fail setempat
 *     lain): baca terus dari WebContainer fs dan inline aset setempat.
 *   • MODE 2 — jika belum mandiri, cuba `npm run build` (config Vite milik projek,
 *     jadi plugin seperti React berjalan), kemudian inline keluaran `dist`. Jika
 *     binaan menghasilkan BERBANYAK chunk modul yang saling import (tak boleh
 *     dibungkus selamat tanpa bundler penuh), ralat jujur diberikan supaya pembina
 *     menyusun semula sebagai satu fail — TIADA apa-apa separuh diterbit.
 *
 * Tiada dependensi baru; hanya fs + spawn WebContainer + fetch.
 */
import { webcontainer } from '~/lib/webcontainer';

const PUBLISH_BASE = 'https://tukuk.org';
const PUBLISH_URL = `${PUBLISH_BASE}/api/publish`;
const PUBLISH_UPDATE_URL = `${PUBLISH_BASE}/api/publish/update`;

/** Ralat yang papannya boleh dibaca pengguna (bukan stack trace mentah). */
export class PublishError extends Error {}

export interface PublishResult {
  slug: string;
  url: string;
  editKey?: string;
}

export interface PublishHandleInput {
  slug: string;
  editKey: string;
}

// ── Pembantu WebContainer fs (laluan RELATIF kepada workdir) ──────────────────
async function readText(fs: any, rel: string): Promise<string | null> {
  try {
    const data = await fs.readFile(rel, 'utf8');
    return typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
  } catch {
    return null;
  }
}

async function readBytes(fs: any, rel: string): Promise<Uint8Array | null> {
  try {
    const data = await fs.readFile(rel);
    return data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
  } catch {
    return null;
  }
}

async function exists(fs: any, rel: string): Promise<boolean> {
  try {
    await fs.readFile(rel);
    return true;
  } catch {
    return false;
  }
}

// Normalisasi laluan pelayan → fail relatif workdir. `/assets/x.js` (Vite keluaran)
// dan `./x.js` (sumber) kedua-duanya selesaikan berbanding direktori HTML.
function resolveAsset(htmlDir: string, ref: string): string | null {
  let r = String(ref || '').trim();
  if (!r) return null;
  if (/^(https?:|data:|blob:|\/\/)/i.test(r)) return null; // luar → jangan sentuh
  r = r.split('?')[0].split('#')[0];
  const joined = r.startsWith('/') ? r.replace(/^\/+/, '') : `${htmlDir ? htmlDir + '/' : ''}${r}`;
  const parts = joined.split('/').filter((p) => p.length && p !== '.');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function base64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = Array.from(bytes.subarray(i, i + chunk));
    bin += String.fromCharCode(...slice);
  }
  return btoa(bin);
}

function mimeFor(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    js: 'text/javascript',
    mjs: 'text/javascript',
    css: 'text/css',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    wav: 'audio/wav',
    json: 'application/json',
  };
  return map[ext] || 'application/octet-stream';
}

// Adakah sesuatu kod modul JS SETEMPAT meng-import fail setempat lain? Jika ya, ia
// bukan satu chunk kendiri → tak boleh inline selamat tanpa bundler penuh.
function importsLocalModule(code: string, htmlDir: string, localPaths: Set<string>): boolean {
  const re = /(?:from|import)\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  const scan = (spec: string) => {
    const resolved = resolveAsset(htmlDir, spec);
    if (!resolved) return false; // CDN/data → ok
    const key = resolved.replace(/^\.?\//, '');
    if (localPaths.has(key)) return true;
    // fail JS setempat (sama folder/direktori output) yang mungkin wujud
    return /\.(m?js|cjs)(\?.*)?$/i.test(key);
  };
  while ((m = re.exec(code))) {
    if (scan(m[1] || m[2] || '')) return true;
  }
  return false;
}

/**
 * Inline satu dokumen HTML: ganti `<script src>`/`<link href>`/aset setempat dengan
 * kandungan sebaris / data-URL. Lempar PublishError jika binaan berbilang-chunk.
 */
async function inlineHtml(fs: any, htmlRel: string): Promise<string> {
  const htmlDir = htmlRel.includes('/') ? htmlRel.slice(0, htmlRel.lastIndexOf('/')) : '';
  let html = (await readText(fs, htmlRel)) ?? '';
  if (!html) throw new PublishError('index.html kosong atau tidak ditemui.');

  // Kumpul semua fail (untuk pengesanan import setempat) secara ringan: kita hanya
  // perlukan daftar path JS output. Jangka readdir rekursif `assets` jika wujud.
  const localJs = new Set<string>();
  const assetsDir = `${htmlDir ? htmlDir + '/' : ''}assets`;
  try {
    const entries = await fs.readdir(assetsDir);
    for (const e of entries) {
      const name = typeof e === 'string' ? e : (e && (e as any).path) || '';
      if (/\.(m?js|cjs)$/i.test(name)) localJs.add(`${assetsDir}/${name}`.replace(/^\.?\//, ''));
    }
  } catch {
    /* tiada direktori assets → mungkin semua inline sudah */
  }

  // 1) Script setempat → inline (atau data-URL untuk elak konflik).
  const scriptRe = /<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*?)>\s*<\/script>/gi;
  html = await html.replaceAsync(scriptRe, async (whole: string, _pre: string, srcRef: string, _post: string) => {
    const rel = resolveAsset(htmlDir, srcRef);
    if (!rel) return whole; // CDN → biarkan
    const code = await readText(fs, rel);
    if (code == null) return whole; // gagal baca → biarkan rujukan asal
    if (importsLocalModule(code, htmlDir.replace(/assets\/?$/, 'assets'), localJs)) {
      throw new PublishError(
        'Binaan ini berbilang modul (chunk) yang saling import dan tidak boleh dibungkus kepada satu fail. ' +
          'Susun projek sebagai satu index.html (Three.js/vanilla JS) supaya boleh diterbitkan.',
      );
    }
    const typeAttr = /\btype\s*=\s*["']module["']/i.test(whole) ? ' type="module"' : '';
    return `<script${typeAttr}>${code}</` + `script>`;
  });

  // 2) Stylesheet setempat → <style> (dengan url() ditulis-semula ke data-URL).
  const linkRe = /<link\b[^>]*?\brel\s*=\s*["']stylesheet["'][^>]*?>/gi;
  html = await html.replaceAsync(linkRe, async (whole: string) => {
    const hrefMatch = whole.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) return whole;
    const rel = resolveAsset(htmlDir, hrefMatch[1]);
    if (!rel) return whole;
    const css = await readText(fs, rel);
    if (css == null) return whole;
    const cssDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const inlined = await inlineCssUrls(fs, css, cssDir);
    return `<style>${inlined}</style>`;
  });

  // 3) Aset baki (img/source/icon/preload href) setempat → data-URL.
  const assetRe = /(<(?:img|source|audio|video|link)\b[^>]*?\b(?:src|href)\s*=\s*)(["'])([^"']+)\2/gi;
  html = await html.replaceAsync(assetRe, async (whole: string, lead: string, q: string, ref: string) => {
    const rel = resolveAsset(htmlDir, ref);
    if (!rel) return whole;
    const bytes = await readBytes(fs, rel);
    if (!bytes) return whole;
    return `${lead}${q}data:${mimeFor(rel)};base64,${base64(bytes)}${q}`;
  });

  return html;
}

async function inlineCssUrls(fs: any, css: string, cssDir: string): Promise<string> {
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  const out = await css.replaceAsync(re, async (whole: string, _q: string, ref: string) => {
    const rel = resolveAsset(cssDir, ref);
    if (!rel) return whole;
    const bytes = await readBytes(fs, rel);
    if (!bytes) return whole;
    return `url("data:${mimeFor(rel)};base64,${base64(bytes)}")`;
  });
  return out;
}

// ── Bina (MODE 2) ────────────────────────────────────────────────────────────
async function runBuild(): Promise<{ exit: number; output: string }> {
  const wc = await webcontainer;
  const proc = await wc.spawn('npm', ['run', 'build']);
  let output = '';
  const pipe = proc.output.pipeTo(
    new WritableStream({ write(data) { output += data; } }),
  ).catch(() => { /* abaikan ralat piping; output terkumpul tetap guna */ });
  const exit = await proc.exit;
  await pipe;
  return { exit, output };
}

async function hasViteConfig(fs: any): Promise<boolean> {
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']) {
    if (await exists(fs, name)) return true;
  }
  return false;
}

async function findBuiltIndex(fs: any): Promise<string | null> {
  for (const dir of ['dist', 'build', 'out']) {
    const p = `${dir}/index.html`;
    if (await exists(fs, p)) return p;
  }
  return null;
}

/**
 * Hasilkan SATU dokumen HTML mandiri daripada projek semasa.
 */
export async function buildSingleFileHtml(): Promise<{ html: string; looksLikeGame: boolean }> {
  const wc = await webcontainer;
  const fs = wc.fs;

  let htmlRel = 'index.html';
  if (!(await exists(fs, htmlRel))) {
    const built = await findBuiltIndex(fs);
    if (built) {
      htmlRel = built;
    } else {
      throw new PublishError('Projek tiada index.html untuk diterbitkan.');
    }
  }

  // Jika index.html sumber masih merujuk modul TSX/JS luar-setempat DAN ada config
  // Vite → bina dahulu supaya keluaran boleh inline.
  const source = (await readText(fs, htmlRel)) ?? '';
  const needsBuild = (await hasViteConfig(fs)) && /(\.tsx?|\.jsx?)(["'?]|\b)/.test(source) && !/^\s*<!doctype html>[\s\S]*<script[^>]*>[^<]{40,}/i.test(source);

  if (needsBuild) {
    const { exit, output } = await runBuild();
    if (exit !== 0) {
      throw new PublishError(`Binaan gagal (exit ${exit}). Cuba selesaikan ralat projek dahulu.\n\n${tail(output)}`);
    }
    const built = await findBuiltIndex(fs);
    if (!built) throw new PublishError('Binaan selesai tetapi tiada index.html dalam dist/.');
    htmlRel = built;
  }

  const html = await inlineHtml(fs, htmlRel);

  // Pengesanan game ringkas (untuk `kind`): kanvas / WebGL / Three.js / gelung RAF.
  const looksLikeGame =
    /<canvas|getContext\(['"]2d|webgl|three|babylon|requestAnimationFrame|createjs|phaser/i.test(html);

  return { html, looksLikeGame };
}

function tail(s: string, n = 800): string {
  return s.length <= n ? s : '…' + s.slice(-n);
}

// `String.prototype.replaceAsync` — polifil dalaman kecil (tiada bergantung luar).
declare global {
  interface String {
    replaceAsync(re: RegExp, asyncFn: (...args: any[]) => Promise<string>): Promise<string>;
  }
}

if (typeof (String.prototype as any).replaceAsync !== 'function') {
  Object.defineProperty(String.prototype, 'replaceAsync', {
    configurable: true,
    writable: true,
    value: async function (this: string, re: RegExp, asyncFn: (...args: any[]) => Promise<string>) {
      const arr: string[] = [];
      let match: RegExpExecArray | null;
      const rx = new RegExp(re.source, re.flags);
      // Kumpul semua padanan + pemisah
      let last = 0;
      while ((match = rx.exec(this))) {
        arr.push(this.slice(last, match.index));
        arr.push(await asyncFn(...match));
        last = match.index + match[0].length;
        if (match.index === rx.lastIndex) rx.lastIndex++; // elak gelung kosong
      }
      arr.push(this.slice(last));
      return arr.join('');
    },
  });
}

/**
 * Terbit (atau kemas kini) satu projek ke kedai tukuk.org. `handle` wujud →
 * `/api/publish/update` (kepemilikan via editKey); jika tidak → `/api/publish` baru.
 */
export async function publishProject(opts: {
  html: string;
  name: string;
  kind: 'game' | 'app';
  handle?: PublishHandleInput;
}): Promise<PublishResult> {
  const { html, name, kind, handle } = opts;
  const url = handle ? PUBLISH_UPDATE_URL : PUBLISH_URL;
  const body: Record<string, string> = { html, name, kind };
  if (handle) {
    body.slug = handle.slug;
    body.editKey = handle.editKey;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PublishError('Tidak dapat menghubungi tukuk.org (rangkaian?). Cuba lagi.');
  }

  const data = await res.json().catch(() => ({} as any));
  if (!res.ok || !data || data.ok !== true) {
    const msg = (data && (data.error || data.details)) || `Ralat pelayan (${res.status})`;
    throw new PublishError(String(msg));
  }

  return { slug: data.slug, url: data.url, editKey: data.editKey };
}
