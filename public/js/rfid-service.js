/**
 * RFIDService - Managed RFID bridge communication.
 * Consolidated and structurally cleaned for IDE compatibility.
 */
class RFIDService {
    constructor() {
        this.API_URL = 'http://localhost:3000/api/rfid/poll';
        this.POLL_INTERVAL_MS = 250;
        this.LIVE_TAG_GRACE_MS = 1500;
        this.BOOTSTRAP_POLL_COUNT = 8;
        this.BOOTSTRAP_POLL_INTERVAL_MS = 175;

        this.pollTimer = null;
        this.isPolling = false;
        this.isConnected = false;
        this.failCount = 0;

        this.processedAppearances = new Set();
        this.sessionStartedAt = Date.now();

        this.checkoutProcessing = false;
        this.checkinProcessing = false;
        this.checkinQueue = [];

        this.liveScanToken = 0;
        this.bootstrapTimers = [];

        this._init();
    }

    _init() {
        this._startPolling();
        // Clear bootstrap state after 5s to ensure fresh start
        setTimeout(() => {
            if (this.liveScanToken === 0) this._clearBootstrapPolls();
        }, 5000);
    }

    _startPolling() {
        if (this.pollTimer) { clearInterval(this.pollTimer); }
        this.pollTimer = setInterval(() => { void this._poll(); }, this.POLL_INTERVAL_MS);
    }

    _clearBootstrapPolls() {
        for (const timerId of this.bootstrapTimers) {
            clearTimeout(timerId);
        }
        this.bootstrapTimers = [];
        this.processedAppearances.clear();
        this.sessionStartedAt = Date.now();
        console.log('[RFID] Bootstrap poll metadata cleared');
    }

    _getAfiWriteResult(tag) {
        return String(tag?.afiWriteResult || '').trim().toLowerCase();
    }

    _isTagReady(tag) {
        // Tag seen but bridge hasn't attempted AFI write yet — skip.
        // next poll will try again until bridge attempts the write.
        if (tag.afiWriteAttempted === true || String(tag.afiWriteAttempted || '').toLowerCase() === 'true') { return true; }
        if (this._getAfiWriteResult(tag) === '') { return true; }
        return false;
    }

    async _poll() {
        if (this.isPolling) { return; }

        const isCheckout = (typeof window.kioskApp !== 'undefined' && window.kioskApp.currentOperation === 'checkout');
        const isRenew = (typeof window.kioskApp !== 'undefined' && window.kioskApp.currentOperation === 'renew');
        const isCheckin = (typeof window.kioskApp !== 'undefined' && window.kioskApp.currentOperation === 'checkin');
        const scanningEnabled = (typeof window.kioskApp !== 'undefined' && window.kioskApp.scanningEnabled) || false;

        // Skip polling if no relevant module is active
        if (!scanningEnabled && !isCheckout && !isRenew) { return; }

        this.isPolling = true;
        try {
            const response = await fetch(this.API_URL);
            if (!response.ok) { throw new Error(`HTTP ${response.status}`); }

            const data = await response.json();
            const tags = Array.isArray(data.tags) ? data.tags : [];
            
            if (tags.length > 0) {
                console.log(`[RFID] Poll success: ${tags.length} tags found. (scanningEnabled=${scanningEnabled})`);
            }

            if (!this.isConnected) {
                this.isConnected = true;
                this.failCount = 0;
            }

            for (const tag of tags) {
                const isLive = tag && (tag.live === true || String(tag.live || '').toLowerCase() === 'true');
                if (!isLive) { continue; }

                const barcode = (tag.barcode || '').trim();
                const uid = (tag.uid || '').trim().toUpperCase();
                if (!barcode || !uid) { continue; }

                const lastSeen = Number(tag.lastSeen || 0);
                if (lastSeen < this.sessionStartedAt) { continue; }

                const dedupeKey = this._dedupeKey(tag, barcode, lastSeen);
                if (this.processedAppearances.has(dedupeKey)) { continue; }

                if (!this._isTagReady(tag)) { continue; }

                // 1. Checkout Module (ATM Style)
                if (isCheckout) {
                    if (scanningEnabled) {
                        this.processedAppearances.add(dedupeKey);
                        console.log(`[RFID] Queuing checkout tag: ${barcode} (UID: ${uid})`);
                        this.checkinQueue.push({ barcode, uid, isCheckout: true });
                        this._drainCheckinQueue();
                    } else {
                        const patronReady = !!window.kioskApp.checkoutSessionPatronCard;
                        const itemFieldEmpty = !document.getElementById('item-barcode-checkout')?.value;
                        if (patronReady && itemFieldEmpty && !this.checkoutProcessing) {
                            this.checkoutProcessing = true;
                            this.processedAppearances.add(dedupeKey);
                            window.kioskApp.processCheckoutTag({ barcode, uid })
                                .catch((err) => { console.warn('[RFID] Checkout tag failed:', err.message || err); })
                                .finally(() => { this.checkoutProcessing = false; });
                        }
                    }
                    continue;
                }

                // 2. Renew Module
                if (isRenew && scanningEnabled) {
                    this.processedAppearances.add(dedupeKey);
                    console.log(`[RFID] Queuing renew tag: ${barcode} (UID: ${uid})`);
                    this.checkinQueue.push({ barcode, uid });
                    this._drainCheckinQueue();
                    continue;
                }

                // 3. Check-In Module (Default auto-stream)
                if (scanningEnabled) {
                    this.processedAppearances.add(dedupeKey);
                    console.log(`[RFID] Queuing checkin tag: ${barcode} (UID: ${uid})`);
                    this.checkinQueue.push({ barcode, uid });
                    this._drainCheckinQueue();
                }
            }
        } catch (err) {
            this.failCount++;
            if (this.failCount > 5 && this.isConnected) {
                this.isConnected = false;
                console.warn('[RFID] Connection lost');
            }
        } finally {
            this.isPolling = false;
        }
    }

