#!/usr/bin/env node
/**
 * NTE Codes Auto-Checker
 *
 * Checks sources for new NTE codes, moves expired codes to the expired list,
 * and updates timestamps.
 *
 * Sources:
 *   1. Pocket Tactics (primary, server-rendered, works)
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
const SOURCES = [
  { url: 'https://www.pockettactics.com/neverness-to-everness/codes', label: 'Pocket Tactics', type: 'pocket' },
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

/** Parse source HTML for code+reward pairs */
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

/**
 * Parse local index.html and return:
 *   - activeCards: Map<code, {code, fullHtml, rewardHtml, rewardText, description, updated}>
 *   - expiredCodes: Set<code>
 */
function parseLocalDetailed(html) {
  const activeCards = new Map();
  const expiredCodes = new Set();

  // Find all code cards in the active section
  // We need to locate the active-codes section's codes-grid content
  const activeSectionMatch = html.match(/<section id="active-codes"[\s\S]*?<\/section>/i);
  if (!activeSectionMatch) return { activeCards, expiredCodes };

  const activeSection = activeSectionMatch[0];
  const cardRe = /<article class="code-card">([\s\S]*?)<\/article>/g;
  let m;
  while ((m = cardRe.exec(activeSection))) {
    const fullCard = m[0];
    const cardBody = m[1];
    const c = (cardBody.match(/<div class="code-string">([^<]+)<\/div>/) || [])[1];
    if (!c) continue;
    const code = c.trim();

    // Extract reward HTML
    const rewardHtmlMatch = cardBody.match(/<div class="code-reward">([\s\S]*?)<\/div>/);
    const rewardHtml = rewardHtmlMatch ? rewardHtmlMatch[1].trim() : '';

    // Extract reward text (plain)
    const rewardText = rewardHtml
      ? strip(rewardHtml).replace(/\s+/g,' ').trim()
      : '';

    const desc = (cardBody.match(/<p class="code-description">([\s\S]*?)<\/p>/) || [])[1] || '';
    const updated = (cardBody.match(/<div class="code-updated">([^<]*)<\/div>/) || [])[1] || '';

    const isExpired = cardBody.includes('status-expired');

    activeCards.set(code, {
      code,
      fullCard,
      rewardHtml,
      rewardText,
      description: desc.trim(),
      updated: updated.trim(),
      isExpired,
    });
    if (isExpired) expiredCodes.add(code);
  }

  return { activeCards, expiredCodes };
}

// ── HTML manipulation ───────────────────────────────────────────────────────

/**
 * Build the expired table HTML if missing, or an <tr> row.
 */
function buildExpiredRow(code, rewardText) {
  const now = fmt();
  return `          <tr>
            <td><span class="expired-code-str">${code}</span></td>
            <td>${rewardText}</td>
            <td>Expired ${now}</td>
          </tr>`;
}

function buildExpiredTableHeader() {
  return `<div class="expired-table-wrap">
        <table class="expired-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Rewards</th>
              <th>Expired</th>
            </tr>
          </thead>
          <tbody>
`;
}

function buildExpiredTableFooter() {
  return `          </tbody>
        </table>
      </div>`;
}

/**
 * Generate a basic code card HTML for a new code from source.
 * This creates a minimal card — the description is generic.
 */
function buildNewCodeCard(code, rewardText) {
  const now = fmt();
  // Format reward lines from the pocket tactice-style text (e.g. "30k fons")
  const rewards = rewardText.split(',').map(r => r.trim()).filter(Boolean);
  // Try to parse Annulith count for the description
  const annulithMatch = rewardText.match(/(\d+)\s*Annulith/i);
  const hasAnnulith = annulithMatch ? ` with ${annulithMatch[1]} Annulith` : '';

  let rewardHtml = '';
  for (const r of rewards) {
    // Try to extract item name and quantity
    const qtyMatch = r.match(/^([\d,.]+[kK]?)\s+(.+)$/) || r.match(/^(?:(\d+)×?)\s+(.+)$/) || ['', '', r];
    const qty = qtyMatch[1] || '';
    const item = qtyMatch[2] || r;
    const icon = /\b(annulith|beetle|fons|coin|guide|dye)\b/i.test(item) ? '◈' : '◈';
    const display = qty ? `${qty} ${item}` : item;
    rewardHtml += `              <div class="code-reward-line"><span class="reward-icon">${icon}</span> ${display}</div>\n`;
  }

  return `          <article class="code-card">
            <div class="code-card-top">
              <span class="status-badge status-active">Active</span>
            </div>
            <div class="code-string">${code}</div>
            <div class="code-reward">
${rewardHtml}            </div>
            <button class="copy-btn" data-code="${code}" aria-label="Copy code ${code}">
              ⧉ Copy Code
            </button>
            <p class="code-description">New NTE code${hasAnnulith} — auto-detected from game news sources. Redeem immediately as codes may expire without notice.</p>
            <div class="code-updated">New code — added ${now}</div>
          </article>`;
}

