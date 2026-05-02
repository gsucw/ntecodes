#!/usr/bin/env node
/**
 * NTE Codes Auto-Checker
 *
 * Periodically checks known sources for new Neverness to Everness codes,
 * compares against the current list in index.html, and auto-updates timestamps.
 *
 * Usage: node scripts/check-nte-codes.js
 *        node scripts/check-nte-codes.js --dry-run   # preview without changing anything
 *
 * Sources checked:
 *   - https://www.pockettactics.com/neverness-to-everness/codes
 *
 * Environment: expects to be run from the ntecodes repo root.
 */

// ── Config ──────────────────────────────────────────────────────────────────
const SOURCES = [
  { url: 'https://www.pockettactics.com/neverness-to-everness/codes', label: 'Pocket Tactics' },
  // Add more sources here as they become available
];

const NTE_CODE_RE = /\b([A-Za-z0-9]{6,30})\s*[-–—]\s*(.+?)(?:\s*\(new!?\))?\s*$/gim;

// ── Helpers ─────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');
const SITEMAP_XML = path.join(REPO_ROOT, 'sitemap.xml');
const isDryRun = process.argv.includes('--dry-run');

function nowFormatted() {
  const d = new Date();
  const m = d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const day = d.getUTCDate();
  const y = d.getUTCFullYear();
  return `${m} ${day}, ${y}`;
}

function nowISO() {
  return new Date().toISOString().slice(0, 10);
}

function nowUTC() {
  const d = new Date();
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

// ── Fetch source ────────────────────────────────────────────────────────────
async function fetchText(url) {
  const http = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    http.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NTECodesBot/1.0; +https://ntecodes.xyz)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// ── Parse codes from raw HTML ───────────────────────────────────────────────
function parseCodeList(html) {
  const codes = new Map();

  // Strip all HTML tags to get plain text
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Pattern: CODE - reward description
    // The code must be the FIRST part of the line, before a dash
    const match = trimmed.match(/^([A-Za-z0-9]{6,30})\s*[-–—]\s*(.+)$/);
    if (!match) continue;

    const code = match[1];
    const reward = match[2].replace(/\s*\(new!?\)\s*$/i, '').trim();

    // Only accept codes that follow NTE patterns
    if (!isLikelyNteCode(code)) continue;

    if (!codes.has(code)) {
      codes.set(code, { code, reward, source: 'Pocket Tactics' });
    }
  }

  return codes;
}

// ── Check if string looks like a valid NTE code ─────────────────────────────
function isLikelyNteCode(str) {
  // NTE codes typically: NTEXXXXX, YHXXXXX, 504XXXXXXXXXX, or all-caps alphanumeric
  if (/^NTE[A-Za-z0-9]+$/i.test(str) && str.length >= 6) return true;
  if (/^YH[A-Za-z0-9]+$/i.test(str) && str.length >= 6) return true;
  if (/^504\d+$/.test(str)) return true;
  if (/^MIGU[A-Za-z0-9]+$/i.test(str)) return true;
  // Generic fallback: alphanumeric, 6-20 chars
  if (/^[A-Za-z0-9]{6,20}$/.test(str)) return true;
  return false;
}

// ── Parse our own index.html ────────────────────────────────────────────────
function parseExistingCodes(html) {
  const codes = new Map();
  const cardRegex = /<article class="code-card">([\s\S]*?)<\/article>/g;
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    const card = match[1];
    const codeMatch = card.match(/<div class="code-string">([^<]+)<\/div>/);
    if (!codeMatch) continue;
    const code = codeMatch[1].trim();
    const isExpired = card.includes('status-expired');
    const descMatch = card.match(/<div class="code-updated">([^<]*)<\/div>/);
    const description = descMatch ? descMatch[1].trim() : '';
    codes.set(code, { code, isExpired, description });
  }

  return codes;
}

// ── Update index.html ───────────────────────────────────────────────────────
function updateTimestamps(html) {
  const todayStr = nowFormatted();
  const todayISO = nowISO();
  const utcNow = nowUTC();

  let updated = html;

  // data-last-checked-utc
  updated = updated.replace(/data-last-checked-utc="[^"]+"/, `data-last-checked-utc="${utcNow}"`);

  // dateModified
  updated = updated.replace(/"dateModified":\s*"\d{4}-\d{2}-\d{2}"/, `"dateModified": "${todayISO}"`);

  // Footer date
  updated = updated.replace(/<span id="footer-date">[^<]+<\/span>/, `<span id="footer-date">${todayStr}</span>`);

  // "Updated [Month Day, Year]" in hero badge
  updated = updated.replace(/Updated [A-Z][a-z]+ \d\d?, \d{4}/, `Updated ${todayStr}`);

  // "Last verified: [Month Day, Year]"
  updated = updated.replace(/Last verified: [A-Z][a-z]+ \d\d?, \d{4}/, `Last verified: ${todayStr}`);

  // Title month/year
  const currentMonth = new Date().toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const currentYear = new Date().getUTCFullYear();

  updated = updated.replace(
    /<title>NTE Codes [A-Z][a-z]+ \d{4}/,
    `<title>NTE Codes ${currentMonth} ${currentYear}`
  );

  // Month/year in page title (h1 or meta desc)
  updated = updated.replace(
    /(NTE Codes )[A-Z][a-z]+ \d{4}/g,
    `$1${currentMonth} ${currentYear}`
  );

  // Sitemap lastmod
  try {
    if (fs.existsSync(SITEMAP_XML)) {
      let sitemap = fs.readFileSync(SITEMAP_XML, 'utf-8');
      sitemap = sitemap.replace(
        /(<loc>https:\/\/ntecodes\.xyz\/<\/loc>\s*<lastmod>)\d{4}-\d{2}-\d{2}(<\/lastmod>)/,
        `$1${todayISO}$2`
      );
      fs.writeFileSync(SITEMAP_XML, sitemap);
      log('✓ Updated sitemap.xml lastmod');
    }
  } catch (e) {
    log(`⚠ Could not update sitemap.xml: ${e.message}`);
  }

  return updated;
}

