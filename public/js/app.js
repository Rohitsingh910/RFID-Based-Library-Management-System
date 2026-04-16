/**
 * Main Application Controller
 * Manages UI state and workflow for library kiosk operations
 */

class LibraryKiosk {
    constructor() {
        this.api = null;
        this.currentView = 'home';
        this.currentOperation = null;
        this.autoLogoutTimer = null;
        this.recentRfidTags = new Map();
        this.pendingCheckinBarcodes = new Set();
        this.processedCheckinBarcodes = new Set();
        this.rfidArmState = null;
        this.rfidArmPendingAfi = '';
        this.rfidArmPendingPromise = null;
        this.rfidArmGeneration = 0;

        // ─ Renew module state ─────────────────────────────────────────────
        this.renewPatronCard   = '';
        this.renewItemsData    = null; // { patronName, patronCardNumber, items[] }
        this.renewBatchResults = null; // [{ barcode, ok, itemTitle, newDueDate, message }]
        this.lastTransaction   = null; // Receipt data captured after batch renew

        this.init();
    }

    async init() {
        // Initialize API
        this.api = new KohaAPI(CONFIG);

        // Setup UI event listeners
        this.setupEventListeners();

        // Update mode indicator
        this.updateModeIndicator();
        this.isReconnecting = false;

        // Handle Splash Screen (5 seconds minimum for fresh startup, shorter for refresh)
        const splashStartTime = Date.now();
        const splashSeen = sessionStorage.getItem('splash_seen');
        const MIN_SPLASH_MS = splashSeen ? 1000 : 5000;
        sessionStorage.setItem('splash_seen', 'true');

        // Await initial health check on startup/refresh to ensure we don't 
        // show the home view if items are disconnected.
        // await this.startHealthCheck();



        //await this.startHealthCheck();

        // Wait for required duration
        const elapsed = Date.now() - splashStartTime;
        if (elapsed < MIN_SPLASH_MS) {
            await this.delay(MIN_SPLASH_MS - elapsed);
        }

        // Hide splash screen
        const splash = document.getElementById('splash-screen');
        if (splash) {
            splash.style.opacity = '0';
            document.body.style.backgroundColor = ''; // Reverts inline hack to let index.css take over
            setTimeout(() => {
                splash.style.visibility = 'hidden';
            }, 800);
        }

        // Show home view
        this.showView('home');

        console.log(`Library Kiosk initialized in ${this.api.getMode().toUpperCase()} mode`);
    }

    async startHealthCheck() {
        const check = async () => {
            if (this.isReconnecting) return;
            try {
                const response = await fetch('/api/status');
                if (!response.ok) throw new Error(`Backend unreachable (HTTP ${response.status})`);

                const status = await response.json();

                // Trigger offline if internet down OR bridge offline OR hardware disconnected
                const isOnline = status.online !== false;
                const rfidRunning = !status.rfid?.enabled || (status.rfid?.state === 'running' || status.rfid?.state === 'starting' || status.rfid?.state === 'compiling');
                const rfidHardwareConnected = !status.rfid?.enabled || status.rfid?.connected === true;

                // Update UI indicators
                this.updateOfflineStatusUI('internet', isOnline);
                this.updateOfflineStatusUI('rfid', rfidRunning && rfidHardwareConnected);

                if (!isOnline || !rfidRunning || !rfidHardwareConnected) {
                    console.warn('[Kiosk] System error detected:', { isOnline, rfidRunning, rfidHardwareConnected, state: status.rfid?.state });
                    this.showOfflineScreen();

                    if (!rfidHardwareConnected) {
                        const rfidText = document.getElementById('status-text-rfid');
                        if (rfidText) rfidText.textContent = 'CHECK HARDWARE';
                    }
                    return;
                }

                this.hideOfflineScreen();
            } catch (error) {
                console.warn('[Kiosk] Health check failed:', error.message);
                this.updateOfflineStatusUI('internet', false);
                this.updateOfflineStatusUI('rfid', false);
                this.showOfflineScreen();
            }
        };

        // Perform initial check
        await check();

        // Periodic check every 5 seconds
        setInterval(check, 5000);
    }

    updateOfflineStatusUI(type, isOnline) {
        const dot = document.getElementById(`status-dot-${type}`);
        const text = document.getElementById(`status-text-${type}`);

        if (dot && text) {
            dot.className = `status-dot ${isOnline ? 'online' : 'offline'}`;
            text.className = `status-value ${isOnline ? 'online' : 'offline'}`;
            text.textContent = isOnline ? 'CONNECTED' : 'DISCONNECTED';
        }
    }

    showOfflineScreen() {
        const overlay = document.getElementById('offline-screen');
        if (overlay) overlay.style.display = 'flex';
    }

    hideOfflineScreen() {
        const overlay = document.getElementById('offline-screen');
        if (overlay) overlay.style.display = 'none';
    }

    async closeApplication() {
        try {
            await fetch('/api/quit');
        } catch (_) {
            // Probably already shutting down
        }
        window.close();
    }