/**
 * Find the existing expired section and either:
 * - If it has "No expired codes yet." replacement text, replace with full table
 * - If it already has a table, append rows
 */
function getExpiredSectionState(html) {
  const placeholderRe = /<div class="expired-table-wrap"[\s\S]*?<p[^>]*>[\s\S]*?No expired codes yet\.[\s\S]*?<\/p>[\s\S]*?<\/div>/i;
  const hasPlaceholder = placeholderRe.test(html);

  const tableMatch = html.match(/<section id="expired"[\s\S]*?<\/section>/i);
  const sectionHtml = tableMatch ? tableMatch[0] : '';

  return { hasPlaceholder, sectionHtml, placeholderRe };
}

// ── Update functions ────────────────────────────────────────────────────────

/**
 * Move expired codes from active section to expired table.
 * Returns {html, moved: string[]}
 */
function moveExpiredToTable(html, missingCodes, activeCards, allSourceCodes) {
  let h = html;
  const moved = [];

  if (missingCodes.length === 0) return { html: h, moved };

  // Get the state of the expired section
  const { hasPlaceholder, sectionHtml, placeholderRe } = getExpiredSectionState(h);

  // Collect rows to add
  let newRows = '';
  for (const code of missingCodes) {
    const card = activeCards.get(code);
    if (!card) continue;

    // Reward text: use what card has, or fallback to source
    const rewardText = card.rewardText ||
      (allSourceCodes.has(code) ? allSourceCodes.get(code).reward : '');

    newRows += buildExpiredRow(code, rewardText) + '\n';
    moved.push(code);
  }

  if (moved.length === 0) return { html: h, moved };

  log(`→ Moving ${moved.length} expired codes to expired section: ${moved.join(', ')}`);

  // Replace the placeholder with a proper table, or inject rows into existing table
  if (hasPlaceholder) {
    const tableHtml = buildExpiredTableHeader() + newRows + buildExpiredTableFooter();
    h = h.replace(placeholderRe, tableHtml);
  } else {
    // Append rows before the closing tbody
    const tbodyEnd = '</tbody>';
    if (h.includes(tbodyEnd)) {
      h = h.replace(tbodyEnd, newRows + '          ' + tbodyEnd);
    } else {
      // Fallback: wrap in a full table
      const tableHtml = buildExpiredTableHeader() + newRows + buildExpiredTableFooter();
      const expiredSectionEnd = '</section>';
      const expiredStart = h.indexOf('<section id="expired"');
      if (expiredStart !== -1) {
        const sectionEnd = h.indexOf(expiredSectionEnd, expiredStart);
        if (sectionEnd !== -1) {
          const before = h.slice(0, sectionEnd);
          const after = h.slice(sectionEnd);
          // Find the last div.expired-table-wrap or the content area to replace
          const wrapRe = /<div class="expired-table-wrap"[\s\S]*?<\/div>\s*\n\s*/;
          h = before.replace(wrapRe, tableHtml + '\n') + after;
        }
      }
    }
  }

  // Remove each expired code's card from the active section's codes-grid
  for (const code of moved) {
    const card = activeCards.get(code);
    if (card && card.fullCard) {
      // Remove the article element from codes-grid
      const beforeLen = h.length;
      h = h.replace(card.fullCard, '');
      if (h.length === beforeLen) {
        log(`⚠ Could not remove card for ${code} from active section`);
      }
    }
  }

  // Clean up: remove empty codes-grid or extra whitespace
  h = h.replace(/<div class="codes-grid">\s*<\/div>/g, '<div class="codes-grid">\n          <!-- expired codes moved to expired section -->\n        </div>');

  // Update active count in banner line
  const newActiveCount = [...activeCards.keys()].filter(c => !moved.includes(c)).length;
  // Update the active code count in the banner
  h = h.replace(
    /(\d+) active global codes available/,
    `${newActiveCount} active global codes available`
  );
  // Update the "Redeem all X for Y Annulith" line if we can compute it
  const totalAnnulith = computeTotalAnnulith(activeCards, moved);
  if (totalAnnulith > 0) {
    h = h.replace(
      /(\d+ Annulith total)/,
      `${totalAnnulith} Annulith total`
    );
  }

  return { html: h, moved };
}

/**
 * Rough estimate of total Annulith from active code rewards.
 */
