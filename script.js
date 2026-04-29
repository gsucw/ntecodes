// NTE Codes — script.js

document.addEventListener('DOMContentLoaded', () => {

  // ── Last checked timestamp ──────────────────────────────────
  // Keep the HTML as the last code commit/deploy UTC timestamp, then let
  // the browser roll it forward every 2 hours if the page has not been
  // redeployed yet. Update data-last-checked-utc whenever code changes.
  const lastCheckedEl = document.getElementById('last-checked-utc');
  if (lastCheckedEl) {
    const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
    const formatUtc = d => {
      const date = d.toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
      });
      const time = d.toLocaleTimeString('en-GB', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC'
      });
      return `${date}, ${time} UTC`;
    };

    const htmlCheckpoint = new Date(lastCheckedEl.dataset.lastCheckedUtc);
    if (!Number.isNaN(htmlCheckpoint.getTime())) {
      const now = new Date();
      const elapsedMs = now.getTime() - htmlCheckpoint.getTime();
      const intervalsElapsed = Math.max(0, Math.floor(elapsedMs / CHECK_INTERVAL_MS));
      const displayDate = intervalsElapsed > 0
        ? new Date(htmlCheckpoint.getTime() + intervalsElapsed * CHECK_INTERVAL_MS)
        : htmlCheckpoint;
      lastCheckedEl.textContent = formatUtc(displayDate);
    }
  }

  // ── Copy-to-clipboard ──────────────────────────────────────
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.code;
      navigator.clipboard.writeText(code).then(() => {
        const orig = btn.innerHTML;
        btn.innerHTML = '✓ Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = orig;
          btn.classList.remove('copied');
        }, 2000);
      }).catch(() => {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        const orig = btn.innerHTML;
        btn.innerHTML = '✓ Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = orig;
          btn.classList.remove('copied');
        }, 2000);
      });
    });
  });

  // ── FAQ accordion ──────────────────────────────────────────
  document.querySelectorAll('.faq-q').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const isOpen = item.classList.contains('open');
      // Close all
      document.querySelectorAll('.faq-item.open').forEach(el => {
        el.classList.remove('open');
        el.querySelector('.faq-q').setAttribute('aria-expanded', 'false');
      });
      // Toggle clicked
      if (!isOpen) {
        item.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });

  // ── Smooth scroll for TOC ──────────────────────────────────
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const target = document.querySelector(a.getAttribute('href'));
      if (!target) return;
      e.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  });

  // ── Intersection observer — fade-in sections ──────────────
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08 });

  document.querySelectorAll('section').forEach(sec => {
    // Skip sections already in the viewport on load (above the fold)
    const rect = sec.getBoundingClientRect();
    if (rect.top < window.innerHeight) return;
    sec.style.opacity = '0';
    sec.style.transform = 'translateY(20px)';
    sec.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    io.observe(sec);
  });

});