// ── Git operations ──────────────────────────────────────────────────────────
function gitCommitAndPush(message) {
  try {
    execSync('git add -A', { cwd: REPO_ROOT, stdio: 'pipe' });
    const diffStat = execSync('git diff --cached --stat', { cwd: REPO_ROOT, encoding: 'utf-8' });
    log(`Changes:\n${diffStat}`);
    execSync(`git commit -m "${message}"`, { cwd: REPO_ROOT, stdio: 'pipe' });
    execSync('git push origin main', { cwd: REPO_ROOT, stdio: 'pipe' });
    log('✓ Pushed successfully');
    return true;
  } catch (e) {
    log(`✗ Git error: ${e.message}`);
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  log('═══ NTE Codes Auto-Checker ═══');
  log(`Dry run: ${isDryRun ? 'YES' : 'NO'}`);

  if (!fs.existsSync(INDEX_HTML)) {
    log(`✗ index.html not found at ${INDEX_HTML}`);
    process.exit(1);
  }

  const indexContent = fs.readFileSync(INDEX_HTML, 'utf-8');
  const existingCodes = parseExistingCodes(indexContent);
  const activeCodes = Array.from(existingCodes.values()).filter(c => !c.isExpired);
  const codeNames = activeCodes.map(c => c.code);

  log(`Current: ${activeCodes.length} active codes`);
  log(`Codes: ${codeNames.join(', ') || 'none'}`);

  // All unique codes from all sources
  const allSourceCodes = new Map();

  for (const source of SOURCES) {
    try {
      log(`→ Fetching ${source.label}...`);
      const html = await fetchText(source.url);
      const parsed = parseCodeList(html);
      log(`  Found ${parsed.size} codes`);
      for (const [code, data] of parsed) {
        if (!allSourceCodes.has(code)) {
          allSourceCodes.set(code, data);
        }
      }
    } catch (e) {
      log(`  ✗ Error: ${e.message}`);
    }
  }

  log(`Unique codes from all sources: ${allSourceCodes.size}`);

  // Compare
  const existingSet = new Set(codeNames);
  const sourceKeys = new Set(allSourceCodes.keys());

  const newCodes = [];
  for (const code of sourceKeys) {
    if (!existingSet.has(code)) {
      newCodes.push(code);
    }
  }

  const missingFromSource = [];
  for (const code of existingSet) {
    if (!sourceKeys.has(code)) {
      missingFromSource.push(code);
    }
  }

  if (newCodes.length > 0) {
    log(`✦ NEW CODES: ${newCodes.join(', ')}`);
    for (const code of newCodes) {
      const data = allSourceCodes.get(code);
      log(`  ${code}: ${data.reward}`);
    }
  }

  if (missingFromSource.length > 0) {
    log(`⚠ Missing from source (possibly expired): ${missingFromSource.join(', ')}`);
  }

  if (newCodes.length === 0 && missingFromSource.length === 0) {
    log('✓ No code changes detected.');
  }

  // Always update timestamps when running
  if (!isDryRun) {
    log('→ Updating timestamps...');
    const updated = updateTimestamps(indexContent);

    if (updated !== indexContent) {
      fs.writeFileSync(INDEX_HTML, updated);
      const dateStr = nowFormatted();
      let msg = `Auto-update: NTE codes ${dateStr}`;
      if (newCodes.length > 0) msg += ` + new codes: ${newCodes.join(', ')}`;
      gitCommitAndPush(msg);
    } else {
      log('✓ No timestamp changes (already up to date)');
    }
  }

  log('');
  log('═══ Summary ═══');
  log(`New: ${newCodes.length > 0 ? newCodes.join(', ') : 'none'}`);
  log(`Missing (possibly expired): ${missingFromSource.length > 0 ? missingFromSource.join(', ') : 'none'}`);
  log(`Dry run: ${isDryRun ? 'YES' : 'NO'}`);
  log('═════════════');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