    delay(ms) {
        const waitMs = Number(ms) || 0;
        return new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    setupEventListeners() {
        const click = () => { if (typeof KioskSounds !== 'undefined') KioskSounds.click(); };

        // Main menu buttons
        document.getElementById('btn-checkout')?.addEventListener('click', () => { click(); this.startCheckOut(); });
        document.getElementById('btn-checkin')?.addEventListener('click', () => { click(); this.startCheckIn(); });
        document.getElementById('btn-renew')?.addEventListener('click', () => { click(); this.startRenew(); });
        document.getElementById('btn-account')?.addEventListener('click', () => { click(); this.startAccount(); });

        document.getElementById('btn-renew')?.addEventListener('click', () => { click(); this.showComingSoon('Renew'); });
        document.getElementById('btn-account')?.addEventListener('click', () => { click(); this.startAccount(); });
        document.getElementById('btn-search')?.addEventListener('click', () => { click(); this.startSearch(); });

        // Offline screen buttons
        document.getElementById('btn-reconnect')?.addEventListener('click', async () => {
            click();
            const btn = document.getElementById('btn-reconnect');
            if (btn) btn.textContent = 'Attempting Recovery...';
            this.isReconnecting = true;

            try {
                // Request a bridge restart on the backend
                await fetch('/api/rfid/restart', { method: 'POST' });
                await this.delay(3500); // Allow time for bridge to start and attempt hardware contact

                const response = await fetch('/api/status');
                if (response.ok) {
                    const status = await response.json();
                    const isOnline = status.online !== false;
                    const rfidHardwareConnected = !status.rfid?.enabled || status.rfid?.connected === true;

                    if (isOnline && rfidHardwareConnected) {
                        this.hideOfflineScreen();
                        if (typeof KioskSounds !== 'undefined') KioskSounds.success();
                    } else if (!rfidHardwareConnected) {
                        this.showError('RFID Reader still not detected. Please check the USB connection.');
                    }
                }
            } catch (error) {
                console.error('[Kiosk] Recovery failed:', error.message);
                this.showError('Unable to reach backend for recovery. Please contact IT.');
            } finally {
                if (btn) btn.textContent = 'Reconnect Now';
                this.isReconnecting = false;
            }
        });
        document.getElementById('btn-close-app')?.addEventListener('click', () => { click(); this.closeApplication(); });

        // Form submissions
        document.getElementById('checkout-form')?.addEventListener('submit', (e) => { e.preventDefault(); this.handleConfirmCheckout(); });
        document.getElementById('btn-confirm-checkout')?.addEventListener('click', (e) => { e.preventDefault(); this.handleConfirmCheckout(); });
        document.getElementById('checkin-form')?.addEventListener('submit', (e) => this.handleCheckInSubmit(e));
        document.getElementById('account-form')?.addEventListener('submit', (e) => this.handleAccountSubmit(e));

        document.getElementById('search-form')?.addEventListener('submit', (e) => this.handleSearchSubmit(e));

        // HID Card Reader for My Account (keyboard wedge)
        this._setupHidCardReader();

        // Hold Modal
        document.getElementById('btn-cancel-hold')?.addEventListener('click', () => {
            click();
            document.getElementById('hold-modal').style.display = 'none';
        });
        document.getElementById('btn-confirm-hold')?.addEventListener('click', () => {
            click();
            this.confirmPlaceHold();
        });

        // Cancel / Home buttons
        document.querySelectorAll('.btn-cancel').forEach(btn => {
            btn.addEventListener('click', () => { click(); this.showView('home'); });
        });

        // New transaction buttons
        document.querySelectorAll('.btn-new').forEach(btn => {
            btn.addEventListener('click', () => {
                click();
                if (this.currentOperation === 'checkout') {
                    this.startCheckOut();
                } else if (this.currentOperation === 'checkin') {
                    this.startCheckIn();
                }
            });
        });

        // Mode toggle (for demo/testing)
        document.getElementById('mode-toggle')?.addEventListener('click', () => this.toggleMode());

        // Patron Card input auto-arm for checkout
        const patronCardInput = document.getElementById('patron-card');
        if (patronCardInput) {
            patronCardInput.addEventListener('input', (e) => {
                if (this.currentOperation === 'checkout') {
                    if (e.target.value.trim().length > 0) {
                        void this.armRfidBridge('00');
                    } else {
                        void this.disarmRfidBridge(true);
                    }
                }
            });
            patronCardInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (this.currentOperation === 'checkout' && this.checkoutStagedBooks && this.checkoutStagedBooks.length > 0) {
                        this.handleConfirmCheckout();
                    }
                }
            });
        }

        // Done button for check-in
        document.getElementById('btn-done-checkin')?.addEventListener('click', () => { click(); this.handleDoneCheckIn(); });

        // Start Scanning button for check-in
        document.getElementById('btn-start-scanning')?.addEventListener('click', () => {
            click();
            this.startScanning().catch((error) => {
                console.warn('[RFID] Start scanning failed:', error?.message || error);
                this.showError(error?.message || 'Unable to start RFID scanning.');
            });
        });

        document.getElementById('btn-done-checkout')?.addEventListener('click', () => { click(); this.handleDoneCheckout(); });
        document.getElementById('btn-print-yes')?.addEventListener('click', () => { click(); this.handlePrintReceipt(true); });
        document.getElementById('btn-print-no')?.addEventListener('click', () => { click(); this.handlePrintReceipt(false); });

        // Renew module — new 5-step multi-item flow
        document.getElementById('renew-items-back')?.addEventListener('click', () => { click(); this.startRenew(); });
        document.getElementById('renew-select-all')?.addEventListener('click', () => { click(); this._toggleSelectAllRenew(true); });
        document.getElementById('renew-clear-all')?.addEventListener('click',  () => { click(); this._toggleSelectAllRenew(false); });
        document.getElementById('btn-renew-selected')?.addEventListener('click', () => { click(); this.handleRenewSelected(); });
        document.getElementById('btn-renew-account')?.addEventListener('click',  () => { click(); this.handleRenewAccountBtn(); });
        document.getElementById('btn-renew-finished')?.addEventListener('click', () => { click(); this._resetReceiptScreen(); this.showView('renew-receipt'); });
        document.getElementById('receipt-btn-back')?.addEventListener('click',   () => { click(); this.showView('renew-results'); });
        document.getElementById('renew-nonrenewable-toggle')?.addEventListener('click', () => {
            click();
            const list  = document.getElementById('renew-nonrenewable-list');
            const arrow = document.getElementById('renew-toggle-arrow');
            if (list)  list.classList.toggle('collapsed');
            if (arrow) arrow.classList.toggle('collapsed');
        });
        document.querySelectorAll('.renew-receipt-choice').forEach((btn) => {
            btn.addEventListener('click', () => {
                click();
                this.handleReceiptChoice(btn.getAttribute('data-receipt'));
            });
        });
    } // end setupEventListeners

    // ─── Renew Module ────────────────────────────────────────────────────────────

    /** Step 1: Initialise state and show patron scan screen. */
    startRenew() {
        this.currentOperation = 'renew';
        this.scanningEnabled   = false;  // No item scanning in renew flow
        this.renewPatronCard   = '';
        this.renewItemsData    = null;
        this.renewBatchResults = null;
        this.recentRfidTags.clear();

        if (window.rfidService)       window.rfidService.resetSession();
        if (window.patronRfidService) window.patronRfidService.resetSession();

        this.showView('renew-scan');
        this.resetAutoLogout();
        void this.disarmRfidBridge(true);

        // Put patron RFID reader into listen mode
        if (window.patronRfidService?.beginRenewSession) {
            window.patronRfidService.beginRenewSession();
        }
    }

    /**
     * Step 1 → 2: Called by patron-rfid-service when a card is scanned on the scan screen.
     * Guards itself so it only acts when the scan view is actually active.
     */
    handleRenewPatronScan(cardValue) {
        if (this.currentOperation !== 'renew') return;
        if (this.currentView     !== 'renew-scan') return; // already advanced past scan

        const cleaned = String(cardValue || '').trim();
        if (!cleaned) return;

        this.renewPatronCard = cleaned;
        if (typeof KioskSounds !== 'undefined') KioskSounds.success();
        this.resetAutoLogout();
        void this._renewGoToConnecting(cleaned);
    }

    /** Step 2: Show connecting spinner, fetch items, enforce minimum display time. */
    async _renewGoToConnecting(patronCard) {
        this.showView('renew-connecting');

        const MIN_SPINNER_MS = 1500;
        const t0 = Date.now();
        let itemsData  = null;
        let fetchError = null;

        try {
            itemsData = await this.api.getItemsForRenew(patronCard);
        } catch (err) {
            fetchError = err;
        }

        // Enforce minimum spinner time so the transition doesn't flash
        const elapsed = Date.now() - t0;
        if (elapsed < MIN_SPINNER_MS) await this.delay(MIN_SPINNER_MS - elapsed);

        if (fetchError || !itemsData?.data) {
            this.showError(fetchError?.message || 'Unable to load items. Please try again.');
            this.showView('renew-scan');
            return;
        }

        this.renewItemsData = itemsData.data;
        this.showRenewItems(itemsData.data);
    }

    /** Step 3: Render the Items Out screen (two-section layout). */
    showRenewItems(data) {
        const { patronName, patronCardNumber, items } = data;

        // Update patron chip in header bar
        const chip = document.getElementById('renew-patron-chip');
        if (chip) chip.textContent = `\u{1F464} ${patronName || patronCardNumber}`;

        // Classify: renewable = true|null (unknown → treat as renewable); notRenewable = false
        const renewableItems    = items.filter((i) => i.renewable !== false);
        const notRenewableItems = items.filter((i) => i.renewable === false);

        // ── Section A: Renewable ──────────────────────────────────────────
        const renewableList  = document.getElementById('renew-renewable-list');
        const noRenewableMsg = document.getElementById('renew-no-renewable');
        if (renewableList) {
            renewableList.innerHTML = '';
            if (renewableItems.length === 0) {
                if (noRenewableMsg) noRenewableMsg.style.display = '';
            } else {
                if (noRenewableMsg) noRenewableMsg.style.display = 'none';
                renewableItems.forEach((item, idx) => {
                    renewableList.insertAdjacentHTML('beforeend', this._buildRenewItemRow(item, idx, true));
                });
            }
        }

        // ── Section B: Not Renewable ──────────────────────────────────────
        const nonRenewableList    = document.getElementById('renew-nonrenewable-list');
        const nonRenewableSection = document.getElementById('renew-section-nonrenewable');
        const countBadge          = document.getElementById('renew-nonrenewable-count');
        if (countBadge) countBadge.textContent = notRenewableItems.length;
        if (nonRenewableSection) {
            nonRenewableSection.style.display = notRenewableItems.length > 0 ? '' : 'none';
        }
        if (nonRenewableList) {
            nonRenewableList.innerHTML = '';
            nonRenewableList.classList.remove('collapsed'); // reset collapse on each load
            const arrow = document.getElementById('renew-toggle-arrow');
            if (arrow) arrow.classList.remove('collapsed');
            notRenewableItems.forEach((item) => {
                nonRenewableList.insertAdjacentHTML('beforeend', this._buildRenewItemRow(item, -1, false));
            });
        }

        this.showView('renew-items');
        this.resetAutoLogout();
    }

    /** Build a single item row for the items-out list. */
    _buildRenewItemRow(item, idx, isRenewable) {
        const title   = item.itemTitle || item.itemBarcode || 'Unknown Item';
        const barcode = item.itemBarcode || '';
        const dueDate = item.dueDate
            ? this.formatDate(this.parseCalendarDate(item.dueDate))
            : 'Unknown due date';

        const cbAttrs = isRenewable
            ? `class="renew-item-checkbox" data-barcode="${barcode}" data-idx="${idx}"`
            : `class="renew-item-checkbox" disabled`;

        let badgeHtml = '';
        if (isRenewable && item.renewalsRemaining !== null && item.renewalsRemaining !== undefined) {
            badgeHtml = `<span class="renew-renewals-badge">Renewals left: ${item.renewalsRemaining}</span>`;
        }
        if (!isRenewable && item.notRenewableReason) {
            badgeHtml = `<span class="renew-reason-pill">\u{1F6AB} ${item.notRenewableReason}</span>`;
        }

        return `
            <div class="renew-item-row">
                <input type="checkbox" ${cbAttrs}>
                <div class="renew-item-info">
                    <div class="renew-item-title" title="${title}">${title}</div>
                    <div class="renew-item-meta">
                        <span>\u{1F4C5} Due: ${dueDate}</span>
                        ${badgeHtml}
                    </div>
                </div>
            </div>
        `;
    }

    /** Select / Unselect All checkboxes in the renewable section. */
    _toggleSelectAllRenew(selectAll) {
        document.querySelectorAll('#renew-renewable-list .renew-item-checkbox:not(:disabled)')
            .forEach((cb) => { cb.checked = selectAll; });
    }

    /** Step 3 → 5: Collect selections and call batch renewal. */
    async handleRenewSelected() {
        const selected = [];
        document.querySelectorAll('#renew-renewable-list .renew-item-checkbox:not(:disabled):checked')
            .forEach((cb) => {
                const barcode = cb.getAttribute('data-barcode');
                if (barcode) selected.push(barcode);
            });

        if (selected.length === 0) {
            this.showError('Please select at least one item to renew.');
            return;
        }

        const btn = document.getElementById('btn-renew-selected');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> Renewing\u2026';
        }

        try {
            const result = await this.api.renewBatch(this.renewPatronCard, selected);
            this.renewBatchResults = result.results || [];

            // Capture lastTransaction for receipt printing/emailing
            this.lastTransaction = {
                transactionType   : 'RENEW',
                timestamp         : new Date().toISOString(),
                patronCardNumber  : this.renewPatronCard,
                patronName        : this.renewItemsData?.patronName || '',
                items             : this.renewBatchResults.map((r) => ({
                    barcode    : r.barcode,
                    title      : r.itemTitle || r.barcode,
                    newDueDate : r.newDueDate || '',
                    status     : r.ok ? 'renewed' : 'failed',
                    message    : r.message || ''
                }))
            };

            this.showRenewResults(
                this.renewBatchResults,
                this.renewItemsData?.patronName || this.renewPatronCard
            );
            if (typeof KioskSounds !== 'undefined') KioskSounds.success();
            this.triggerHardwareLED('SUCCESS');
        } catch (error) {
            this.showError(error.message || 'Renewal failed. Please contact staff.');
            if (typeof KioskSounds !== 'undefined') KioskSounds.error();
            this.triggerHardwareLED('ERROR');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '\u{1F504} Renew Selected';
            }
        }
    }

    /** Step 5: Render per-item results with staggered animation. */
    showRenewResults(results, patronName) {
        const list = document.getElementById('renew-results-list');
        if (!list) return;
        list.innerHTML = '';

        results.forEach((r, i) => {
            const isOk      = r.ok === true;
            const icon      = isOk ? '\u2705' : '\u274C';
            const cls       = isOk ? 'success' : 'fail';
            const delayStyle = `animation-delay: ${i * 0.07}s;`;

            let statusText = '';
            if (isOk) {
                const formattedDue = r.newDueDate
                    ? this.formatDate(this.parseCalendarDate(r.newDueDate))
                    : 'See receipt';
                statusText = `Renewed \u2022 New due: ${formattedDue}`;
            } else {
                statusText = r.message || 'Renewal failed. Please contact staff.';
            }

            list.insertAdjacentHTML('beforeend', `
                <div class="renew-result-row ${cls}" style="${delayStyle}">
                    <div class="renew-result-icon">${icon}</div>
                    <div class="renew-result-info">
                        <div class="renew-result-title">${r.itemTitle || r.barcode}</div>
                        <div class="renew-result-status">${statusText}</div>
                    </div>
                </div>
            `);
        });

        this.showView('renew-results');
        this.resetAutoLogout();
    }

    /**
     * Results → My Account: navigate to the full account view,
     * pre-fill the patron card and auto-load account data.
     */
    async handleRenewAccountBtn() {
        const patronCard = this.renewPatronCard || this.renewItemsData?.patronCardNumber;
        if (!patronCard) {
            this.showError('Unable to load account \u2014 patron card not found.');
            return;
        }

        // Reuse existing My Account view + infrastructure
        this.startAccount();
        const cardInput = document.getElementById('account-card');
        if (cardInput) cardInput.value = patronCard;

        this.showLoading('account', true);
        try {
            const result = await this.api.getAccount(patronCard);
            this.displayAccountSummary(result.data || {});
        } catch (error) {
            this.showError(error.message || 'Unable to fetch account details');
        } finally {
            this.showLoading('account', false);
        }
    }

    /**
     * Receipt Options — handles all 4 choices with real functionality.
     * Print:  generate receipt HTML → Electron silent print (or window.print fallback)
     * Email:  not yet available; shows patron-friendly message and re-enables buttons
     * Both:   print first, then report email status
     * None:   clear state, go Home immediately
     */
    async handleReceiptChoice(choice) {
        if (choice === 'none') {
            this.lastTransaction = null;
            this.showView('home');
            return;
        }

        // Disable all buttons; mark selected one as loading
        const selectedBtn = document.querySelector(`.renew-receipt-choice[data-receipt="${choice}"]`);
        document.querySelectorAll('.renew-receipt-choice').forEach((btn) => {
            btn.disabled = true;
            if (btn === selectedBtn) btn.classList.add('loading');
        });

        if (choice === 'print') {
            const r = await this._doPrintReceipt();
            document.querySelectorAll('.renew-receipt-choice').forEach((b) => b.classList.remove('loading'));
            this._showReceiptStatus(r.ok, r.message);
            if (!r.ok) {
                // Failure: re-enable buttons so patron can choose another option
                document.querySelectorAll('.renew-receipt-choice').forEach((b) => { b.disabled = false; });
                return;
            }
            await this.delay(2500);
            this.lastTransaction = null;
            this.showView('home');
            return;
        }

        if (choice === 'both') {
            const r = await this._doPrintReceipt();
            document.querySelectorAll('.renew-receipt-choice').forEach((b) => b.classList.remove('loading'));
            const combined = r.ok
                ? 'Receipt printed \u2713  |  Email: not yet configured'
                : `Print failed  |  Email: not yet configured`;
            this._showReceiptStatus(r.ok, combined);
            await this.delay(3000);
            this.lastTransaction = null;
            this.showView('home');
            return;
        }

        if (choice === 'email') {
            document.querySelectorAll('.renew-receipt-choice').forEach((b) => b.classList.remove('loading'));
            this._showReceiptStatus(false, 'Email receipts require email setup in Koha. Contact library staff.');
            // Re-enable so patron can pick another option
            document.querySelectorAll('.renew-receipt-choice').forEach((b) => { b.disabled = false; });
        }
    }

    /** Resets receipt screen to initial state (re-enable buttons, hide confirm). */
    _resetReceiptScreen() {
        document.querySelectorAll('.renew-receipt-choice').forEach((btn) => {
            btn.disabled = false;
            btn.classList.remove('loading');
        });
        const confirmEl = document.getElementById('renew-receipt-confirm');
        if (confirmEl) confirmEl.style.display = 'none';
    }

    /**
     * Executes the actual print action.
     * Uses Electron's silentPrint IPC if available, falls back to window.open + print().
     * @returns {{ ok: boolean, message: string }}
     */
    async _doPrintReceipt() {
        if (!this.lastTransaction) {
            return { ok: false, message: 'No transaction data available. Please try again.' };
        }

        const html = this._generateReceiptHTML(this.lastTransaction);

        try {
            if (window.electronAPI?.silentPrint) {
                const result = await window.electronAPI.silentPrint(html);
                if (result?.success) {
                    return { ok: true,  message: 'Receipt sent to printer \u2713' };
                }
                const reason = result?.error || 'Unknown print failure';
                if (/cancel/i.test(reason)) {
                    return { ok: false, message: 'Print was cancelled.' };
                }
                return { ok: false, message: `Printer error: ${reason}. Please try again or contact staff.` };
            }

            // Browser / demo-mode fallback: open popup and call window.print()
            const w = window.open('', '_blank', 'width=700,height=900');
            if (w) {
                w.document.write(html);
                w.document.close();
                w.focus();
                w.print();
                w.close();
                return { ok: true, message: 'Print dialog opened \u2713' };
            }
            return { ok: false, message: 'Could not open print window. Check popup settings.' };
        } catch (err) {
            return { ok: false, message: err.message || 'Print failed. Please contact staff.' };
        }
    }

    /** Updates the confirm area with a success or failure status message. */
    _showReceiptStatus(success, message) {
        const confirmEl   = document.getElementById('renew-receipt-confirm');
        const confirmIcon = confirmEl?.querySelector('.renew-receipt-confirm-icon');
        const confirmText = document.getElementById('renew-receipt-confirm-text');

        if (confirmIcon) {
            confirmIcon.textContent = success ? '\u2713' : '\u2717';
            confirmIcon.style.background = success
                ? 'linear-gradient(135deg, #10b981, #059669)'
                : 'linear-gradient(135deg, #ef4444, #dc2626)';
        }
        if (confirmText) confirmText.textContent = message;
        if (confirmEl)   confirmEl.style.display  = 'flex';
    }

    /**
     * Generates a self-contained, printer-friendly HTML receipt string.
     * No external dependencies — all CSS is inline so it prints identically
     * whether sent to a receipt printer or a regular printer.
     */
    _generateReceiptHTML(tx) {
        const now       = new Date(tx.timestamp || Date.now());
        const dateStr   = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
        const timeStr   = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        const patronStr = (tx.patronName || '').trim();

        const rows = (tx.items || []).map((item) => {
            const isRenewed  = item.status === 'renewed';
            const statusCls  = isRenewed ? 'status-ok' : 'status-fail';
            const statusText = isRenewed ? '\u2713 Renewed' : '\u2717 Not renewed';
            const dueDisp    = item.newDueDate
                ? this.formatDate(this.parseCalendarDate(item.newDueDate))
                : (isRenewed ? 'See librarian' : '\u2014');
            const title = String(item.title || item.barcode || 'Unknown item')
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<tr><td>${title}</td><td class="${statusCls}">${statusText}</td><td>${dueDisp}</td></tr>`;
        }).join('');

        const renewedCount = (tx.items || []).filter((i) => i.status === 'renewed').length;
        const totalCount   = (tx.items || []).length;

        return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<title>Renewal Receipt \u2014 ${dateStr}</title>
<style>
@page{margin:14mm;size:A4}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#111}
.hdr{text-align:center;border-bottom:2px solid #222;padding-bottom:10px;margin-bottom:12px}
.lib{font-size:17pt;font-weight:900;letter-spacing:-.3px}
.rtype{font-size:11pt;color:#555;margin-top:3px}
.meta{margin-bottom:12px;line-height:1.8}
.meta strong{display:inline-block;min-width:75px}
.summary{margin-bottom:10px;font-size:10.5pt;font-weight:bold}
table{width:100%;border-collapse:collapse;margin-bottom:14px}
th{background:#f3f3f3;border:1px solid #aaa;padding:5px 8px;font-size:10pt;text-align:left}
td{border:1px solid #ccc;padding:5px 8px;font-size:10pt;vertical-align:top}
.status-ok{color:#065f46;font-weight:bold}
.status-fail{color:#991b1b;font-weight:bold}
.ftr{text-align:center;font-size:9pt;color:#777;border-top:1px solid #ddd;padding-top:10px;margin-top:6px;line-height:1.7}
</style></head>
<body>
<div class="hdr">
  <div class="lib">Punjabi University Library</div>
  <div class="rtype">Renewal Receipt</div>
</div>
<div class="meta">
  <p><strong>Date:</strong> ${dateStr}</p>
  <p><strong>Time:</strong> ${timeStr}</p>
  ${patronStr ? `<p><strong>Patron:</strong> ${patronStr}</p>` : ''}
</div>
<p class="summary">Items renewed: ${renewedCount} of ${totalCount}</p>
<table>
<thead><tr><th style="width:54%">Item Title</th><th style="width:20%">Status</th><th style="width:26%">New Due Date</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<div class="ftr">
  Thank you for using Punjabi University Library.<br>
  Please return items on or before the due date shown.<br>
  <em>Powered by SoCTeamup Semiconductors</em>
</div>
</body></html>`;
    }

    // ─── End Renew Module ─────────────────────────────────────────────────────────




        document.getElementById('btn-final-done')?.addEventListener('click', () => {
            click();
            this.showView('home');
        });
    }

    startCheckOut() {
        this.currentOperation = 'checkout';
        this.scanningEnabled = true;
        this.checkoutSessionBooks = [];
        this.checkoutStagedBooks = [];
        this.recentRfidTags.clear();
        this.pendingCheckinBarcodes.clear();
        this.processedCheckinBarcodes.clear();
        if (window.rfidService) window.rfidService.resetSession();
        if (window.patronRfidService) window.patronRfidService.resetSession();
        document.getElementById('checkout-form')?.reset();

        this.renderCheckoutStagedBooks();

        const btnConfirm = document.getElementById('btn-confirm-checkout');
        if (btnConfirm) {
            btnConfirm.enabled = true;
            btnConfirm.innerHTML = `✓ Confirm Checkout <span id="checkout-item-count" style="background: rgba(255,255,255,0.25); border-radius: 50%; width: 24px; height: 24px; display: inline-flex; justify-content: center; align-items: center; font-size: 0.85rem;">0</span>`;
        }

        this.showView('checkout');
        this.resetAutoLogout();
        if (window.patronRfidService) window.patronRfidService.beginCheckoutSession();
        document.getElementById('patron-card')?.focus();

        void this.armRfidBridge('00');

        if (window.rfidService?.activateLiveScan) {
            window.rfidService.activateLiveScan({
                graceMs: 5000,
                bootstrapPolls: 8,
                bootstrapIntervalMs: 175
            });
        }
    }

    startCheckIn() {
        this.currentOperation = 'checkin';
        this.checkinSessionCount = 0;
        this.checkinSessionBooks = [];
        this.scanningEnabled = false;
        this.recentRfidTags.clear();
        this.pendingCheckinBarcodes.clear();
        this.processedCheckinBarcodes.clear();

        // Reset RFID session so all tags are treated as new
        if (window.rfidService) window.rfidService.resetSession();

        // Clear previous results
        const resultsContainer = document.getElementById('checkin-results');
        if (resultsContainer) resultsContainer.innerHTML = '';

        // Show Step 1 (Place Book), hide Step 2 (Scanning) and scan actions
        const stepPlace = document.getElementById('checkin-step-place');
        const stepScan = document.getElementById('checkin-step-scanning');
        const scanActions = document.getElementById('checkin-scan-actions');

        if (stepPlace) stepPlace.style.display = 'flex';
        if (stepScan) stepScan.style.display = 'none';
        if (scanActions) scanActions.style.display = 'none';

        this.showView('checkin');
        this.resetAutoLogout();

        // Disarm first (in case we're re-entering check-in)
        void this.disarmRfidBridge(true);
    }

    startAccount() {
        this.currentOperation = 'account';
        this.scanningEnabled = false;
        this.recentRfidTags.clear();
        this.pendingCheckinBarcodes.clear();
        this.processedCheckinBarcodes.clear();
        if (window.patronRfidService) window.patronRfidService.resetSession();

        document.getElementById('account-form')?.reset();
        const resultsContainer = document.getElementById('account-results');
        // Reset UI to login screen
        const loginScreen = document.getElementById('account-login-screen');
        const dashboard = document.getElementById('account-dashboard');
        const resultsContainer = document.getElementById('account-results');
        const statusEl = document.getElementById('account-reader-status');
        const errorEl = document.getElementById('account-reader-error');
        const hidInput = document.getElementById('account-hid-input');

        if (loginScreen) loginScreen.style.display = 'flex';
        if (dashboard) dashboard.style.display = 'none';
        if (resultsContainer) { resultsContainer.innerHTML = ''; resultsContainer.style.display = 'none'; }
        if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Waiting for card\u2026 Place card on reader'; }
        if (errorEl) errorEl.style.display = 'none';
        if (hidInput) { hidInput.value = ''; }

        this.showView('account');
        this.resetAutoLogout();
        if (window.patronRfidService?.beginAccountSession) window.patronRfidService.beginAccountSession();
        void this.disarmRfidBridge(true);

        // Auto-focus HID input
        this._focusHidInput();
    }

    startSearch() {
        this.currentOperation = 'search';
        document.getElementById('search-form')?.reset();
        const resultsContainer = document.getElementById('search-results');
        if (resultsContainer) {
            resultsContainer.innerHTML = '';
            resultsContainer.style.display = 'none';
        }

        this.showView('account');
        this.resetAutoLogout();
        if (window.patronRfidService?.beginAccountSession) window.patronRfidService.beginAccountSession();
        document.getElementById('account-card')?.focus();
        void this.disarmRfidBridge(true);
    }

        this.showView('search');
        this.resetAutoLogout();
        void this.disarmRfidBridge(true);
        document.getElementById('search-input')?.focus();
    }

    async handleSearchSubmit(e) {
        e.preventDefault();
        const query = document.getElementById('search-input')?.value.trim() || '';
        if (!query) {
            this.showError('Please enter a search query.');
            return;
        }

        this.showLoading('search', true);
        try {
            const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
            const payload = await response.json();
            if (!response.ok || !payload.success) {
                throw new Error(payload.message || 'Search failed');
            }
            this.displaySearchResults(payload.data || [], query);
        } catch (error) {
            this.showError(error.message || 'Unable to fetch search results');
        } finally {
            this.showLoading('search', false);
        }
    }

    displaySearchResults(results, query) {
        const container = document.getElementById('search-results');
        if (!container) return;

        if (!results || results.length === 0) {
            container.innerHTML = `
                <div class="account-empty">
                    No results found for "${query}".
                </div>
            `;
            container.style.display = 'block';
            return;
        }

        let html = `
            <div class="account-summary">
                <div class="account-summary-header">
                    <h2>Search Results</h2>
                    <div class="account-card-number">Found ${results.length} matches</div>
                </div>
                <div class="account-loans-grid">
        `;

        results.forEach(book => {
            const statusColor = book.status === 'available' ? '#10b981' : '#f59e0b';
            const statusText = book.status === 'available' ? 'Available' : 'Checked Out';
            const holdBtn = book.status !== 'available'
                ? `<button class="btn btn-primary btn-place-hold" data-barcode="${book.barcode}" data-title="${(book.title || '').replace(/"/g, '&quot;')}" style="margin-top: 0.75rem; padding: 0.4rem 1rem; border-radius: 8px; font-size: 0.85rem; background: #3b82f6; border: none; color: white; font-weight: 600; cursor: pointer;">📌 Place Hold</button>`
                : '';
            html += `
                <div class="account-loan-card">
                    <div class="account-loan-title">${book.title || 'Unknown Title'}</div>
                    <div class="account-loan-meta">By ${book.author || 'Unknown Author'}</div>
                    <div class="account-loan-meta">Barcode/ISBN: ${book.barcode || 'N/A'}</div>
                    <div class="account-loan-meta" style="color: ${statusColor}; font-weight: 600; margin-top: 0.5rem;">● ${statusText}</div>
                    ${holdBtn}
                </div>
            `;
        });

        html += `
                </div>
            </div>
        `;

        container.innerHTML = html;
        container.style.display = 'block';

        // Bind hold buttons
        container.querySelectorAll('.btn-place-hold').forEach(btn => {
            btn.addEventListener('click', () => {
                this.openHoldModal(btn.dataset.barcode, btn.dataset.title);
            });
        });
    }

    handleDoneCheckIn() {
        if (!this.checkinSessionCount || this.checkinSessionCount === 0) {
            void this.disarmRfidBridge(true);
            this.showView('home');
            return;
        }

        this.printType = 'checkin';
        void this.disarmRfidBridge(true);
        this.showView('print-receipt');
    }

    handleDoneCheckout() {
        if (!this.checkoutSessionBooks || this.checkoutSessionBooks.length === 0) {
            void this.disarmRfidBridge(true);
            this.showView('home');
            return;
        }

        this.printType = 'checkout';
        void this.disarmRfidBridge(true);
        this.showView('print-receipt');
    }

    handlePrintReceipt(willPrint) {
        if (willPrint) {
            if (this.printType === 'checkout') {
                this.executeSysPrint('checkout', {
                    patronCard: this.checkoutSessionPatronCard,
                    patronName: this.checkoutSessionPatronName,
                    books: this.checkoutSessionBooks
                });
            } else if (this.printType === 'checkin') {
                this.executeSysPrint('checkin', {
                    books: this.checkinSessionBooks
                });
            }
        }

        if (this.printType === 'checkout') {
            const count = this.checkoutSessionBooks?.length || 0;
            this.showThankYouSummary(count);
        } else {
            this.showThankYouSummary(this.checkinSessionCount);
            this.showCheckinSummary();
        }
    }

    executeSysPrint(type, data) {
        const collegeName = "Punjabi University";
        const dateStr = new Date().toLocaleString();
        let booksHtml = '';

        data.books.forEach(book => {
            booksHtml += `
                <div style="margin-bottom: 8px; border-bottom: 1px dashed #666; padding-bottom: 4px;">
                    <div><strong>Title:</strong> ${book.title}</div>
                    <div><strong>Barcode:</strong> ${book.barcode}</div>
                    ${book.patronNo ? `<div><strong>Patron No:</strong> ${book.patronNo}</div>` : ''}
                    ${book.dueDate ? `<div><strong>Due:</strong> ${book.dueDate}</div>` : ''}
                    ${book.returnDate ? `<div><strong>Returned:</strong> ${book.returnDate}</div>` : ''}
        let itemNo = 0;

        data.books.forEach(book => {
            itemNo++;
            booksHtml += `
                <div style="margin-bottom: 5px; border-bottom: 1px dashed #000; padding-bottom: 3px; font-size: 10px; color: #000;">
                    <div><b>${itemNo}. ${book.title || 'Unknown'}</b></div>
                    <div>Barcode: ${book.barcode}</div>
                    ${book.patronNo ? `<div>Patron: ${book.patronNo}</div>` : ''}
                    ${type === 'checkout' ? (book.dueDate ? `<div>Due: ${book.dueDate}</div>` : '') : ''}
                    ${type === 'checkin' ? (book.returnDate ? `<div>Returned: ${book.returnDate}</div>` : '') : ''}
                </div>
            `;
        });

        const receiptContent = `
            <div id="sys-print-receipt" style="font-family: 'Courier New', Courier, monospace; text-align: center; width: 70mm; margin: 0 auto; color: #000; padding: 10px;">
                <h2 style="font-size: 16px; margin: 4px 0; font-weight: bold;">${collegeName}</h2>
                <h2 style="font-size: 16px; margin: 4px 0; font-weight: bold;">Smart Library Kiosk</h2>
                <div style="font-size: 11px; margin-bottom: 12px;">${dateStr}</div>
                ${data.patronCard ? `<div style="text-align: left; font-size: 12px; margin-bottom: 12px; font-weight: bold;">Patron: ${data.patronName || data.patronCard} <br>Card: ${data.patronCard}</div>` : ''}
                <div style="text-align: left; font-weight: bold; margin-bottom: 6px; border-bottom: 1px dashed #000; padding-bottom: 4px;">
                    ${type === 'checkout' ? 'Checked Out Items' : 'Checked In Items'}
                </div>
                <div style="text-align: left; font-size: 11px; margin-top: 6px;">
                    ${booksHtml}
                </div>
                <div style="margin-top: 15px; font-size: 11px; font-style: italic; text-align: center;">Thank you for visiting!</div>
        const patronLine = data.patronCard
            ? `<div style="text-align: left; font-size: 10px; margin-bottom: 6px; color: #000;"><b>Patron:</b> ${data.patronName || data.patronCard}<br><b>Card:</b> ${data.patronCard}</div>`
            : `<div style="text-align: left; font-size: 10px; margin-bottom: 6px; color: #000;"><b>Patron:</b> N/A</div>`;

        const actionTitle = type === 'checkout' ? 'CHECKED OUT' : 'CHECKED IN';

        const receiptContent = `
            <div id="thermal-print-container" style="width: 100%; max-width: 100%; font-family: 'Courier New', Courier, monospace; text-align: center; color: #000; padding: 0; margin: 0; overflow: hidden; word-wrap: break-word;">
                <h2 style="font-size: 12px; margin: 2px 0; font-weight: bold; color: #000;">${collegeName}</h2>
                <h2 style="font-size: 11px; margin: 2px 0; font-weight: bold; color: #000;">Smart Library Kiosk</h2>
                <div style="font-size: 9px; margin-bottom: 6px; color: #000;">========================</div>
                <div style="font-size: 9px; margin-bottom: 6px; color: #000;">${dateStr}</div>
                ${patronLine}
                <div style="text-align: left; font-weight: bold; margin-bottom: 3px; border-bottom: 1px dashed #000; padding-bottom: 2px; font-size: 10px; color: #000;">
                    ${actionTitle} (${data.books.length})
                </div>
                <div style="text-align: left; margin-top: 3px; color: #000;">
                    ${booksHtml}
                </div>
                <div style="margin-top: 8px; font-size: 9px; color: #000;">========================</div>
                <div style="margin-top: 3px; font-size: 9px; font-style: italic; text-align: center; color: #000;">Thank you for visiting!</div>
                <div style="margin-top: 2px; font-size: 8px; text-align: center; color: #000;">Powered by SoCTeamup</div>
                <div style="margin-top: 6px;">&nbsp;</div>
            </div>
        `;

        // If running in Electron with preload script, use the secure IPC silent print
        if (window.electronAPI && window.electronAPI.silentPrint) {
            window.electronAPI.silentPrint(receiptContent);
        } else {
            console.warn('[Kiosk] Electron API not found, falling back to browser print dialog.');

            // Fallback for non-Electron testing
            const printContainer = document.createElement('div');
            printContainer.id = 'temp-print-container';
            printContainer.innerHTML = receiptContent;
            document.body.appendChild(printContainer);

            const style = document.createElement('style');
            style.id = 'temp-print-style';
            style.innerHTML = `
                @media print {
                    body > * { display: none !important; }
                    body > #temp-print-container { display: block !important; }
                    @page { margin: 0; }
                    #temp-print-container {
                        width: 48mm;
                        margin: 0;
                        padding: 0;
                    }
                    @page { margin: 0; size: 48mm auto; }
                }
            `;
            document.head.appendChild(style);

            setTimeout(() => {
                window.print();
                setTimeout(() => {
                    if (document.body.contains(printContainer)) document.body.removeChild(printContainer);
                    if (document.head.contains(style)) document.head.removeChild(style);
                }, 2000);
            }, 100);
        }
    }

    showThankYouSummary(count) {
        const countSpan = document.getElementById('session-count');
        if (countSpan) countSpan.textContent = count;

    showThankYouSummary(count, type) {
        const typeArg = type || this.printType || 'checkin';
        const countSpan = document.getElementById('session-count');
        if (countSpan) countSpan.textContent = count;

        const actionText = document.getElementById('thankyou-action-text');
        if (actionText) actionText.textContent = typeArg === 'checkout' ? 'checked out' : 'checked in';
        
        const animCheckout = document.getElementById('thankyou-anim-checkout');
        const animCheckin = document.getElementById('thankyou-anim-checkin');
        
        if (typeArg === 'checkout') {
            if (animCheckout) animCheckout.style.display = 'block'; // Or flex depending on css
            if (animCheckin) animCheckin.style.display = 'none';
        } else {
            if (animCheckout) animCheckout.style.display = 'none';
            if (animCheckin) animCheckin.style.display = 'flex';
        }

        const quotes = [
            '"So many books, so little time." – Frank Zappa',
            '"A room without books is like a body without a soul." – Cicero',
            '"Keep reading. It\'s one of the most marvelous adventures." – Lloyd Alexander',
            '"Reading is dreaming with open eyes."',
            '"Today a reader, tomorrow a leader." – Margaret Fuller'
        ];
        const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
        const quoteEl = document.getElementById('thankyou-quote');
        if (quoteEl) quoteEl.textContent = randomQuote;

        this.showView('thankyou');
        if (typeof KioskSounds !== 'undefined') KioskSounds.celebration();

        setTimeout(() => {
            this.showView('home');
        }, 3500);
    }

    showCheckinSummary() {
        this.showView('checkin-success');
        if (typeof KioskSounds !== 'undefined') KioskSounds.celebration();
    }

    async startScanning() {
        // Switch from Step 1 to Step 2
        const stepPlace = document.getElementById('checkin-step-place');
        const stepScan = document.getElementById('checkin-step-scanning');
        const scanActions = document.getElementById('checkin-scan-actions');
        if (stepPlace) stepPlace.style.display = 'none';
        if (stepScan) stepScan.style.display = 'flex';
        if (scanActions) scanActions.style.display = 'block';

        // Focus hidden input so RFID can fill it
        document.getElementById('item-barcode-checkin')?.focus();
        console.log('[Kiosk] Scanning start requested');

        // Arm first so a tag already on the reader is republished as a fresh appearance.
        try {
            await this.armRfidBridge('90');
        } catch (error) {
            console.warn('[RFID] Continuing without confirmed arm:', error?.message || error);
        }

        this.scanningEnabled = true;

        if (window.rfidService?.activateLiveScan) {
            window.rfidService.activateLiveScan({
                graceMs: 5000,
                bootstrapPolls: 8,
                bootstrapIntervalMs: 175
            });
        }
    }

    /** Arm the RFID bridge: auto-write afi on next tag appearance */
    armRfidBridge(afi) {
        const normalizedAfi = String(afi || '').trim().toUpperCase();
        if (!normalizedAfi) {
            return Promise.reject(new Error('RFID AFI is required.'));
        }

        if (this.rfidArmState === normalizedAfi) {
            return Promise.resolve({ armed: true, afi: normalizedAfi, skipped: true });
        }

        if (this.rfidArmPendingAfi === normalizedAfi && this.rfidArmPendingPromise) {
            return this.rfidArmPendingPromise;
        }

        const generation = ++this.rfidArmGeneration;
        const pendingRequest = fetch(`/api/rfid/arm?afi=${encodeURIComponent(normalizedAfi)}`)
            .then(async (response) => {
                const payload = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(payload.message || `RFID arm failed (${response.status})`);
                }

                if (generation === this.rfidArmGeneration) {
                    this.rfidArmState = payload.armed ? normalizedAfi : null;
                }

                console.log('[RFID] Bridge armed afi=' + normalizedAfi, payload);
                return payload;
            })
            .catch((error) => {
                if (generation === this.rfidArmGeneration) {
                    this.rfidArmState = null;
                }
                console.warn('[RFID] Arm failed:', error.message);
                throw error;
            })
            .finally(() => {
                if (this.rfidArmPendingAfi === normalizedAfi) {
                    this.rfidArmPendingAfi = '';
                    this.rfidArmPendingPromise = null;
                }
            });

        this.rfidArmPendingAfi = normalizedAfi;
        this.rfidArmPendingPromise = pendingRequest;
        return pendingRequest;
    }

    /** Disarm the RFID bridge: stop auto-writing AFI */
    async disarmRfidBridge(force = false) {
        if (!force && !this.rfidArmState && !this.rfidArmPendingPromise) {
            return { armed: false, skipped: true };
        }

        const generation = ++this.rfidArmGeneration;
        this.rfidArmState = null;
        this.rfidArmPendingAfi = '';
        this.rfidArmPendingPromise = null;

        try {
            const response = await fetch('/api/rfid/disarm');
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(payload.message || `RFID disarm failed (${response.status})`);
            }

            if (generation === this.rfidArmGeneration) {
                this.rfidArmState = null;
            }

            console.log('[RFID] Bridge disarmed', payload);
            return payload;
        } catch (error) {
            console.warn('[RFID] Disarm failed:', error.message);
            throw error;
        }
    }

    renderCheckoutStagedBooks() {
        const container = document.getElementById('checkout-scanned-items');
        if (!container) return;
        container.innerHTML = '';

        this.checkoutStagedBooks.forEach((book, index) => {
            const el = document.createElement('div');
            el.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.75rem 1rem;';
            el.innerHTML = `
                <div style="display: flex; align-items: center; gap: 0.75rem;">
                    <span style="font-size: 1.5rem; color: #64748b;">📖</span>
                    <div>
                        <div style="font-weight: 600; color: #0f172a; font-size: 0.95rem;">${book.barcode}</div>
                        <div style="font-size: 0.8rem; color: #64748b;">UID: ${book.uid || 'N/A'}</div>
                    </div>
                </div>
                <button type="button" class="remove-staged-btn" data-index="${index}" style="background: none; border: none; font-size: 1.5rem; color: #cbd5e1; cursor: pointer; line-height: 1;">×</button>
            `;
            container.appendChild(el);
        });

        const confirmBtn = document.getElementById('btn-confirm-checkout');
        const countSpan = document.getElementById('checkout-item-count');
        if (countSpan) countSpan.textContent = this.checkoutStagedBooks.length;
        if (confirmBtn) {
            confirmBtn.disabled = this.checkoutStagedBooks.length === 0;
        }

        // Bind remove handlers
        container.querySelectorAll('.remove-staged-btn').forEach(btn => {
            btn.onclick = (e) => {
                const idx = parseInt(e.currentTarget.getAttribute('data-index'), 10);
                this.checkoutStagedBooks.splice(idx, 1);
                this.renderCheckoutStagedBooks();
            };
        });
    }

    async handleConfirmCheckout() {
        const patronCard = document.getElementById('patron-card').value.trim();
        if (!patronCard) {
            this.showError('Please enter patron card number.');
            return;
        }

        if (this.checkoutStagedBooks.length === 0) {
            this.showError('No books scanned for checkout.');
            return;
        }

        this.showLoading('checkout', true);
        const confirmBtn = document.getElementById('btn-confirm-checkout');
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<span class="spinner"></span> Processing...';
        }

        let allSuccessful = true;
        this.checkoutSessionBooks = [];
        this.checkoutSessionPatronCard = patronCard;

        for (const book of this.checkoutStagedBooks) {
            try {
                const result = await this.api.checkOut(patronCard, book.barcode, {
                    rfidUid: book.uid,
                    skipSecurityWrite: false
                });

                this.checkoutSessionBooks.push({
                    title: result.data.itemTitle || book.barcode,
                    barcode: book.barcode,
                    dueDate: this.formatDate(this.parseCalendarDate(result.data.dueDate))
                });
                this.checkoutSessionPatronName = result.data.patronName || patronCard;

                // Keep arming to ensure AFI resets gracefully
                void this.armRfidBridge('00');
            } catch (error) {
                console.error('[Kiosk] Checkout error for', book.barcode, error);
                this.showError(`Checkout failed for ${book.barcode}: ${error.message}`);
                allSuccessful = false;
            }
        }

        this.showLoading('checkout', false);

        // Clear staged books so user isn't stuck clicking confirm infinitely
        this.checkoutStagedBooks = [];
        this.renderCheckoutStagedBooks();

        // Print receipt for the successful ones and proceed
        if (this.checkoutSessionBooks.length > 0) {
            this.handleDoneCheckout();
        } else {
            this.showError("Checkout Aborted: All items failed. Returning to home...");
            setTimeout(() => {
                this.showView('home');
            }, 3000);
        }
    }

    async processCheckoutTag({ barcode, uid }) {
        if (this.currentOperation !== 'checkout') return;
        if (!barcode) return;

        const exists = this.checkoutStagedBooks.find(b => b.barcode === barcode);
        if (!exists) {
            this.checkoutStagedBooks.push({ barcode, uid: uid || '' });
            this.renderCheckoutStagedBooks();
            if (typeof KioskSounds !== 'undefined') KioskSounds.success();
        }
    }

    async handleCheckInSubmit(e) {
        e.preventDefault();
        const itemBarcode = document.getElementById('item-barcode-checkin').value.trim();
        if (!itemBarcode) return;
        await this.processBarcode({ barcode: itemBarcode });
        document.getElementById('item-barcode-checkin').value = '';
        document.getElementById('item-barcode-checkin').focus();
    }

    async handleAccountSubmit(e) {
        e.preventDefault();

        const patronCardNumber = document.getElementById('account-card')?.value.trim() || '';
        if (!patronCardNumber) {
            this.showError('Please enter patron card number.');
            return;
        }

        this.showLoading('account', true);

        try {
            const result = await this.api.getAccount(patronCardNumber);
            this.displayAccountSummary(result.data || {});
        } catch (error) {
            this.showError(error.message || 'Unable to fetch account details');
        } finally {
            this.showLoading('account', false);
        }
    }

    /**
     * Process a single barcode for check-in.
     * Shows a progress card, then flips to success/error.
     */
    async processBarcode(input) {
        const barcode = typeof input === 'string' ? input : String(input?.barcode || '').trim();
        const explicitUid = typeof input === 'object' && input ? String(input.uid || '').trim().toUpperCase() : '';
        if (!barcode) return;
        return this.processBarcodeWithRetry({ barcode, explicitUid });

        // Keep check-in dedupe separate from the UID cache used to resolve live RFID reads.
        if (this.pendingCheckinBarcodes.has(barcode) || this.processedCheckinBarcodes.has(barcode)) {
            console.log(`[Kiosk] Skipping duplicate check-in for barcode: ${barcode}`);
            return;
        }
        this.pendingCheckinBarcodes.add(barcode);

        const rfidUid = explicitUid || this.consumeRfidUid(barcode);

        const container = document.getElementById('checkin-results');
        if (!container) return;

        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

        // Step 1: Create a "processing" card with progress bar
        const card = document.createElement('div');
        card.className = 'result-card processing';
        card.innerHTML = `
            <div class="status-icon">⏳</div>
            <div class="card-info">
                <div class="card-title">${barcode}</div>
                <div class="card-status">Checking in…</div>
                <div class="progress-bar-track"><div class="progress-bar-fill"></div></div>
            </div>
            <div class="card-time">${timestamp}</div>
        `;
        container.prepend(card);

        // Step 2: Call check-in API (AFI was already written by the RFID bridge auto-write)
        try {
            // AFI pre-arm architecture: bridge already wrote AFI in the same cycle it detected the tag.
            // Just call the SIP2 check-in — no security write needed here.
            const result = await this.api.checkIn(barcode, {
                rfidUid,
                skipSecurityWrite: true
            });
            const displayName = (result.data && result.data.itemTitle && result.data.itemTitle !== 'Unknown')
                ? result.data.itemTitle
                : (result.data && result.data.itemBarcode) ? result.data.itemBarcode : barcode;

            const patronName = (result.data && result.data.patronName) ? result.data.patronName : 'N/A';
            const fineAmount = Number(result.data?.fineAmount);
            const safeFineAmount = Number.isFinite(fineAmount) ? fineAmount : 0;
            const securityUpdate = result.data?.securityUpdate || result.securityUpdate || null;
            const patronHtml = `<div style="font-size: 0.9rem; margin-top: 4px; color: var(--text-muted);">Patron: ${patronName}</div>`;
            const fineHtml = `<div style="font-size: 0.9rem; color: #ef4444; font-weight: 600;">Fine: Rs. ${safeFineAmount.toFixed(2)}</div>`;
            const securityHtml = securityUpdate && securityUpdate.success !== true
                ? `<div style="font-size: 0.9rem; color: #b45309; font-weight: 600;">Security write failed: ${securityUpdate.message || 'tag state not updated'}</div>`
                : '';

            // Flip to success
            card.className = 'result-card success';
            card.innerHTML = `
                <div class="status-icon">✅</div>
                <div class="card-info">
                    <div class="card-title">${displayName}</div>
                    <div class="card-status">✓ Check-in Successful</div>
                    ${patronHtml}
                    ${fineHtml}
                    ${securityHtml}
                </div>
                <div class="card-time">${timestamp}</div>
            `;
            this.checkinSessionCount++;
            this.processedCheckinBarcodes.add(barcode);
            if (typeof KioskSounds !== 'undefined') KioskSounds.success();
            this.triggerHardwareLED('SUCCESS');

        } catch (error) {
            // Extract barcode for display
            let displayName = barcode;
            if (error.itemBarcode) displayName = error.itemBarcode;
            this.showError(error?.message || 'Check-in failed');

            // Flip to error
            card.className = 'result-card error';
            card.innerHTML = `
                <div class="status-icon">❌</div>
                <div class="card-info">
                    <div class="card-title">${displayName}</div>
                    <div class="card-status">✗ Not Found</div>
                </div>
                <div class="card-time">${timestamp}</div>
            `;
            if (typeof KioskSounds !== 'undefined') KioskSounds.error();
            this.triggerHardwareLED('ERROR');
        } finally {
            this.pendingCheckinBarcodes.delete(barcode);
        }

        // Re-trigger slide-in animation on flip
        card.style.animation = 'none';
        card.offsetHeight; // force reflow
        card.style.animation = 'cardSlideIn 0.3s ease forwards';

        // Limit to 10 cards
        while (container.children.length > 10) {
            container.removeChild(container.lastChild);
        }
    }

    async processBarcodeWithRetry({ barcode, explicitUid = '' }) {
        if (this.pendingCheckinBarcodes.has(barcode) || this.processedCheckinBarcodes.has(barcode)) {
            console.log(`[Kiosk] Skipping duplicate check-in for barcode: ${barcode}`);
            return;
        }
        this.pendingCheckinBarcodes.add(barcode);

        const rfidUid = explicitUid || this.consumeRfidUid(barcode);
        const container = document.getElementById('checkin-results');
        if (!container) {
            this.pendingCheckinBarcodes.delete(barcode);
            return;
        }

        const timestamp = new Date().toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        const renderProcessingCard = (statusText) => {
            card.className = 'result-card processing';
            card.innerHTML = `
                <div class="status-icon">...</div>
                <div class="card-info">
                    <div class="card-title">${barcode}</div>
                    <div class="card-status">${statusText}</div>
                    <div class="progress-bar-track"><div class="progress-bar-fill"></div></div>
                </div>
                <div class="card-time">${timestamp}</div>
            `;
        };

        const renderSuccessCard = (result) => {
            const displayName = (result.data && result.data.itemTitle && result.data.itemTitle !== 'Unknown')
                ? result.data.itemTitle
                : (result.data && result.data.itemBarcode) ? result.data.itemBarcode : barcode;
            const patronNo = (result.data && result.data.patronCardNumber) ? result.data.patronCardNumber : 'N/A';
            const fineAmount = Number(result.data?.fineAmount);
            const safeFineAmount = Number.isFinite(fineAmount) ? fineAmount : 0;
            const securityUpdate = result.data?.securityUpdate || result.securityUpdate || null;
            const patronHtml = `<div style="font-size: 0.9rem; margin-top: 4px; color: var(--text-muted);">Patron: ${patronNo}</div>`;
            const fineHtml = `<div style="font-size: 0.9rem; color: #ef4444; font-weight: 600;">Fine: Rs. ${safeFineAmount.toFixed(2)}</div>`;
            const securityHtml = securityUpdate && securityUpdate.success !== true
                ? `<div style="font-size: 0.9rem; color: #b45309; font-weight: 600;">Security write failed: ${securityUpdate.message || 'tag state not updated'}</div>`
                : '';


            if (!this.checkinSessionBooks) this.checkinSessionBooks = [];
            this.checkinSessionBooks.push({
                title: displayName,
                barcode: barcode,
                patronNo: patronNo,
                returnDate: new Date().toLocaleDateString()
            });

            card.className = 'result-card success';
            card.innerHTML = `
                <div class="status-icon">OK</div>
                <div class="card-info">
                    <div class="card-title">${displayName}</div>
                    <div class="card-status">Check-in Successful</div>
                    ${patronHtml}
                    ${fineHtml}
                    ${securityHtml}
                </div>
                <div class="card-time">${timestamp}</div>
            `;
        };

        const renderErrorCard = (error) => {
            const displayName = error?.itemBarcode || barcode;
            card.className = 'result-card error';
            card.innerHTML = `
                <div class="status-icon">X</div>
                <div class="card-info">
                    <div class="card-title">${displayName}</div>
                    <div class="card-status">${error?.message || 'Check-in failed'}</div>
                </div>
                <div class="card-time">${timestamp}</div>
            `;
        };

        const card = document.createElement('div');
        renderProcessingCard('Checking in...');
        container.prepend(card);

        const finalizeRenderedCard = () => {
            card.style.animation = 'none';
            card.offsetHeight;
            card.style.animation = 'cardSlideIn 0.3s ease forwards';

            while (container.children.length > 10) {
                container.removeChild(container.lastChild);
            }
        };

        const maxAttempts = Math.max(1, Number(CONFIG?.rfid?.checkinRetryAttempts) || 1);
        const retryDelayMs = Math.max(0, Number(CONFIG?.rfid?.checkinRetryDelayMs) || 0);
        let lastError = null;

        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                if (attempt > 1) {
                    renderProcessingCard(`Retrying check-in (${attempt}/${maxAttempts})...`);
                }

                try {
                    // Flow: book marked returned in DB first, THEN server writes AFI = 0x90 (secured).
                    // skipSecurityWrite is false so the server always writes AFI after checkin.
                    const result = await this.api.checkIn(barcode, {
                        rfidUid,
                        skipSecurityWrite: false
                    });
                    renderSuccessCard(result);
                    this.checkinSessionCount++;
                    this.processedCheckinBarcodes.add(barcode);
                    if (typeof KioskSounds !== 'undefined') KioskSounds.success();
                    this.triggerHardwareLED('SUCCESS');
                    finalizeRenderedCard();
                    return;
                } catch (error) {
                    lastError = error;
                    if (attempt < maxAttempts) {
                        await this.delay(retryDelayMs);
                    }
                }
            }
        } finally {
            this.pendingCheckinBarcodes.delete(barcode);
        }

        this.showError(lastError?.message || 'Check-in failed');
        renderErrorCard(lastError);
        if (typeof KioskSounds !== 'undefined') KioskSounds.error();
        this.triggerHardwareLED('ERROR');
        finalizeRenderedCard();
    }

    noteRfidTag(barcode, uid) {
        const normalizedBarcode = String(barcode || '').trim();
        const normalizedUid = String(uid || '').trim().toUpperCase();
        if (!normalizedBarcode || !normalizedUid) return;

        this.recentRfidTags.set(normalizedBarcode, {
            uid: normalizedUid,
            seenAt: Date.now()
        });
    }

    consumeRfidUid(barcode) {
        const normalizedBarcode = String(barcode || '').trim();
        if (!normalizedBarcode) return '';

        const tagInfo = this.recentRfidTags.get(normalizedBarcode);
        if (!tagInfo) return '';

        if ((Date.now() - tagInfo.seenAt) > 1500) {
            this.recentRfidTags.delete(normalizedBarcode);
            return '';
        }

        return tagInfo.uid || '';
    }

    // Legacy — kept for backward compatibility but not used for RFID flow
    showCheckInResult(success, data) {
        // No-op: processBarcode handles rendering directly now
    }

    displayCheckOutSuccess(data) {
        const container = document.getElementById('checkout-success-details');
        if (!container) return;

        const dueDate = this.parseCalendarDate(data.dueDate);
        const securityUpdate = data?.securityUpdate || null;
        const securityWarning = securityUpdate && securityUpdate.success !== true
            ? `
        <div class="detail-row">
          <span class="label">Security:</span>
          <span class="value" style="color:#b45309;font-weight:600;">${securityUpdate.message || 'Tag state was not updated'}</span>
        </div>`
            : '';

        container.innerHTML = `
      <div class="success-icon">✓</div>
      <h2>Check-Out Successful!</h2>
      <div class="transaction-details">
        <div class="detail-row">
          <span class="label">Patron:</span>
          <span class="value">${data.patronName}</span>
        </div>
        <div class="detail-row">
          <span class="label">Title:</span>
          <span class="value" style="font-weight: 600;">${data.itemTitle}</span>
        </div>
        ${data.itemAuthor ? `
        <div class="detail-row">
          <span class="label">Author:</span>
          <span class="value">${data.itemAuthor}</span>
        </div>` : ''}
        <div class="detail-row">
          <span class="label">Due Date:</span>
          <span class="value due-date">${this.formatDate(dueDate)}</span>
        </div>
        ${securityWarning}
      </div>
    `;
    }

    displayCheckInSuccess(data) {
        const container = document.getElementById('checkin-success-details');
        if (!container) return;

        container.innerHTML = `
      <div class="success-icon">✓</div>
      <h2>Check-In Successful!</h2>
      <div class="transaction-details">
        <div class="detail-row">
          <span class="label">Title:</span>
          <span class="value" style="font-weight: 600;">${data.itemTitle}</span>
        </div>
        ${data.itemAuthor ? `
        <div class="detail-row">
          <span class="label">Author:</span>
          <span class="value">${data.itemAuthor}</span>
        </div>` : ''}
        <div class="detail-row">
          <span class="label">Returned:</span>
          <span class="value">${this.formatDate(new Date(data.checkinDate))}</span>
        </div>
      </div>
    `;
    }

    displayAccountSummary(data) {
        const container = document.getElementById('account-results');
        if (!container) return;

        // Hide login screen, show dashboard
        const loginScreen = document.getElementById('account-login-screen');
        const dashboard = document.getElementById('account-dashboard');
        if (loginScreen) loginScreen.style.display = 'none';
        if (dashboard) dashboard.style.display = 'block';

        const patronName = String(data?.patronName || '').trim();
        const patronCardNumber = String(data?.patronCardNumber || '').trim();
        const fineAmount = Number(data?.fineAmount || 0) || 0;
        const loans = Array.isArray(data?.loans) ? data.loans : [];

        const fineClass = fineAmount > 0 ? 'account-fine has-fine' : 'account-fine';
        const holds = Array.isArray(data?.holds) ? data.holds : [];

        const fineColor = fineAmount > 0 ? '#ef4444' : '#10b981';
        const fineLabel = fineAmount > 0 ? `₹${fineAmount.toFixed(2)}` : '₹0.00 — No Fines';

        // Issued Books HTML
        const loansHtml = loans.length > 0
            ? loans.map((loan) => {
                const title = String(loan?.itemTitle || loan?.itemBarcode || 'Unknown title').trim();
                const barcode = String(loan?.itemBarcode || '').trim();
                const dueDate = loan?.dueDate ? this.formatDate(this.parseCalendarDate(loan.dueDate)) : 'Not available';
                return `
                    <div class="account-loan-card">
                        <div class="account-loan-title">${title}</div>
                        <div class="account-loan-meta">Barcode: ${barcode || 'N/A'}</div>
                        <div class="account-loan-meta">Due: ${dueDate}</div>
                    </div>
                `;
            }).join('')
            : '<div class="account-empty">No books are currently checked out on this account.</div>';

        container.innerHTML = `
            <div class="account-summary">
                <div class="account-summary-header">
                    <div>
                        <h2>${patronName || patronCardNumber}</h2>
                        <div class="account-card-number">Card Number: ${patronCardNumber}</div>
                    </div>
                    <div class="${fineClass}">Fine: Rs. ${fineAmount.toFixed(2)}</div>
                </div>
                <div class="account-section-title">Issued Books (${loans.length})</div>
                <div class="account-loans-grid">${loansHtml}</div>
                const dueDateRaw = loan?.dueDate;
                const dueDate = dueDateRaw ? this.parseCalendarDate(dueDateRaw) : null;
                const dueDateStr = dueDate && !isNaN(dueDate) ? this.formatDate(dueDate) : 'Not available';
                const isOverdue = dueDate && !isNaN(dueDate) && dueDate < new Date();
                const statusColor = isOverdue ? '#ef4444' : '#10b981';
                const statusText = isOverdue ? '⚠ Overdue' : '✓ Normal';
                return `
                    <div style="background: white; border-radius: 12px; padding: 1rem 1.25rem; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border-left: 4px solid ${statusColor};">
                        <div style="font-weight: 700; font-size: 1rem; color: #1e293b; margin-bottom: 0.3rem;">${title}</div>
                        <div style="font-size: 0.85rem; color: #64748b;">Barcode: ${barcode || 'N/A'}</div>
                        <div style="font-size: 0.85rem; color: #64748b;">Due: ${dueDateStr}</div>
                        <div style="font-size: 0.85rem; font-weight: 600; color: ${statusColor}; margin-top: 0.3rem;">${statusText}</div>
                    </div>
                `;
            }).join('')
            : '<div style="text-align: center; color: #94a3b8; padding: 1.5rem;">No books are currently checked out.</div>';

        // Holds HTML
        const holdsHtml = holds.length > 0
            ? holds.map((hold) => {
                const statusColors = {
                    'Ready for Pickup': '#10b981',
                    'In Transit': '#3b82f6',
                    'On Hold': '#f59e0b'
                };
                const color = statusColors[hold.status] || '#64748b';
                return `
                    <div style="background: white; border-radius: 12px; padding: 1rem 1.25rem; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border-left: 4px solid ${color};">
                        <div style="font-weight: 700; font-size: 1rem; color: #1e293b; margin-bottom: 0.3rem;">${hold.title}</div>
                        <div style="font-size: 0.85rem; color: #64748b;">Position in Queue: ${hold.queuePosition}</div>
                        <div style="font-size: 0.85rem; color: #64748b;">Expires: ${hold.pickupDeadline}</div>
                        <div style="font-size: 0.85rem; font-weight: 600; color: ${color}; margin-top: 0.3rem;">● ${hold.status}</div>
                    </div>
                `;
            }).join('')
            : '<div style="text-align: center; color: #94a3b8; padding: 1.5rem;">You have no active holds.</div>';

        container.innerHTML = `
            <!-- User Info Card -->
            <div style="background: linear-gradient(135deg, #3b82f6, #2563eb); border-radius: 16px; padding: 1.5rem 2rem; color: white; margin-bottom: 1.5rem; box-shadow: 0 8px 20px rgba(37,99,235,0.3);">
                <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 0.75rem;">
                    <div style="width: 52px; height: 52px; background: rgba(255,255,255,0.2); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.5rem;">👤</div>
                    <div>
                        <div style="font-size: 1.4rem; font-weight: 700;">${patronName || patronCardNumber}</div>
                        <div style="font-size: 0.9rem; opacity: 0.85;">Card: ${patronCardNumber}</div>
                    </div>
                </div>
                <div style="background: rgba(255,255,255,0.15); border-radius: 8px; padding: 0.6rem 1rem; display: inline-block;">
                    <span style="font-size: 0.85rem; opacity: 0.9;">Fine: </span>
                    <span style="font-weight: 700; color: ${fineAmount > 0 ? '#fca5a5' : '#86efac'};">${fineLabel}</span>
                </div>
            </div>

            <!-- Issued Books Section -->
            <div style="margin-bottom: 1.5rem;">
                <h3 style="font-size: 1.1rem; color: #1e293b; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem;">📚 Issued Books <span style="background: #e0f2fe; color: #0369a1; font-size: 0.8rem; padding: 0.15rem 0.6rem; border-radius: 10px; font-weight: 600;">${loans.length}</span></h3>
                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                    ${loansHtml}
                </div>
            </div>

            <!-- My Holds Section -->
            <div style="margin-bottom: 1rem;">
                <h3 style="font-size: 1.1rem; color: #1e293b; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem;">📌 My Holds <span style="background: #fef3c7; color: #92400e; font-size: 0.8rem; padding: 0.15rem 0.6rem; border-radius: 10px; font-weight: 600;">${holds.length}</span></h3>
                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                    ${holdsHtml}
                </div>
            </div>
        `;

        container.style.display = 'block';
    }

    showView(viewName) {
        // Hide all views
        document.querySelectorAll('.view').forEach(view => {
            view.classList.remove('active');
        });

        // Show requested view
        const view = document.getElementById(`view-${viewName}`);
        if (view) {
            view.classList.add('active');
            this.currentView = viewName;

            // Turn off LEDs when returning to home screen
            if (viewName === 'home') {
                this.currentOperation = null;
                this.scanningEnabled = false;
                this.recentRfidTags.clear();
                this.pendingCheckinBarcodes.clear();
                void this.disarmRfidBridge(true);
                this.triggerHardwareLED('OFF');
            }
        }

        // Clear any error messages
        this.clearError();
    }

    showLoading(formId, show) {
        const form = document.getElementById(`${formId}-form`);
        const submitBtn = form?.querySelector('button[type="submit"]');

        if (submitBtn) {
            submitBtn.disabled = show;
            submitBtn.innerHTML = show ? '<span class="spinner"></span> Processing...' : 'Submit';
        }
    }

    showError(message) {
        this.triggerHardwareLED('ERROR');
        const errorDiv = document.getElementById('error-message');
        if (errorDiv) {
            errorDiv.textContent = message;
            errorDiv.classList.add('show');

            // Auto-hide after 5 seconds
            setTimeout(() => this.clearError(), 5000);
        }
    }

    clearError() {
        const errorDiv = document.getElementById('error-message');
        if (errorDiv) {
            errorDiv.classList.remove('show');
        }
    }

    showComingSoon(feature) {
        this.showError(`${feature} feature coming soon in Phase 2!`);
    }

    parseCalendarDate(value) {
        if (value instanceof Date) {
            return value;
        }

        const text = String(value || '').trim();
        if (!text) {
            return new Date(NaN);
        }

        const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (match) {
            const [, year, month, day] = match;
            // Keep the Koha calendar date stable in the browser regardless of timezone offset.
            return new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0, 0);
        }

        return new Date(text);
    }

    formatDate(date) {
        return date.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }

    updateModeIndicator() {
        const indicator = document.getElementById('mode-indicator');
        if (indicator) {
            const mode = this.api.getMode();
            indicator.textContent = mode === 'demo' ? '🎭 Demo Mode' : '🌐 Live Mode';
            indicator.className = `mode-indicator ${mode}-mode`;
        }
    }

    toggleMode() {
        const currentMode = this.api.getMode();
        const newMode = currentMode === 'demo' ? 'koha' : 'demo';
        this.api.setMode(newMode);
        this.updateModeIndicator();
        this.showError(`Switched to ${newMode.toUpperCase()} mode`);
    }

    resetAutoLogout() {
        if (this.autoLogoutTimer) {
            clearTimeout(this.autoLogoutTimer);
        }

        if (CONFIG.ui.autoLogoutSeconds > 0) {
            this.autoLogoutTimer = setTimeout(() => {
                this.showView('home');
            }, CONFIG.ui.autoLogoutSeconds * 1000);
        }
    }

    /**
     * Send command to Node.js backend to control ESP hardware
     * @param {string} state - 'ON', 'OFF', 'SUCCESS', or 'ERROR'
     */
    async triggerHardwareLED(state) {
        try {
            await fetch('/api/hardware/led', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state })
            });
        } catch (e) {
            console.warn('Failed to trigger hardware LED:', e);
        }
    }

    // === HID Card Reader (Keyboard Wedge) for My Account ===
    // Listens at document level so it works even without input focus.
    // USB HID readers send keystrokes very fast (< 50ms apart) then Enter.
    _setupHidCardReader() {
        this._hidBuffer = '';
        this._hidLastKeyTime = 0;
        this._hidProcessing = false;

        document.addEventListener('keydown', (e) => {
            // Only capture when on the account login screen
            if (this.currentView !== 'account') return;
            const loginScreen = document.getElementById('account-login-screen');
            if (!loginScreen || loginScreen.style.display === 'none') return;
            if (this._hidProcessing) return;

            const now = Date.now();

            if (e.key === 'Enter') {
                e.preventDefault();
                const cardId = this._hidBuffer.trim();
                this._hidBuffer = '';
                if (cardId.length >= 2) {
                    this._handleHidCardRead(cardId);
                }
                return;
            }

            // Reset buffer if gap > 500ms (user is not using the reader)
            if (now - this._hidLastKeyTime > 500) {
                this._hidBuffer = '';
            }

            // Accept only printable single characters
            if (e.key.length === 1) {
                this._hidBuffer += e.key;
                this._hidLastKeyTime = now;
            }
        });
    }

    _focusHidInput() {
        // No longer needed — document-level listener handles everything
    }

    async _handleHidCardRead(cardId) {
        if (this._hidProcessing) return;
        this._hidProcessing = true;

        const statusEl = document.getElementById('account-reader-status');
        const errorEl = document.getElementById('account-reader-error');

        console.log('[HID] Card scanned:', cardId);

        // Show loading state
        if (statusEl) { statusEl.textContent = 'Reading card\u2026'; statusEl.style.animation = 'none'; }
        if (errorEl) errorEl.style.display = 'none';

        try {
            const result = await this.api.getAccount(cardId);
            if (typeof KioskSounds !== 'undefined') KioskSounds.success();
            this.displayAccountSummary(result.data || {});
        } catch (error) {
            console.warn('[HID] Card login failed:', error.message);
            if (typeof KioskSounds !== 'undefined') KioskSounds.error();

            // Show error for 2 seconds
            if (statusEl) statusEl.style.display = 'none';
            if (errorEl) { errorEl.textContent = '\u274c Invalid Card'; errorEl.style.display = 'block'; }

            setTimeout(() => {
                if (errorEl) errorEl.style.display = 'none';
                if (statusEl) {
                    statusEl.textContent = 'Waiting for card\u2026 Place card on reader';
                    statusEl.style.display = 'block';
                    statusEl.style.animation = 'pulse-text 2s ease-in-out infinite';
                }
            }, 2000);
        } finally {
            this._hidProcessing = false;
        }
    }

    // === Hold Modal ===
    openHoldModal(barcode, title) {
        const modal = document.getElementById('hold-modal');
        const titleEl = document.getElementById('hold-book-title');
        const patronInput = document.getElementById('hold-patron-input');
        if (titleEl) titleEl.textContent = title || barcode;
        if (patronInput) patronInput.value = '';
        if (modal) modal.style.display = 'block';
        this._holdBarcode = barcode;
        if (patronInput) patronInput.focus();
    }

    async confirmPlaceHold() {
        const barcode = this._holdBarcode;
        const patronInput = document.getElementById('hold-patron-input');
        const patronCard = patronInput?.value?.trim();

        if (!patronCard) {
            this.showError('Please enter your patron card number.');
            return;
        }

        const confirmBtn = document.getElementById('btn-confirm-hold');
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Placing...';
        }

        try {
            const result = await this.api.placeHold(patronCard, barcode);
            document.getElementById('hold-modal').style.display = 'none';
            this.showError(result.message || 'Hold placed successfully!');
            if (typeof KioskSounds !== 'undefined') KioskSounds.success();
        } catch (error) {
            this.showError(error.message || 'Failed to place hold.');
        } finally {
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.textContent = 'Place Hold';
            }
        }
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.kioskApp = new LibraryKiosk();
});