function computeTotalAnnulith(activeCards, movedCodes) {
  let total = 0;
  for (const [code, card] of activeCards) {
    if (movedCodes.includes(code)) continue;
    const m = (card.rewardText || '').match(/(\d+)\s*Annulith/i);
    if (m) total += parseInt(m[1], 10);
    // Also check rewardHtml for Annulith
    const m2 = (card.rewardHtml || '').match(/(\d+)\s*Annulith/i);
    if (m2) total += parseInt(m2[1], 10);
  }
  return total;
}

/**
 * Insert new codes from source into the active codes-grid.
 * Returns {html, added: string[]}
 */
function insertNewCodes(html, newCodes, allSourceCodes, activeCards) {
  let h = html;
  const added = [];

  if (newCodes.length === 0) return { html: h, added };

  // Find the codes-grid end marker (</div> that closes the grid)
  const codesGridEnd = '</div>\n\n        <p style="color:var(--text-muted);';
  const gridIdx = h.indexOf(codesGridEnd);
  if (gridIdx === -1) {
    log('⚠ Could not find codes-grid insertion point');
    return { html: h, added };
  }

  let insertion = '';
  for (const code of newCodes) {
    const src = allSourceCodes.get(code);
    const rewardText = src ? src.reward : '';
    const cardHtml = buildNewCodeCard(code, rewardText);
    insertion += cardHtml + '\n\n';
    added.push(code);
  }

  log(`→ Inserting ${added.length} new codes: ${added.join(', ')}`);
  h = h.slice(0, gridIdx) + insertion + h.slice(gridIdx);

  return { html: h, added };
}

// ── Timestamps (unchanged) ─────────────────────────────────────────────────
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

  // Parse local state (detailed)
  const { activeCards, expiredCodes } = parseLocalDetailed(idx);
  const active = [...activeCards.values()].filter(c => !c.isExpired).map(c => c.code);
  const expired = [...expiredCodes];

  log(`Local: ${active.length} active, ${expired.length} expired`);
  log(`Active: ${active.join(', ') || 'none'}`);
  if (expired.length) log(`Expired: ${expired.join(', ')}`);

  // Fetch sources
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

  log(`Unique source codes: ${all.size}`);
  for (const r of results) log(`  ${r.label}: ${r.count} codes${r.ok ? '' : ' (FAILED)'}`);

  const activeSet = new Set(active);
  const expiredSet = new Set(expired);

  // Codes on source but not locally active or expired → new codes to add
  const newCodes = [...all.keys()].filter(c => !activeSet.has(c) && !expiredSet.has(c));

  // Codes locally active but missing from source → likely expired
  const missing = active.filter(c => !all.has(c));

  if (newCodes.length > 0) {
    log('✦ NEW CODES from source:');
    for (const c of newCodes) log(`  ${c}: ${(all.get(c)||{}).reward || '?'}`);
  }
  if (missing.length > 0) {
    log('⚠ CODES MISSING FROM SOURCE (likely expired):');
    for (const c of missing) log(`  ${c}`);
  }
  if (!newCodes.length && !missing.length) log('✓ All codes match source.');

  let updated = idx;
  let changed = false;
  let added = [];
  let moved = [];

  if (!DRY && (newCodes.length > 0 || missing.length > 0)) {
    log('→ Updating HTML...');

    // 1. Move expired codes to expired section
    if (missing.length > 0) {
      const result = moveExpiredToTable(updated, missing, activeCards, all);
      updated = result.html;
      moved = result.moved;
      if (moved.length > 0) changed = true;
    }

    // 2. Insert new codes
    if (newCodes.length > 0) {
      // Re-parse to get updated active cards after moves
      const { activeCards: updatedCards } = parseLocalDetailed(updated);
      const result = insertNewCodes(updated, newCodes, all, updatedCards);
      updated = result.html;
      added = result.added;
      if (added.length > 0) changed = true;
    }

    // 3. Update timestamps (always, to keep last-checked current)
    const tsUpdated = updateTimestamps(updated);
    if (tsUpdated !== updated) changed = true;
    updated = tsUpdated;

    if (changed) {
      fs.writeFileSync(HTML, updated);
      log('✓ index.html written');

      // Build commit message
      const parts = [];
      if (added.length) parts.push('+' + added.join(','));
      if (moved.length) parts.push('expired:' + moved.join(','));
      const detail = parts.length ? ` (${parts.join('; ')})` : '';
      const msg = `Auto: NTE codes ${fmt()}${detail}`;
      gitPush(msg);
    } else {
      log('✓ No changes to commit.');
    }
  }

  log('');
  log(`Sources OK: ${results.filter(r=>r.ok).length}/${SOURCES.length}`);
  log(`New: ${added.join(', ') || 'none'} | Expired: ${moved.join(', ') || 'none'}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
