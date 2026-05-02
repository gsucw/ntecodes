#!/usr/bin/env node
/**
 * NTE Codes Auto-Checker
 *
 * Checks sources for new NTE codes and updates timestamps.
 *
 * Sources:
 *   1. Pocket Tactics (primary, server-rendered, works)
 *   2. Self-check via ntecodes.xyz (deployment consistency)
 *
 * Note: Most gaming sites (GameSpot, IGN, Reddit, PCInvasion, etc.)
 *       block our server IP via Cloudflare. Adding new sources requires
 *       finding sites that are accessible from this server.
 *
 * Usage:  node scripts/check-nte-codes.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const SITEMAP = path.join(ROOT, 'sitemap.xml');
const DRY = process.argv.includes('--dry-run');

// ── Sources ─────────────────────────────────────────────────────────────────
// Pocket Tactics is the only external source our server can reliably access.
// The self-check (ntecodes.xyz) is for deployment consistency, not new codes.
const SOURCES = [
  { url: 'https://www.pockettactics.com/neverness-to-everness/codes', label: 'Pocket Tactics', type: 'pocket' },
  { url: 'https://ntecodes.xyz/',                                      label: 'Self-check',      type: 'codesite' },
];

// ── Date helpers ────────────────────────────────────────────────────────────
function fmt() {
  const d = new Date();
  return `${d.toLocaleDateString('en-US',{month:'long',timeZone:'UTC'})} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function iso() { return new Date().toISOString().slice(0,10); }
function utc() { return new Date().toISOString().replace(/\.\d{3}Z$/,'Z'); }
function log(m){ console.log(`[${new Date().toISOString().replace('T',' ').slice(0,19)}] ${m}`); }

function fetch(u) {
  return new Promise((ok, fail) => {
    const mod = u.startsWith('https') ? https : require('http');
    mod.get(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NTECodesBot/1.0; +https://ntecodes.xyz)', 'Accept': 'text/html' },
      timeout: 12000,
    }, r => {
      if (r.statusCode >= 400) { fail(new Error(`HTTP ${r.statusCode}`)); return; }
      if (r.statusCode >= 300 && r.headers.location) {
        const loc = r.headers.location.startsWith('http') ? r.headers.location : new URL(r.headers.location, u).href;
        fetch(loc).then(ok).catch(fail); return;
      }
      let d = ''; r.on('data', c => d += c); r.on('end', () => ok(d));
    }).on('error', fail);
  });
}

function strip(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'')
    .replace(/<br\s*\/?>/gi,'\n').replace(/<\/p>/gi,'\n').replace(/<\/li>/gi,'\n').replace(/<[^>]+>/g,'')
    .replace(/&amp;/g,'&').replace(/&nbsp;/g,' ');
}

function valid(code) {
  if (/^NTE[A-Za-z0-9]+$/.test(code) && code.length >= 6) return true;
  if (/^YH[A-Za-z0-9]+$/.test(code) && code.length >= 6) return true;
  if (/^504\d+$/.test(code)) return true;
  if (/^MIGU[A-Za-z0-9]+$/.test(code)) return true;
  if (/^[A-Za-z0-9]{6,20}$/.test(code)) return true;
  return false;
}

// ── Parsers ─────────────────────────────────────────────────────────────────
function parseCodes(html, type) {
  const map = new Map();
  if (type === 'codesite') {
    const re = /<div class="code-string">([A-Za-z0-9]+)<\/div>/g;
    let m; while ((m = re.exec(html))) {
      const c = m[1].trim();
      if (valid(c) && !map.has(c)) map.set(c, { code: c, reward: '' });
    }
    return map;
  }
  // pocket type
  const text = strip(html);
  for (const line of text.split('\n')) {
    const t = line.trim(); if (!t) continue;
    const m = t.match(/^([A-Za-z0-9]{6,30})\s*[-–—]\s*(.+)$/);
    if (!m) continue;
    const c = m[1], r = m[2].replace(/\s*\(new!?\)\s*$/i,'').trim();
    if (!valid(c)) continue;
    if (!map.has(c)) map.set(c, { code: c, reward: r });
  }
  return map;
}

function parseLocal(html) {
  const map = new Map();
  const re = /<article class="code-card">([\s\S]*?)<\/article>/g;
  let m; while ((m = re.exec(html))) {
    const card = m[1];
    const c = (card.match(/<div class="code-string">([^<]+)<\/div>/)||[])[1];
    if (!c) continue;
    map.set(c.trim(), {
      code: c.trim(),
      isExpired: card.includes('status-expired'),
      desc: (card.match(/<div class="code-updated">([^<]*)<\/div>/)||['',''])[1].trim(),
    });
  }
  return map;
}

// ── Update timestamps ───────────────────────────────────────────────────────
function updateTimestamps(html) {
  const now = fmt(), i = iso(), u = utc();
  let h = html;
  h = h.replace(/data-last-checked-utc="[^"]+"/, `data-last-checked-utc="${u}"`);
  h = h.replace(/"dateModified":\s*"\d{4}-\d{2}-\d{2}"/, `"dateModified": "${i}"`);
  h = h.replace(/<span id="footer-date">[^<]+<\/span>/, `<span id="footer-date">${now}</span>`);
  h = h.replace(/Updated [A-Z][a-z]+ \d\d?, \d{4}/g, `Updated ${now}`);
  h = h.replace(/Last verified: [A-Z][a-z]+ \d\d?, \d{4}/g, `Last verified: ${now}`);

  const month = new Date().toLocaleDateString('en-US',{month:'long',timeZone:'UTC'});
  const year = new Date().getUTCFullYear();
  h = h.replace(/NTE Codes [A-Z][a-z]+ \d{4}/g, `NTE Codes ${month} ${year}`);

  try {
    if (fs.existsSync(SITEMAP)) {
      let s = fs.readFileSync(SITEMAP, 'utf-8');
      s = s.replace(/(<loc>https:\/\/ntecodes\.xyz\/<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/, `$1${i}$2`);
      fs.writeFileSync(SITEMAP, s); log('✓ sitemap.xml updated');
    }
  } catch(e) { log(`⚠ sitemap: ${e.message}`); }
  return h;
}

// ── Git ─────────────────────────────────────────────────────────────────────
function gitPush(msg) {
  try {
    execSync('git add -A', { cwd: ROOT, stdio: 'pipe' });
    const d = execSync('git diff --cached --stat', { cwd: ROOT, encoding: 'utf-8' });
    log(`Changes:\n${d}`);
    execSync(`git commit -m "${msg}"`, { cwd: ROOT, stdio: 'pipe' });
    execSync('git push origin main', { cwd: ROOT, stdio: 'pipe' });
    log('✓ Pushed');
  } catch(e) {
    if (e.message.includes('nothing to commit')) { log('→ Nothing to commit'); return; }
    log(`✗ Git: ${e.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  log('═══ NTE Codes Auto-Checker ═══');
  log(`Dry run: ${DRY ? 'YES' : 'NO'}`);

  if (!fs.existsSync(HTML)) { log('✗ index.html not found'); process.exit(1); }

  const idx = fs.readFileSync(HTML, 'utf-8');
  const local = parseLocal(idx);
  const active = [...local.values()].filter(c => !c.isExpired).map(c => c.code);
  const expired = [...local.values()].filter(c => c.isExpired).map(c => c.code);

  log(`Local: ${active.length} active, ${expired.length} expired`);
  log(`Current: ${active.join(', ') || 'none'}`);

  const all = new Map();
  const results = [];

  for (const src of SOURCES) {
    try {
      log(`→ ${src.label}...`);
      const html = await fetch(src.url);
      const parsed = parseCodes(html, src.type);
      results.push({ label: src.label, count: parsed.size, codes: [...parsed.keys()], ok: true });
      log(`  → ${parsed.size} codes`);
      for (const [k,v] of parsed) all.set(k, v);
    } catch(e) {
      log(`  ✗ ${e.message}`);
      results.push({ label: src.label, count: 0, codes: [], ok: false });
    }
  }

  log(`Unique: ${all.size}`);
  for (const r of results) log(`  ${r.label}: ${r.count} codes${r.ok ? '' : ' (FAILED)'}`);

  const activeSet = new Set(active), expiredSet = new Set(expired);
  const newCodes = [...all.keys()].filter(c => !activeSet.has(c) && !expiredSet.has(c));
  const missing = active.filter(c => !all.has(c));

  if (newCodes.length > 0) {
    log('✦ NEW CODES:');
    for (const c of newCodes) log(`  ${c}: ${(all.get(c)||{}).reward || '?'}`);
  }
  if (missing.length > 0) log(`⚠ Missing from sources: ${missing.join(', ')}`);
  if (!newCodes.length && !missing.length) log('✓ All codes match.');

  if (!DRY) {
    log('→ Updating...');
    const updated = updateTimestamps(idx);
    if (updated !== idx || newCodes.length > 0 || missing.length > 0) {
      fs.writeFileSync(HTML, updated);
      const msg = `Auto: NTE codes ${fmt()}${newCodes.length ? ' +'+newCodes.join(',') : ''}`;
      gitPush(msg);
    } else { log('✓ No changes.'); }
  }

  log('');
  log(`Sources OK: ${results.filter(r=>r.ok).length}/${SOURCES.length}`);
  log(`New: ${newCodes.join(', ') || 'none'} | Missing: ${missing.join(', ') || 'none'}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
