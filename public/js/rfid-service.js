/**
 * RFID Service - polls the MR101 bridge and processes one transaction at a time.
 *
 * Tag processing logic:
 *  - Tag must be live and have a decoded barcode.
 *  - Tag must have had an AFI write ATTEMPTED by the bridge (success or fail).
 *    This ensures the bridge has had time to read barcode data from tag memory.
 *  - If the AFI write FAILED, we still proceed — the server writes AFI after
 *    the DB transaction (checkout: 0x00, checkin: 0x90).
 */

class RFIDService {
    constructor() {
        this.POLL_INTERVAL_MS = 250;
        this.LIVE_TAG_GRACE_MS = 5000;
        this.BOOTSTRAP_POLL_COUNT = 8;
        this.BOOTSTRAP_POLL_INTERVAL_MS = 175;
        this.API_URL = '/api/tags';

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
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this._startPolling());
        } else {
            this._startPolling();
        }
    }

    _startPolling() {
        console.log('[RFID] Starting polling at', this.API_URL);
        this.pollTimer = setInterval(() => this._poll(), this.POLL_INTERVAL_MS);
    }

    _clearBootstrapPolls() {
        for (const timerId of this.bootstrapTimers) {
            clearTimeout(timerId);
        }
        this.bootstrapTimers = [];
    }

    _getAfiWriteResult(tag) {
        return String(tag?.afiWriteResult || '').trim().toLowerCase();
    }

    _isAfiWriteSuccessful(tag) {
        return this._getAfiWriteResult(tag) === 'success';
    }

    _isAfiWriteFailed(tag) {
        const result = this._getAfiWriteResult(tag);
        return result.startsWith('failed') || result.startsWith('error');
    }

    /**
     * A tag is "ready to process" when:
     *  1. Its barcode has been decoded (bridge read tag memory)
     *  2. The bridge has attempted an AFI write at least once (success OR fail)
     *     — this is used as a proxy confirming tag memory was read
     *
     * If afiWriteAttempted is true but the write failed, we still process.
     * The server-side handler will write the correct AFI after the DB transaction.
     *
     * Special case: if the bridge is NOT armed (no AFI to write), we accept
     * the tag as soon as it has a barcode.
     */
    _isTagReady(tag) {
        const barcode = this._extractBarcode(tag);
        if (!barcode) return false;

        // If bridge attempted AFI write (success or fail), tag data is fully read
        if (tag.afiWriteAttempted === true || String(tag.afiWriteAttempted || '').toLowerCase() === 'true') {
            return true;
        }

        // If write succeeded, definitely ready
        if (this._isAfiWriteSuccessful(tag)) {
            return true;
        }

        // If bridge is not armed (no AFI target), accept tag with barcode immediately
        // afiWriteResult will be '' and afiWriteAttempted will be false
        if (!tag.afiWriteAttempted && this._getAfiWriteResult(tag) === '') {
            // Allow after a short grace (tag.lastSeen should be reasonably recent and barcode decoded)
            return true;
        }

        return false;
    }

    async _poll() {
        if (this.isPolling) return;
        this.isPolling = true;

        try {
            const response = await fetch(this.API_URL);
            if (!response.ok) throw new Error('HTTP ' + response.status);

            const tags = await response.json();
            this.failCount = 0;

            if (!this.isConnected) {
                this.isConnected = true;
                console.log('[RFID] Connected to RFID reader');
            }

            const isCheckout = (typeof window.kioskApp !== 'undefined' && window.kioskApp.currentOperation === 'checkout');
            const isRenew    = (typeof window.kioskApp !== 'undefined' && window.kioskApp.currentOperation === 'renew');
            const scanningEnabled = (typeof window.kioskApp !== 'undefined' && window.kioskApp.scanningEnabled) || false;

            if (!scanningEnabled && !isCheckout && !isRenew) {
                return;
            }

            for (const tag of tags) {
                const isLive = tag && (tag.live === true || String(tag.live || '').toLowerCase() === 'true');
                if (!isLive) continue;

                const barcode = this._extractBarcode(tag);
                if (!barcode) continue;

                const lastSeen = Number(tag.lastSeen || 0);
                if (lastSeen < this.sessionStartedAt) continue;

                const uid = String(tag.uid || '').trim().toUpperCase();
                const dedupeKey = this._dedupeKey(tag, barcode, lastSeen);
                if (this.processedAppearances.has(dedupeKey)) continue;

                // Note the UID mapping for barcode (used later in checkout/checkin)
                if (window.kioskApp?.noteRfidTag && uid) {
                    window.kioskApp.noteRfidTag(barcode, uid);
                }

                // Wait until the bridge has attempted AFI write (ensures barcode is decoded)
                if (!this._isTagReady(tag)) {
                    // Tag seen but bridge hasn't attempted AFI write yet — skip this poll,
                    // next poll (250ms) will try again until bridge attempts the write.
                    continue;
                }

                // Log AFI write failures for diagnostics, but don't block processing.
                // The server writes AFI after the DB transaction.
                if (this._isAfiWriteFailed(tag)) {
                    const reason = String(tag?.afiWriteResult || 'unknown').trim();
                    console.warn(`[RFID] Bridge AFI pre-write failed for ${barcode} (${uid}): ${reason}. Server will write AFI after transaction.`);
                }

                // Only mark as processed when we ACTUALLY process it
                if (isCheckout) {
                    if (scanningEnabled) {
                        this.processedAppearances.add(dedupeKey);
                        console.log(`[RFID] Queuing checkout tag: ${barcode} (UID: ${uid})`);
                        this.checkinQueue.push({ barcode, uid, isCheckout: true });
                        this._drainCheckinQueue();
                    } else {
                        // Fallback manual mode
                        const patronCardEl = document.getElementById('patron-card');
                        const itemBarcodeEl = document.getElementById('item-barcode-checkout');
                        const patronReady = patronCardEl && patronCardEl.value.trim().length > 0;
                        const itemFieldEmpty = itemBarcodeEl && !itemBarcodeEl.value;

                        if (patronReady && itemFieldEmpty && !this.checkoutProcessing) {
                            this.processedAppearances.add(dedupeKey);
                            this.checkoutProcessing = true;

                            console.log(`[RFID] Processing checkout tag: ${barcode} (UID: ${uid})`);
                            window.kioskApp.processCheckoutTag({ barcode, uid })
                                .catch((error) => {
                                    console.warn('[RFID] Checkout tag processing failed:', error?.message || error);
                                })
                                .finally(() => {
                                    this.checkoutProcessing = false;
                                });
                        }
                    }
                    continue;
                }

                if (isRenew && scanningEnabled) {
                    this.processedAppearances.add(dedupeKey);
                    console.log(`[RFID] Renew item tag: ${barcode} (UID: ${uid})`);
                    this.checkinQueue.push({ barcode, uid, isRenew: true });
                    this._drainCheckinQueue();
                    continue;
                }

                if (scanningEnabled) {
                    this.processedAppearances.add(dedupeKey);
                    console.log(`[RFID] Queuing checkin tag: ${barcode} (UID: ${uid})`);
                    this.checkinQueue.push({ barcode, uid });
                    this._drainCheckinQueue();
                }
            }
        } catch (error) {
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
        if (this.checkinProcessing) return;
        this.checkinProcessing = true;

        try {
            while (this.checkinQueue.length > 0) {
                const nextTag = this.checkinQueue.shift();
                console.log(`[RFID] Processing: ${nextTag.barcode} (UID: ${nextTag.uid})`);
                if (nextTag.isCheckout) {
                    await window.kioskApp.processCheckoutTag(nextTag);
                } else if (nextTag.isRenew) {
                    if (window.kioskApp?.handleRenewScan) {
                        window.kioskApp.handleRenewScan(nextTag.barcode);
                    }
                } else {
                    await window.kioskApp.processBarcode(nextTag);
                }
            }
        } catch (error) {
            console.warn('[RFID] Queue processing failed:', error?.message || error);
        } finally {
            this.checkinProcessing = false;
        }
    }

    _dedupeKey(tag, barcode, lastSeen) {
        const uid = String(tag.uid || barcode).trim();
        const appearanceId = Number(tag.appearanceId || 0);
        if (appearanceId > 0) {
            return `${uid}:${appearanceId}`;
        }
        return `${uid}:${lastSeen}`;
    }

    _extractBarcode(tag) {
        if (tag.barcode && tag.barcode.trim().length > 0) {
            return tag.barcode.trim();
        }
        return null;
    }

    resetSession() {
        this.liveScanToken++;
        this._clearBootstrapPolls();
        this.processedAppearances.clear();
        this.sessionStartedAt = Date.now();
        this.checkoutProcessing = false;
        this.checkinProcessing = false;
        this.checkinQueue = [];
        console.log('[RFID] Session reset - ready for new tags');
    }

    activateLiveScan(options = this.LIVE_TAG_GRACE_MS) {
        const settings = (typeof options === 'object' && options !== null)
            ? options
            : { graceMs: options };
        const graceMs = Math.max(this.LIVE_TAG_GRACE_MS, Number(settings.graceMs) || 0);
        const bootstrapPolls = Math.max(1, Number(settings.bootstrapPolls) || this.BOOTSTRAP_POLL_COUNT);
        const bootstrapIntervalMs = Math.max(50, Number(settings.bootstrapIntervalMs) || this.BOOTSTRAP_POLL_INTERVAL_MS);

        const token = ++this.liveScanToken;
        this._clearBootstrapPolls();
        this.processedAppearances.clear();
        this.sessionStartedAt = Date.now() - graceMs;
        this.checkoutProcessing = false;
        this.checkinProcessing = false;
        this.checkinQueue = [];
        console.log(`[RFID] Live scan activated (grace=${graceMs}ms, bootstrapPolls=${bootstrapPolls})`);

        for (let index = 1; index < bootstrapPolls; index++) {
            const timerId = setTimeout(() => {
                if (this.liveScanToken !== token) return;
                void this._poll();
            }, index * bootstrapIntervalMs);
            this.bootstrapTimers.push(timerId);
        }

        void this._poll();
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

document.addEventListener('DOMContentLoaded', () => {
    window.rfidService = new RFIDService();
});