    async _drainCheckinQueue() {
        if (this.checkinProcessing) { return; }
        this.checkinProcessing = true;

        try {
            while (this.checkinQueue.length > 0) {
                const nextTag = this.checkinQueue.shift();
                if (nextTag.isCheckout) {
                    await window.kioskApp.processCheckoutTag(nextTag);
                } else {
                    await window.kioskApp.processBarcode(nextTag);
                }
            }
        } catch (err) {
            console.warn('[RFID] Drain failed:', err.message);
        } finally {
            this.checkinProcessing = false;
        }
    }

    _dedupeKey(tag, barcode, lastSeen) {
        const appearanceId = Number(tag.appearanceId || 0);
        if (appearanceId > 0) { return `app-${appearanceId}`; }
        return `poll-${barcode}-${lastSeen}`;
    }

    resetSession() {
        this.liveScanToken++;
        this._clearBootstrapPolls();
        this.processedAppearances.clear();
        this.sessionStartedAt = Date.now();
        this.checkinQueue = [];
        this.checkoutProcessing = false;
        this.checkinProcessing = false;
        console.log('[RFID] Session reset requested');
    }

    activateLiveScan(options = this.LIVE_TAG_GRACE_MS) {
        const settings = (typeof options === 'object' && options !== null)
            ? options
            : { graceMs: options };
        const graceMs = Math.max(this.LIVE_TAG_GRACE_MS, Number(settings.graceMs) || 0);
        const bootstrapPolls = Math.max(1, Number(settings.bootstrapPolls) || this.BOOTSTRAP_POLL_COUNT);
        const bootstrapIntervalMs = Math.max(50, Number(settings.bootstrapIntervalMs) || this.BOOTSTRAP_POLL_INTERVAL_MS);
        const currentToken = ++this.liveScanToken;

        this._clearBootstrapPolls();
        this.processedAppearances.clear();
        this.sessionStartedAt = Date.now() - graceMs;
        this.checkoutProcessing = false;
        this.checkinProcessing = false;
        this.checkinQueue = [];
        console.log(`[RFID] Live scan activated (Grace: ${graceMs}ms, bootstrapPolls=${bootstrapPolls})`);

        setTimeout(() => {
            if (this.liveScanToken === currentToken) {
                console.log('[RFID] Grace period ended, clearing bootstrap polls');
                this._clearBootstrapPolls();
            }
        }, graceMs);

        for (let index = 1; index < bootstrapPolls; index++) {
            const timerId = setTimeout(() => {
                if (this.liveScanToken !== currentToken) return;
                void this._poll();
            }, index * bootstrapIntervalMs);
            this.bootstrapTimers.push(timerId);
        }

        void this._poll();
    }

    async setSecurity(options) {
        // options: { barcode, uid, state, afi }
        try {
            const response = await fetch('http://localhost:3000/api/rfid/security', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(options)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (err) {
            console.warn('[RFID] Security update failed:', err.message);
            throw err;
        }
    }

    async arm(afi) {
        try {
            const response = await fetch(`http://localhost:3000/api/rfid/arm?afi=${encodeURIComponent(afi)}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (err) {
            console.warn('[RFID] Arm failed:', err.message);
            throw err;
        }
    }

    async disarm() {
        try {
            const response = await fetch('http://localhost:3000/api/rfid/disarm');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await response.json();
        } catch (err) {
            console.warn('[RFID] Disarm failed:', err.message);
            throw err;
        }
    }

    stop() {
        this.liveScanToken++;
        this._clearBootstrapPolls();
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }
}

// Initialize singleton on load
document.addEventListener('DOMContentLoaded', () => {
    window.rfidService = new RFIDService();
});
