/**
 * ═══════════════════════════════════════════════════════════════
 *  QR RECEIPT MODULE — Renew Flow Only
 *  Scope: #qr-receipt-panel inside #view-renew-receipt
 *
 *  Does NOT modify: app.js, checkin flow, checkout flow, account flow,
 *  rfid-service.js, patron-rfid-service.js, sip-client.js
 *
 *  Reads transaction data via window.kioskApp.lastTransaction (read-only).
 *  All API calls go to new, isolated endpoints (/api/receipt/qr, etc.)
 * ═══════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  /* ── Constants ────────────────────────────────────────────── */
  const QR_DURATION_SEC  = 180;
  const POLL_INTERVAL_MS = 1500;

  /* ── State ────────────────────────────────────────────────── */
  let _token          = null;
  let _pollTimer      = null;
  let _countdownTimer = null;
  let _remainingSec   = QR_DURATION_SEC;
  let _qrInstance     = null;   // QRCode library instance

  /* ── DOM helpers ──────────────────────────────────────────── */
  function el(id) { return document.getElementById(id); }

  function showState(state) {
    // state: 'idle' | 'loading' | 'active' | 'success' | 'expired'
    // IMPORTANT: must use explicit 'flex', NOT '' — setting '' removes the
    // inline style and lets the CSS default (display:none) win for every
    // state except idle, so those states would never appear on screen.
    ['qr-state-idle', 'qr-state-loading', 'qr-state-active',
     'qr-state-success', 'qr-state-expired'].forEach((id) => {
      const node = el(id);
      if (node) node.style.display = (id === `qr-state-${state}`) ? 'flex' : 'none';
    });
  }

  /* ── Countdown ring helpers ───────────────────────────────── */
  function updateCountdownRing(sec) {
    const label = el('qr-countdown-label');
    if (label) label.textContent = sec + 's';

    const circle = el('qr-countdown-circle');
    if (!circle) return;
    const r      = Number(circle.getAttribute('r') || 44);
    const circum = 2 * Math.PI * r;
    const pct    = Math.max(0, sec / QR_DURATION_SEC);
    circle.style.strokeDashoffset = circum * (1 - pct);
    circle.style.strokeDasharray  = circum;
  }

  /* ── Cleanup ─────────────────────────────────────────────── */
  function stopPolling() {
    if (_pollTimer)      { clearInterval(_pollTimer);  _pollTimer = null; }
    if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
  }

  function resetToIdle() {
    stopPolling();
    _token        = null;
    _remainingSec = QR_DURATION_SEC;
    _qrInstance   = null;

    const qrBox = el('qr-code-display');
    if (qrBox) qrBox.innerHTML = '';

    const wifiHint = el('qr-wifi-hint');
    if (wifiHint) wifiHint.style.display = 'none';

    showState('idle');
  }

  /* ── Poll for downloaded status ───────────────────────────── */
  function startPolling() {
    stopPolling();

    // Countdown
    _countdownTimer = setInterval(() => {
      _remainingSec = Math.max(0, _remainingSec - 1);
      updateCountdownRing(_remainingSec);

      if (_remainingSec <= 0) {
        stopPolling();
        showState('expired');
      }
    }, 1000);

    // Status poll
    _pollTimer = setInterval(async () => {
      if (!_token) { stopPolling(); return; }

      try {
        const res  = await fetch(`/api/receipt/qr-status/${encodeURIComponent(_token)}`);
        if (!res.ok) return;
        const data = await res.json();

        if (data.expired) {
          stopPolling();
          showState('expired');
          return;
        }

        if (data.downloaded) {
          stopPolling();
          showState('success');
          return;
        }

        // Sync remaining seconds from server (drift correction)
        if (typeof data.remainingSeconds === 'number' && Math.abs(data.remainingSeconds - _remainingSec) > 3) {
          _remainingSec = data.remainingSeconds;
        }
      } catch (_) { /* network blip — keep polling */ }
    }, POLL_INTERVAL_MS);
  }

  /* ── Generate QR ─────────────────────────────────────────── */
  async function handleGenerateQr() {
    // Guard: need transaction data
    const tx = window.kioskApp && window.kioskApp.lastTransaction;
    if (!tx) {
      console.warn('[QR-Receipt] No lastTransaction found — skipping QR generation');
      return;
    }

    showState('loading');

    try {
      const res = await fetch('/api/receipt/qr', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({ transactionData: tx })
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error('[QR-Receipt] Backend error:', errText);
        showState('idle');
        return;
      }

      const data = await res.json();
      _token        = data.token;
      _remainingSec = QR_DURATION_SEC;

      // Render QR code
      const qrBox = el('qr-code-display');
      if (qrBox) {
        qrBox.innerHTML = '';

        if (typeof QRCode !== 'undefined') {
          _qrInstance = new QRCode(qrBox, {
            text        : data.url,
            width       : 220,
            height      : 220,
            colorDark   : '#1e293b',
            colorLight  : '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
          });
        } else {
          // Fallback: plain text link if library didn't load
          qrBox.innerHTML = `<p style="word-break:break-all;font-size:0.75rem;color:#475569;">${data.url}</p>`;
        }
      }

      // Wi-Fi hint when only local URL is available
      const wifiHint = el('qr-wifi-hint');
      if (wifiHint) {
        wifiHint.style.display = data.localOnly ? '' : 'none';
      }

      updateCountdownRing(_remainingSec);
      showState('active');
      startPolling();

    } catch (err) {
      console.error('[QR-Receipt] Network error:', err.message);
      showState('idle');
    }
  }

  /* ── Initialise ───────────────────────────────────────────── */
  function init() {
    // CTA button
    const btnGenerate = el('btn-qr-generate');
    if (btnGenerate) {
      btnGenerate.addEventListener('click', handleGenerateQr);
    }

    // "Try Again" after expiry
    const btnRetry = el('btn-qr-retry');
    if (btnRetry) {
      btnRetry.addEventListener('click', () => {
        resetToIdle();
        handleGenerateQr();
      });
    }

    // Reset when patron navigates BACK from receipt screen
    const backBtn = el('receipt-btn-back');
    if (backBtn) {
      backBtn.addEventListener('click', resetToIdle);
    }

    // Reset when patron re-enters receipt screen via "Finished →"
    const finishedBtn = el('btn-renew-finished');
    if (finishedBtn) {
      finishedBtn.addEventListener('click', resetToIdle);
    }

    // Initial state
    showState('idle');
    console.log('[QR-Receipt] Module initialised');
  }

  /* ── Boot after DOM ready ─────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
