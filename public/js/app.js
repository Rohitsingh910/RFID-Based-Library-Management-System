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
        this.lastTransaction = null; // Receipt data captured after batch renew

        this.init();
    }

    async init() {
        // Initialize API
        this.api = new KohaAPI(CONFIG);

        // Setup UI event listeners
        this.setupEventListeners();
        this.syncViewportLayoutState();

        // Update mode indicator
        this.updateModeIndicator();
        // Hide splash screen after loading animation (5s)
        const splash = document.getElementById('splash-screen');
        if (splash) {
            setTimeout(() => {
                splash.style.opacity = '0';
                document.body.style.backgroundColor = ''; // Reverts inline hack to let index.css take over
                setTimeout(() => {
                    splash.style.visibility = 'hidden';
                }, 800);
            }, 5000);
        }

        // Show home view
        this.showView('home');

        // Start system health monitoring (offline screen triggering)
        this.startHealthCheck();

        console.log(`Library Kiosk initialized in ${this.api.getMode().toUpperCase()} mode`);
    }

    async startHealthCheck() {
        const check = async () => {
            if (this.isReconnecting) return;
            try {
                const response = await fetch('/api/status');
                if (!response.ok) throw new Error(`Backend unreachable (HTTP ${response.status})`);

                const status = await response.json();
                
                // Trigger offline if internet down OR koha offline OR hardware disconnected
                const isKohaOnline = status.online !== false;
                const isInternetOnline = status.internet !== false;
                const rfidRunning = !status.rfid?.enabled || status.rfid?.state === 'running';
                const rfidHardwareConnected = !status.rfid?.enabled || status.rfid?.connected === true;

                // Update UI indicators
                this.updateOfflineStatusUI('internet', isInternetOnline);
                this.updateOfflineStatusUI('koha', isKohaOnline);
                this.updateOfflineStatusUI('rfid', rfidRunning && rfidHardwareConnected);

                if (!isInternetOnline || !isKohaOnline || !rfidRunning || !rfidHardwareConnected) {
                    console.warn('[Kiosk] System error detected:', { isInternetOnline, isKohaOnline, rfidRunning, rfidHardwareConnected, state: status.rfid?.state });
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
                this.updateOfflineStatusUI('koha', false);
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
        const patronStatus = document.getElementById('patron-rfid-status');

        if (dot && text) {
            dot.className = `status-dot ${isOnline ? 'online' : 'offline'}`;
            text.className = `status-value ${isOnline ? 'online' : 'offline'}`;
            text.textContent = isOnline ? 'CONNECTED' : 'DISCONNECTED';
        }

        // Specifically update the new ATM Screen 1 indicator
        if (type === 'rfid' && patronStatus) {
            if (isOnline) {
                patronStatus.textContent = '● RFID Reader Ready';
                patronStatus.style.color = '#10b981';
            } else {
                patronStatus.textContent = '○ Hardware Connection Error';
                patronStatus.style.color = '#ef4444';
            }
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
        if (window.electronAPI?.closeApp) {
            try {
                await window.electronAPI.closeApp();
                return;
            } catch (_) {
            }
        }
        window.close();
    }

    delay(ms) {
        const waitMs = Number(ms) || 0;
        return new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    resetAutoLogout() {
        if (this.autoLogoutTimer) clearTimeout(this.autoLogoutTimer);
        const timeout = (CONFIG.ui?.autoLogoutSeconds || 60) * 1000;
        if (this.currentView && this.currentView !== 'home') {
            this.autoLogoutTimer = setTimeout(() => {
                if (this.currentView !== 'home') {
                    console.log(`[Kiosk] Session timed out after ${timeout/1000}s inactivity.`);
                    this.showView('home');
                }
            }, timeout);
        }
    }

    setupEventListeners() {
        const click = () => { if (typeof KioskSounds !== 'undefined') KioskSounds.click(); };

        // Global session timeout resets on user activity
        document.addEventListener('click', () => this.resetAutoLogout(), { capture: true });
        document.addEventListener('touchstart', () => this.resetAutoLogout(), { capture: true });
        document.addEventListener('keydown', () => this.resetAutoLogout(), { capture: true });
        window.addEventListener('resize', () => this.syncViewportLayoutState());

        // Main menu buttons — 4 modules: Checkout, Check-In, Renew, Account
        document.getElementById('btn-checkout')?.addEventListener('click', () => { click(); this.startCheckOut(); });
        document.getElementById('btn-checkin')?.addEventListener('click', () => { click(); this.startCheckIn(); });
        document.getElementById('btn-renew')?.addEventListener('click', () => { click(); this.startRenew(); });
        document.getElementById('btn-account')?.addEventListener('click', () => { click(); this.startAccount(); });

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
        document.getElementById('btn-final-done')?.addEventListener('click', () => { click(); this.showView('home'); });

        // Form submissions
        document.getElementById('checkout-form')?.addEventListener('submit', (e) => { e.preventDefault(); this.handleConfirmCheckout(); });
        document.getElementById('btn-confirm-checkout')?.addEventListener('click', (e) => { e.preventDefault(); this.handleConfirmCheckout(); });
        document.getElementById('checkin-form')?.addEventListener('submit', (e) => this.handleCheckInSubmit(e));
        document.getElementById('account-form')?.addEventListener('submit', (e) => this.handleAccountSubmit(e));

        // HID Card Reader for My Account (keyboard wedge)
        this._setupHidCardReader();

        // Manual card entry for My Account
        document.getElementById('btn-account-manual-login')?.addEventListener('click', () => {
            click();
            const input = document.getElementById('account-manual-card');
            this.submitPatronLogin(input?.value);
        });
        document.getElementById('account-manual-card')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === 'NumpadEnter' || e.key === 'Tab') {
                e.preventDefault();
                document.getElementById('btn-account-manual-login')?.click();
            }
        });
        document.getElementById('patron-card')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === 'NumpadEnter' || e.key === 'Tab') {
                e.preventDefault();
                document.getElementById('btn-patron-continue')?.click();
            }
        });
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
                    if (this.currentOperation === 'checkout') {
                        this.proceedToBookScan();
                    }
                }
            });
        }

        // Done button for check-in
        document.getElementById('btn-done-checkin')?.addEventListener('click', () => { click(); this.handleDoneCheckIn(); });
        document.getElementById('btn-final-done')?.addEventListener('click', () => { click(); this.showView('home'); });

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

        // ATM Check-Out two-screen flow buttons
        document.getElementById('btn-patron-continue')?.addEventListener('click', () => { click(); const input = document.getElementById('patron-card'); this.submitCheckoutPatron(input?.value); });
        document.getElementById('btn-checkout-go-account')?.addEventListener('click', () => { click(); this.handleGoToAccount(); });
        document.getElementById('btn-checkout-finished')?.addEventListener('click', () => { click(); this.handleCheckoutFinished(); });
        document.getElementById('btn-co-finish-overlay')?.addEventListener('click', () => { click(); this.hideCoFinishOverlay(); this.handleDoneCheckout(); });

        // Renew module sub-listeners
        document.getElementById('renew-items-back')?.addEventListener('click', () => { click(); this.startRenew(); });
        document.getElementById('renew-select-all')?.addEventListener('click', () => { click(); this._toggleSelectAllRenew(true); });
        document.getElementById('renew-clear-all')?.addEventListener('click', () => { click(); this._toggleSelectAllRenew(false); });
        document.getElementById('btn-renew-selected')?.addEventListener('click', () => { click(); this.handleRenewSelected(); });
        document.getElementById('btn-renew-account')?.addEventListener('click', () => { click(); this.handleRenewAccountBtn(); });
        document.getElementById('btn-renew-finished')?.addEventListener('click', () => { click(); this._showPostReceiptThankYou(); });
        document.getElementById('receipt-btn-back')?.addEventListener('click', () => {
            click();
            if (this.currentOperation === 'renew') this.showView('renew-results');
            else if (this.currentOperation === 'checkout') this.showView('checkout-scan-books');
            else if (this.currentOperation === 'checkin') this.showView('checkin');
            else this.showView('home');
        });

        document.getElementById('renew-nonrenewable-toggle')?.addEventListener('click', () => {
            click();
            const list = document.getElementById('renew-nonrenewable-list');
            const arrow = document.getElementById('renew-toggle-arrow');
            if (list) list.classList.toggle('collapsed');
            if (arrow) arrow.classList.toggle('collapsed');
        });
        document.querySelectorAll('.renew-receipt-choice').forEach((renewBtn) => {
            renewBtn.addEventListener('click', () => {
                click();
                this.handleReceiptChoice(renewBtn.getAttribute('data-receipt'));
            });
        });

        // Renew module manual entry
        document.getElementById('btn-renew-patron-continue')?.addEventListener('click', () => {
            click();
            const input = document.getElementById('renew-patron-card');
            const card = (input?.value || '').trim();
            if (card) {
                this.renewPatronCard = card;
                console.log('[Renew] Manual continue clicked:', card);
                void this._renewGoToConnecting(card);
            } else {
                this.showError('Please enter a card number.');
            }
        });
        document.getElementById('renew-patron-card')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === 'NumpadEnter') {
                e.preventDefault();
                document.getElementById('btn-renew-patron-continue')?.click();
            }
        });
    }

    startCheckOut() {
        this.currentOperation = 'checkout';
        this.scanningEnabled = false;     // Book scanning starts only after patron card confirmed (Screen 2)
        this.checkoutSessionBooks = [];
        this.checkoutProcessedBarcodes = new Set();
        this.checkoutSessionPatronCard = '';
        this.checkoutSessionPatronName = '';
        this.checkoutReturnAccount = false;
        this.recentRfidTags.clear();
        this.pendingCheckinBarcodes.clear();
        this.processedCheckinBarcodes.clear();
        if (window.rfidService) window.rfidService.resetSession();
        if (window.patronRfidService) window.patronRfidService.resetSession();

        // Clear patron card input on Screen 1
        const patronCardEl = document.getElementById('patron-card');
        if (patronCardEl) patronCardEl.value = '';

        this.showView('checkout-scan-patron');
        this.resetAutoLogout();
        if (window.patronRfidService) window.patronRfidService.beginCheckoutSession();
        setTimeout(() => document.getElementById('patron-card')?.focus(), 100);
        // RFID bridge is armed when patron card is confirmed (submitCheckoutPatron)
    }

    async submitCheckoutPatron(cardNumber) {
        if (this._hidProcessing) return;
        cardNumber = (cardNumber || '').replace(/[\s\r\n\t]/g, '').trim();
        if (!cardNumber) {
            this.showError('Please scan or enter your library card number.');
            setTimeout(() => document.getElementById('patron-card')?.focus(), 100);
            return;
        }

        this._hidProcessing = true;
        const statusEl = document.getElementById('patron-rfid-status');
        if (statusEl) {
            statusEl.textContent = 'Verifying patron...';
            statusEl.style.color = '#3b82f6';
        }

        try {
            const result = await this.api.getAccount(cardNumber);
            const name = result.data?.patronName || '';
            
            this.checkoutSessionPatronCard = cardNumber;
            this.checkoutSessionPatronName = name;
            this.checkoutSessionBooks = [];
            this.checkoutProcessedBarcodes = new Set();

            const patronDisplay = document.getElementById('co-patron-display');
            if (patronDisplay) patronDisplay.textContent = `Patron: ${name} (${cardNumber})`;

            const countEl = document.getElementById('co-items-count');
            if (countEl) countEl.textContent = '0';

            const bookList = document.getElementById('co-book-list');
            if (bookList) {
                bookList.innerHTML = `
                    <div class="co-scan-prompt" id="co-scan-prompt">
                        <div class="co-scan-rings">
                            <div class="co-ring co-ring-1"></div>
                            <div class="co-ring co-ring-2"></div>
                            <div class="co-ring co-ring-3"></div>
                            <span class="co-ring-icon">📡</span>
                        </div>
                        <p class="co-scan-prompt-text">Place books on the RFID reader</p>
                    </div>`;
            }

            this.scanningEnabled = true;
            if (window.rfidService) window.rfidService.resetSession();

            this.showView('checkout-scan-books');
            this.resetAutoLogout();

            void this.armRfidBridge('00');
            if (window.rfidService?.activateLiveScan) {
                window.rfidService.activateLiveScan({
                    graceMs: 5000,
                    bootstrapPolls: 8,
                    bootstrapIntervalMs: 175
                });
            }
        } catch (err) {
            console.error('[Kiosk] Patron validation failed:', err.message);
            this.showError(err.message || 'Invalid patron card.');
            if (statusEl) {
                statusEl.textContent = '❌ Invalid Card';
                statusEl.style.color = '#ef4444';
            }
            setTimeout(() => {
                const input = document.getElementById('patron-card');
                if (input) { input.value = ''; input.focus(); }
            }, 100);
        } finally {
            this._hidProcessing = false;
        }
    }

    handleCheckoutFinished() {
        if (!this.checkoutSessionBooks || this.checkoutSessionBooks.length === 0) {
            // No successful checkouts — log any errors and go home gracefully
            const errorCount = document.querySelectorAll('#co-book-list .co-book-error').length;
            if (errorCount > 0) {
                console.log(`[Kiosk] Finishing checkout with ${errorCount} error(s) and 0 successful issues.`);
            }
            void this.disarmRfidBridge(true);
            this.showView('home');
            return;
        }
        this.handleDoneCheckout();
    }

    async handleGoToAccount() {
        // Mark origin so the overlay button is shown on the account view
        this.checkoutReturnAccount = true;
        this.scanningEnabled = false;
        void this.disarmRfidBridge(true);

        // Preserve patron card before startAccount() resets service state
        const savedPatronCard = this.checkoutSessionPatronCard;

        // Show beautiful loading transition first
        this.showView('checkout-account-loading');
        await this.delay(1500);

        // Initialize account state
        this.startAccount();

        // Since we already have the patron card from checkout,
        // skip the "Scan your Library Card" login screen entirely
        if (savedPatronCard) {
            const loginScreen = document.getElementById('account-login-screen');
            if (loginScreen) loginScreen.style.display = 'none';

            // Go straight to account data fetch
            void this.submitPatronLogin(savedPatronCard);
        }
    }

    hideCoFinishOverlay() {
        const overlay = document.getElementById('btn-co-finish-overlay');
        if (overlay) overlay.style.display = 'none';
        this.checkoutReturnAccount = false;
    }

    // ─── Renew Module ────────────────────────────────────────────────────────────

    /** Step 1: Initialise state and show patron scan screen. */
    startRenew() {
        this.currentOperation = 'renew';
        this.scanningEnabled = false;  // No item scanning in renew flow
        this.renewPatronCard = '';
        this.renewItemsData = null;
        this.renewBatchResults = null;
        this.recentRfidTags.clear();

        if (window.rfidService) window.rfidService.resetSession();
        if (window.patronRfidService) window.patronRfidService.resetSession();

        this.showView('renew-scan');
        this.resetAutoLogout();
        void this.disarmRfidBridge(true);

        // Reset manual input
        const manualInput = document.getElementById('renew-patron-card');
        if (manualInput) {
            manualInput.value = '';
            setTimeout(() => manualInput.focus(), 100);
        }


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
        if (this.currentView !== 'renew-scan') return; // already advanced past scan

        const cleaned = String(cardValue || '').trim();
        if (!cleaned) return;

        this.renewPatronCard = cleaned;
        if (typeof KioskSounds !== 'undefined') KioskSounds.success();
        this.resetAutoLogout();
        void this._renewGoToConnecting(cleaned);
    }

    /** Step 2: Show connecting spinner, fetch items, enforce minimum display time. */
    async _renewGoToConnecting(patronCard) {
        console.log('[Renew] Entering connecting state for:', patronCard);
        this.showView('renew-connecting');
        const start = Date.now();

        let itemsData = null;
        let fetchError = null;
        try {
            itemsData = await this.api.getItemsForRenew(patronCard);
            console.log('[Renew] Items data response:', itemsData);
        } catch (err) {
            console.error('[Renew] Fetch items error:', err);
            fetchError = err;
        }

        const elapsed = Date.now() - start;
        const MIN_SPINNER_MS = 1500;
        if (elapsed < MIN_SPINNER_MS) await this.delay(MIN_SPINNER_MS - elapsed);

        if (fetchError || !itemsData?.success || !itemsData?.data) {
            const msg = fetchError?.message || itemsData?.message || 'Unable to load items. Please try again.';
            console.error('[Renew] Proceeding to error from connecting:', msg);
            this.showError(msg);
            this.showView('renew-scan');
            return;
        }

        this.renewItemsData = itemsData.data;
        try {
            this.showRenewItems(itemsData.data);
        } catch (err) {
            console.error('[Renew] Error in showRenewItems:', err);
            this.showError('Application error displaying items. Please try again.');
            this.showView('renew-scan');
        }
    }

    /** Step 3: Render the Items Out screen (two-section layout). */
    showRenewItems(data) {
        console.log('[Renew] Preparing items view:', data);
        if (!data || !Array.isArray(data.items)) {
            throw new Error('Invalid items data received');
        }
        const { patronName, patronCardNumber, items } = data;

        // Update patron chip in header bar
        const chip = document.getElementById('renew-patron-chip');
        if (chip) chip.textContent = `👤 ${patronName || patronCardNumber}`;

        // Classify: renewable = true|null (unknown → treat as renewable); notRenewable = false
        const renewableItems = items.filter((i) => i && i.renewable !== false);
        const notRenewableItems = items.filter((i) => i && i.renewable === false);

        // ── Section A: Renewable ──────────────────────────────────────────
        const renewableList = document.getElementById('renew-renewable-list');
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
        const nonRenewableList = document.getElementById('renew-nonrenewable-list');
        const nonRenewableSection = document.getElementById('renew-section-nonrenewable');
        const countBadge = document.getElementById('renew-nonrenewable-count');
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
        const title = item.itemTitle || item.itemBarcode || 'Unknown Item';
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
                transactionType: 'RENEW',
                timestamp: new Date().toISOString(),
                patronCardNumber: this.renewPatronCard,
                patronName: this.renewItemsData?.patronName || '',
                items: this.renewBatchResults.map((r) => ({
                    barcode: r.barcode,
                    title: r.itemTitle || r.barcode,
                    newDueDate: r.newDueDate || '',
                    status: r.ok ? 'renewed' : 'failed',
                    message: r.message || ''
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
            const isOk = r.ok === true;
            const icon = isOk ? '\u2705' : '\u274C';
            const cls = isOk ? 'success' : 'fail';
            const delayStyle = `animation-delay: ${i * 0.07}s;`;

            let statusText = '';
            if (isOk) {
                const formattedDue = r.newDueDate
                    ? this.formatDate(this.parseCalendarDate(r.newDueDate))
                    : 'See receipt';
                statusText = `Renewed \u2022 New due: ${formattedDue}`;
            } else {
                statusText = ErrorNormalizer.normalize(r.message || r).userMessage;
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
        const cardInput = document.getElementById('account-manual-card');
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
     * Receipt Options
     */
    async handleReceiptChoice(choice) {
        if (choice === 'none') {
            this.lastTransaction = null;
            this._showPostReceiptThankYou();
            return;
        }

        // Disable all buttons; mark selected one as loading
        const selectedBtn = document.querySelector(`.renew-receipt-choice[id$="${choice}"]`);
        document.querySelectorAll('.renew-receipt-choice').forEach((btn) => {
            btn.disabled = true;
            if (btn.id.endsWith(choice)) btn.classList.add('loading');
        });

        if (choice === 'print' || choice === 'both') {
            const r = await this._doPrintReceipt();
            document.querySelectorAll('.renew-receipt-choice').forEach((b) => b.classList.remove('loading'));
            
            const msg = choice === 'both' 
                ? (r.ok ? 'Receipt printed \u2713 | Email: not yet configured' : 'Print failed | Email: not yet configured')
                : r.message;
                
            this._showReceiptStatus(r.ok, msg);
            
            if (r.ok) {
                await this.delay(2500);
                this.lastTransaction = null;
                this._showPostReceiptThankYou();
            } else {
                // Failure: re-enable buttons so patron can choose another option
                document.querySelectorAll('.renew-receipt-choice').forEach((b) => { b.disabled = false; });
            }
            return;
        }

        if (choice === 'email') {
            document.querySelectorAll('.renew-receipt-choice').forEach((b) => b.classList.remove('loading'));
            this._showReceiptStatus(false, 'Email receipts require email setup in Koha. Contact library staff.');
            // Re-enable so patron can pick another option
            document.querySelectorAll('.renew-receipt-choice').forEach((b) => { b.disabled = false; });
        }
    }

    /**
     * After receipt choice, show the appropriate thank-you screen:
     *   - Check-in  → "Put books on shelf" success screen
     *   - Checkout  → "Thank you for visiting" screen
     *   - Renew     → Go home directly
     */
    /**
     * After receipt choice, show the appropriate thank-you screen:
     *   - Check-in  → "Thank you for visiting" screen (with shelf instruction)
     *   - Checkout  → "Thank you for visiting" screen (with book animation)
     *   - Renew     → "Thank you for visiting" screen (default)
     */
    _showPostReceiptThankYou() {
        if (this.currentOperation === 'checkin') {
            this.showCheckinSummary();
        } else if (this.currentOperation === 'checkout') {
            const count = this.checkoutSessionBooks?.length || 0;
            this.showThankYouSummary(count, 'checkout');
        } else if (this.currentOperation === 'renew') {
            const count = this.renewBatchResults?.length || 0;
            this.showThankYouSummary(count, 'renew');
        } else {
            // Unknown — go home
            this.showView('home');
        }
    }

    /** Resets receipt screen to initial state (re-enable buttons, hide confirm). */
    _resetReceiptScreen() {
        document.querySelectorAll('.renew-receipt-choice').forEach((btn) => {
            btn.disabled = false;
            btn.classList.remove('loading');
        });
        const confirmEl = document.getElementById('receipt-confirm');
        if (confirmEl) confirmEl.style.display = 'none';
    }

    _receiptWidth() {
        return 32;
    }

    _receiptPlainText(value) {
        return String(value ?? '')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/\n+/g, ' ')
            .replace(/[^\x20-\x7E]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    _centerReceiptText(value, width = this._receiptWidth()) {
        const text = this._receiptPlainText(value).slice(0, width);
        if (!text) return '';
        const leftPad = Math.max(0, Math.floor((width - text.length) / 2));
        return `${' '.repeat(leftPad)}${text}`;
    }

    _wrapReceiptText(value, width = this._receiptWidth(), indent = '') {
        const text = this._receiptPlainText(value);
        if (!text) return [];

        const words = text.split(' ');
        const lines = [];
        let current = indent;

        words.forEach((word) => {
            if (!word) return;

            if (!current.trim()) {
                if ((indent.length + word.length) <= width) {
                    current = `${indent}${word}`;
                    return;
                }

                let remaining = word;
                while (remaining.length > (width - indent.length)) {
                    lines.push(`${indent}${remaining.slice(0, width - indent.length)}`);
                    remaining = remaining.slice(width - indent.length);
                }
                current = remaining ? `${indent}${remaining}` : indent;
                return;
            }

            const nextValue = `${current} ${word}`;
            if (nextValue.length <= width) {
                current = nextValue;
                return;
            }

            lines.push(current);

            if ((indent.length + word.length) <= width) {
                current = `${indent}${word}`;
                return;
            }

            let remaining = word;
            while (remaining.length > (width - indent.length)) {
                lines.push(`${indent}${remaining.slice(0, width - indent.length)}`);
                remaining = remaining.slice(width - indent.length);
            }
            current = remaining ? `${indent}${remaining}` : indent;
        });

        if (current.trim()) {
            lines.push(current);
        }

        return lines;
    }

    _finalizeReceiptText(lines) {
        return `${lines.filter((line) => line !== null && line !== undefined).join('\n').trim()}\n\n\n\n\n`;
    }

    /**
     * Executes the actual print action.
     * Uses Electron's silentPrint IPC. Browser printing is intentionally disabled for kiosk flow.
     * @returns {{ ok: boolean, message: string }}
     */
    async _doPrintReceipt() {
        if (!this.lastTransaction) {
            return { ok: false, message: 'No transaction data available. Please try again.' };
        }

        const payload = {
            html: this._generateReceiptHTML(this.lastTransaction),
            text: this._generateReceiptText(this.lastTransaction)
        };

        try {
            if (window.electronAPI?.silentPrint) {
                const result = await window.electronAPI.silentPrint(payload);
                if (result?.success) {
                    return { ok: true, message: 'Receipt sent to printer \u2713' };
                }
                const reason = result?.error || 'Unknown print failure';
                if (/cancel/i.test(reason)) {
                    return { ok: false, message: 'Print was cancelled.' };
                }
                return { ok: false, message: `Printer error: ${reason}. Please try again or contact staff.` };
            }

            return { ok: false, message: 'Silent printing is available only in the desktop kiosk app.' };
        } catch (err) {
            return { ok: false, message: err.message || 'Print failed. Please contact staff.' };
        }
    }

    _showReceiptStatus(success, message) {
        const confirmEl = document.getElementById('receipt-confirm');
        const confirmIcon = confirmEl?.querySelector('.renew-receipt-confirm-icon');
        const confirmText = document.getElementById('receipt-confirm-text');

        if (confirmIcon) {
            confirmIcon.textContent = success ? '\u2713' : '\u2717';
            confirmIcon.style.background = success
                ? 'linear-gradient(135deg, #10b981, #059669)'
                : 'linear-gradient(135deg, #ef4444, #dc2626)';
        }
        if (confirmText) confirmText.textContent = message;
        if (confirmEl) confirmEl.style.display = 'flex';
    }

    _generateReceiptHTML(tx) {
        const now = new Date(tx.timestamp || Date.now());
        const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        const patronStr = (tx.patronName || '').trim();
        const collegeName = 'Punjabi University';

        let itemNo = 0;
        let booksHtml = '';

        (tx.items || []).forEach(item => {
            itemNo++;
            const statusText = item.status === 'renewed' ? 'Renewed' : (item.status === 'checkedout' ? 'Checked Out' : (item.status === 'checkedin' ? 'Checked In' : 'Failed'));
            
            let dateLabel = '';
            let dateValue = '';
            
            if (item.newDueDate || item.dueDate) {
                dateLabel = 'Due: ';
                dateValue = this.formatDate(this.parseCalendarDate(item.newDueDate || item.dueDate));
            } else if (item.returnDate) {
                dateLabel = 'Returned: ';
                dateValue = this.formatDate(this.parseCalendarDate(item.returnDate));
            }

            booksHtml += `
                <div style="margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 6px; font-size: 15px; line-height: 1.35; color: #000;">
                    <div>${itemNo}. ${item.title || item.barcode || 'Unknown'}</div>
                    <div>Barcode: ${item.barcode}</div>
                    <div>Status: ${statusText}</div>
                    ${dateValue ? `<div>${dateLabel}${dateValue}</div>` : ''}
                </div>
            `;
        });

        const patronLine = tx.patronCardNumber
            ? `<div style="text-align: left; font-size: 15px; line-height: 1.35; margin-bottom: 8px; color: #000;">Patron: ${patronStr || tx.patronCardNumber}<br>Card: ${tx.patronCardNumber}</div>`
            : `<div style="text-align: left; font-size: 15px; line-height: 1.35; margin-bottom: 8px; color: #000;">Patron: N/A</div>`;

        const actionTitle = tx.transactionType || 'TRANSACTION';

        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Library Receipt</title>
        <style>@page { margin: 0; size: auto; } body { margin: 0; padding: 0; background-color: #fff; }</style>
        </head><body>
            <div id="thermal-print-container" style="width: 100%; max-width: 100%; font-family: 'Courier New', Courier, monospace; text-align: center; color: #000; padding: 0; margin: 0; overflow: hidden; word-wrap: break-word; font-size: 15px; line-height: 1.35;">
                <div style="font-size: 20px; margin: 3px 0; color: #000;">${collegeName}</div>
                <div style="font-size: 16px; margin: 3px 0; color: #000;">Smart Library Kiosk</div>
                <div style="font-size: 14px; margin-bottom: 8px; color: #000;">==============================</div>
                <div style="font-size: 14px; margin-bottom: 8px; color: #000;">${dateStr} ${timeStr}</div>
                ${patronLine}
                <div style="text-align: left; margin-bottom: 6px; border-bottom: 1px dashed #000; padding-bottom: 4px; font-size: 16px; color: #000;">
                    ${actionTitle} (${(tx.items || []).length})
                </div>
                <div style="text-align: left; margin-top: 3px; color: #000;">
                    ${booksHtml}
                </div>
                <div style="margin-top: 10px; font-size: 14px; color: #000;">==============================</div>
                <div style="font-size: 15px; margin-top: 6px; color: #000;">Thank You</div>
                <div style="font-size: 13px; color: #000; margin-top: 3px;">Powered by JIVESNA TECH</div>
                <div style="height: 36px;"></div>
            </div>
        </body></html>`;
    }

    _generateReceiptText(tx) {
        const now = new Date(tx.timestamp || Date.now());
        const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
        const divider = '-'.repeat(this._receiptWidth());
        const lines = [
            this._centerReceiptText('Punjabi University'),
            this._centerReceiptText('Smart Library Kiosk'),
            divider,
            `Date: ${dateStr}`,
            `Time: ${timeStr}`,
            divider
        ];

        const patronDisplay = this._receiptPlainText(tx.patronName || tx.patronCardNumber || 'N/A');
        lines.push(...this._wrapReceiptText(`Patron: ${patronDisplay}`));
        if (tx.patronCardNumber) {
            lines.push(...this._wrapReceiptText(`Card: ${tx.patronCardNumber}`));
        }

        const actionTitle = tx.transactionType || 'TRANSACTION';
        lines.push(divider);
        lines.push(...this._wrapReceiptText(`${actionTitle} (${(tx.items || []).length})`));
        lines.push(divider);

        (tx.items || []).forEach((item, index) => {
            const statusText = item.status === 'renewed' ? 'Renewed' : (item.status === 'checkedout' ? 'Checked Out' : (item.status === 'checkedin' ? 'Checked In' : 'Failed'));
            
            let dateLabel = '';
            let dateValue = '';
            
            if (item.newDueDate || item.dueDate) {
                dateLabel = 'Due: ';
                dateValue = this.formatDate(this.parseCalendarDate(item.newDueDate || item.dueDate));
            } else if (item.returnDate) {
                dateLabel = 'Returned: ';
                dateValue = this.formatDate(this.parseCalendarDate(item.returnDate));
            }

            lines.push(...this._wrapReceiptText(`${index + 1}. ${item.title || item.barcode || 'Unknown'}`));
            lines.push(...this._wrapReceiptText(`Barcode: ${item.barcode || 'N/A'}`));
            lines.push(...this._wrapReceiptText(`Status: ${statusText}`));
            if (dateValue) {
                lines.push(...this._wrapReceiptText(`${dateLabel}${dateValue}`));
            }
            lines.push(divider);
        });

        lines.push(this._centerReceiptText('Thank You'));
        lines.push(this._centerReceiptText('Powered by JIVESNA TECH'));

        return this._finalizeReceiptText(lines);
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

        // Reset UI to login screen
        const loginScreen = document.getElementById('account-login-screen');
        const dashboard = document.getElementById('account-dashboard');
        const resultsContainer = document.getElementById('account-results');
        const statusEl = document.getElementById('account-reader-status');
        const errorEl = document.getElementById('account-reader-error');
        const hidInput = document.getElementById('account-hid-input');
        const manualInput = document.getElementById('account-manual-card');

        if (loginScreen) loginScreen.style.display = 'flex';
        if (dashboard) dashboard.style.display = 'none';
        if (resultsContainer) { resultsContainer.innerHTML = ''; resultsContainer.style.display = 'none'; }
        if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Waiting for card\u2026 Place card on reader'; }
        if (errorEl) errorEl.style.display = 'none';
        if (hidInput) { hidInput.value = ''; }
        if (manualInput) manualInput.value = '';

        this.showView('account');
        this.resetAutoLogout();

        // Arm reader for Account scanning (reads UID)
        void this.armRfidBridge('account');
        setTimeout(() => manualInput?.focus(), 100);
    }

    handleDoneCheckIn() {
        if (!this.checkinSessionCount || this.checkinSessionCount === 0) {
            void this.disarmRfidBridge(true);
            this.showView('home');
            return;
        }

        // Capture lastTransaction for check-in receipt
        this.lastTransaction = {
            transactionType: 'CHECKED IN',
            timestamp: new Date().toISOString(),
            patronCardNumber: '',
            patronName: '',
            items: this.checkinSessionBooks.map((b) => ({
                barcode: b.barcode,
                title: b.title || b.barcode,
                returnDate: b.returnDate || new Date().toISOString(),
                status: 'checkedin'
            }))
        };

        void this.disarmRfidBridge(true);
        this._showPostReceiptThankYou();
    }

    handleDoneCheckout() {
        if (!this.checkoutSessionBooks || this.checkoutSessionBooks.length === 0) {
            void this.disarmRfidBridge(true);
            this.showView('home');
            return;
        }

        // Capture lastTransaction for checkout
        this.lastTransaction = {
            transactionType: 'CHECKED OUT',
            timestamp: new Date().toISOString(),
            patronCardNumber: this.checkoutSessionPatronCard,
            patronName: this.checkoutSessionPatronName,
            items: this.checkoutSessionBooks.map((b) => ({
                barcode: b.barcode,
                title: b.title || b.barcode,
                dueDate: b.dueDate || '',
                status: 'checkedout'
            }))
        };

        void this.disarmRfidBridge(true);
        this._showPostReceiptThankYou();
    }

    async handlePrintReceipt(willPrint) {
        if (willPrint) {
            let printed = true;
            if (this.printType === 'checkout') {
                printed = await this.executeSysPrint('checkout', {
                    patronCard: this.checkoutSessionPatronCard,
                    patronName: this.checkoutSessionPatronName,
                    books: this.checkoutSessionBooks
                });
            } else if (this.printType === 'checkin') {
                printed = await this.executeSysPrint('checkin', {
                    books: this.checkinSessionBooks
                });
            }
            if (!printed) return;
        }

        if (this.printType === 'checkout') {
            const count = this.checkoutSessionBooks?.length || 0;
            this.showThankYouSummary(count, 'checkout');
        } else {
            this.showCheckinSummary();
        }
    }

    showCheckinSummary() {
        this.showView('checkin-success');
        this.resetAutoLogout();
        
        // Automated return home after 5 seconds
        if (this.checkinTimeout) clearTimeout(this.checkinTimeout);
        this.checkinTimeout = setTimeout(() => {
            if (this.currentView === 'checkin-success') {
                this.showView('home');
            }
        }, 5000);
    }

    async executeSysPrint(type, data) {
        const collegeName = 'Punjabi University';
        const dateStr = new Date().toLocaleString();
        let itemNo = 0;
        let booksHtml = '';

        data.books.forEach(book => {
            itemNo++;
            booksHtml += `
                <div style="margin-bottom: 8px; border-bottom: 1px dashed #000; padding-bottom: 6px; font-size: 15px; line-height: 1.35; color: #000;">
                    <div>${itemNo}. ${book.title || 'Unknown'}</div>
                    <div>Barcode: ${book.barcode}</div>
                    ${book.patronNo ? `<div>Patron: ${book.patronNo}</div>` : ''}
                    ${type === 'checkout' ? (book.dueDate ? `<div>Due: ${book.dueDate}</div>` : '') : ''}
                    ${type === 'checkin' ? (book.returnDate ? `<div>Returned: ${book.returnDate}</div>` : '') : ''}
                </div>
            `;
        });

        const patronLine = data.patronCard
            ? `<div style="text-align: left; font-size: 15px; line-height: 1.35; margin-bottom: 8px; color: #000;">Patron: ${data.patronName || data.patronCard}<br>Card: ${data.patronCard}</div>`
            : `<div style="text-align: left; font-size: 15px; line-height: 1.35; margin-bottom: 8px; color: #000;">Patron: N/A</div>`;

        const actionTitle = type === 'checkout' ? 'CHECKED OUT' : 'CHECKED IN';
        const receiptText = this._generateSystemReceiptText(type, data, dateStr);

        const receiptContent = `
            <div id="thermal-print-container" style="width: 100%; max-width: 100%; font-family: 'Courier New', Courier, monospace; text-align: center; color: #000; padding: 0; margin: 0; overflow: hidden; word-wrap: break-word; font-size: 15px; line-height: 1.35;">
                <div style="font-size: 20px; margin: 3px 0; color: #000;">${collegeName}</div>
                <div style="font-size: 16px; margin: 3px 0; color: #000;">Smart Library Kiosk</div>
                <div style="font-size: 14px; margin-bottom: 8px; color: #000;">==============================</div>
                <div style="font-size: 14px; margin-bottom: 8px; color: #000;">${dateStr}</div>
                ${patronLine}
                <div style="text-align: left; margin-bottom: 6px; border-bottom: 1px dashed #000; padding-bottom: 4px; font-size: 16px; color: #000;">
                    ${actionTitle} (${data.books.length})
                </div>
                <div style="text-align: left; margin-top: 3px; color: #000;">
                    ${booksHtml}
                </div>
                <div style="margin-top: 10px; font-size: 14px; color: #000;">==============================</div>
                <div style="margin-top: 6px; font-size: 15px; text-align: center; color: #000;">Thank you for visiting!</div>
                <div style="margin-top: 3px; font-size: 13px; text-align: center; color: #000;">Powered by SoCTeamup</div>
                <div style="height: 36px;"></div>
            </div>
        `;

        if (window.electronAPI && window.electronAPI.silentPrint) {
            const result = await window.electronAPI.silentPrint({
                html: receiptContent,
                text: receiptText
            });
            if (!result?.success) {
                const reason = result?.error || 'Unknown print failure';
                console.error('[Kiosk] Printing failed:', reason);
                this.showError(`Print error: ${reason}`);
                return false;
            }
            return true;
        } else {
            console.warn('[Kiosk] Electron API not found; silent printing is unavailable in browser mode.');
            this.showError('Silent printing is available only in the desktop kiosk app.');
            return false;
        }
    }

    _generateSystemReceiptText(type, data, dateText) {
        const divider = '-'.repeat(this._receiptWidth());
        const actionTitle = type === 'checkout' ? 'CHECKED OUT' : 'CHECKED IN';
        const lines = [
            this._centerReceiptText('Punjabi University'),
            this._centerReceiptText('Smart Library Kiosk'),
            divider,
            ...this._wrapReceiptText(`Date: ${dateText || new Date().toLocaleString()}`),
            divider
        ];

        const patronValue = data.patronName || data.patronCard || 'N/A';
        lines.push(...this._wrapReceiptText(`Patron: ${patronValue}`));
        if (data.patronCard) {
            lines.push(...this._wrapReceiptText(`Card: ${data.patronCard}`));
        }

        lines.push(divider);
        lines.push(...this._wrapReceiptText(`${actionTitle} (${data.books.length})`));
        lines.push(divider);

        (data.books || []).forEach((book, index) => {
            lines.push(...this._wrapReceiptText(`${index + 1}. ${book.title || 'Unknown'}`));
            lines.push(...this._wrapReceiptText(`Barcode: ${book.barcode || 'N/A'}`));
            if (book.patronNo) {
                lines.push(...this._wrapReceiptText(`Patron: ${book.patronNo}`));
            }
            if (type === 'checkout' && book.dueDate) {
                lines.push(...this._wrapReceiptText(`Due: ${book.dueDate}`));
            }
            if (type === 'checkin' && book.returnDate) {
                lines.push(...this._wrapReceiptText(`Returned: ${book.returnDate}`));
            }
            lines.push(divider);
        });

        lines.push(this._centerReceiptText('Thank you for visiting!'));
        lines.push(this._centerReceiptText('Powered by SoCTeamup'));

        return this._finalizeReceiptText(lines);
    }

    showThankYouSummary(count, type) {
        const typeArg = type || this.currentOperation || 'checkin';
        const countSpan = document.getElementById('session-count');
        if (countSpan) countSpan.textContent = count;

        const actionText = document.getElementById('thankyou-action-text');
        if (actionText) {
            if (typeArg === 'checkout') actionText.textContent = 'checked out';
            else if (typeArg === 'renew') actionText.textContent = 'renewed';
            else actionText.textContent = 'checked in';
        }

        const animCheckout = document.getElementById('thankyou-anim-checkout');
        const animCheckin = document.getElementById('thankyou-anim-checkin');

        if (typeArg === 'checkout') {
            if (animCheckout) animCheckout.style.display = 'block';
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

        if (this.thankyouTimeout) clearTimeout(this.thankyouTimeout);
        this.thankyouTimeout = setTimeout(() => {
            if (this.currentView === 'thankyou') {
                this.showView('home');
            }
        }, 5000);
    }

    showCheckinSummary() {
        this.showView('checkin-success');
        this.resetAutoLogout();
        
        // Automated return home after 5 seconds
        if (this.checkinTimeout) clearTimeout(this.checkinTimeout);
        this.checkinTimeout = setTimeout(() => {
            if (this.currentView === 'checkin-success') {
                this.showView('home');
            }
        }, 5000);
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

        // Keep the bridge disarmed during check-in scanning so tags are read immediately.
        // The backend still writes AFI/security after a successful check-in.
        try {
            await this.disarmRfidBridge(true);
        } catch (error) {
            console.warn('[RFID] Disarm before live scan failed:', error?.message || error);
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


    async processCheckoutTag({ barcode, uid }) {
        if (this.currentOperation !== 'checkout') return;
        if (!barcode) return;

        // Dedup — prevent the same barcode being processed twice in one session
        if (!this.checkoutProcessedBarcodes) this.checkoutProcessedBarcodes = new Set();
        if (this.checkoutProcessedBarcodes.has(barcode)) return;

        // Patron must be confirmed before book scanning is meaningful
        const patronCard = this.checkoutSessionPatronCard;
        if (!patronCard) return;

        this.checkoutProcessedBarcodes.add(barcode);

        // Ensure Screen 2 book list container exists
        const bookList = document.getElementById('co-book-list');
        if (!bookList) return;

        // Remove the scanning prompt on first book detection
        const prompt = document.getElementById('co-scan-prompt');
        if (prompt) prompt.remove();

        // Add a "processing" row immediately so patron sees feedback
        const row = document.createElement('div');
        row.className = 'co-book-row co-book-processing';
        row.innerHTML = `
            <div class="co-book-icon-cell"><div class="co-row-spinner"></div></div>
            <div class="co-book-info">
                <div class="co-book-title">${barcode}</div>
                <div class="co-book-status">Processing…</div>
            </div>
            <div class="co-book-due">—</div>
        `;
        bookList.appendChild(row);

        // Update live count
        const countEl = document.getElementById('co-items-count');
        if (countEl) countEl.textContent = bookList.querySelectorAll('.co-book-row').length;

        // Call checkout API (identical arguments to the original handleConfirmCheckout)
        try {
            const result = await this.api.checkOut(patronCard, barcode, {
                rfidUid: uid,
                skipSecurityWrite: false
            });

            const title = result.data?.itemTitle || barcode;
            const dueDate = this.formatDate(this.parseCalendarDate(result.data?.dueDate));

            row.className = 'co-book-row co-book-success';
            row.innerHTML = `
                <div class="co-book-icon-cell">✅</div>
                <div class="co-book-info">
                    <div class="co-book-title">${title}</div>
                    <div class="co-book-status">Checked out successfully</div>
                </div>
                <div class="co-book-due">${dueDate}</div>
            `;

            if (!this.checkoutSessionBooks) this.checkoutSessionBooks = [];
            this.checkoutSessionBooks.push({ title, barcode, dueDate });
            this.checkoutSessionPatronName = result.data?.patronName || patronCard;

            if (typeof KioskSounds !== 'undefined') KioskSounds.success();
            void this.armRfidBridge('00');   // Re-arm for next tag

        } catch (error) {
            row.className = 'co-book-row co-book-error';
            row.innerHTML = `
                <div class="co-book-icon-cell">❌</div>
                <div class="co-book-info">
                    <div class="co-book-title">${barcode}</div>
                    <div class="co-book-status">${ErrorNormalizer.normalize(error).userMessage}</div>
                </div>
                <div class="co-book-due">—</div>
            `;
            if (typeof KioskSounds !== 'undefined') KioskSounds.error();
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

        const patronCardNumber = document.getElementById('account-manual-card')?.value.trim() || '';
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
                    <div class="card-status">${ErrorNormalizer.normalize(error).userMessage}</div>
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
                    const normalizedError = ErrorNormalizer.normalize(error);
                    if (normalizedError.code === 'ITEM_NOT_FOUND') {
                        break;
                    }
                    if (attempt < maxAttempts) {
                        await this.delay(retryDelayMs);
                    }
                }
            }
            // Ensure we don't re-process this barcode in the same session even if it failed
            this.processedCheckinBarcodes.add(barcode);
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
        this.resetAutoLogout();
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
        if (dashboard) dashboard.style.display = 'flex';
        if (window.patronRfidService?.pauseScanning) {
            void window.patronRfidService.pauseScanning('Account loaded. Reader paused.');
        }

        const patronName = String(data?.patronName || '').trim();
        const patronCardNumber = String(data?.patronCardNumber || '').trim();
        const fineAmount = Number(data?.fineAmount || 0) || 0;
        const loans = Array.isArray(data?.loans) ? data.loans : [];
        const holds = Array.isArray(data?.holds) ? data.holds : [];

        const fineLabel = fineAmount > 0 ? `\u20b9${fineAmount.toFixed(2)}` : '\u20b90.00 \u2014 No Fines';

        // Issued Books HTML
        const loansHtml = loans.length > 0
            ? loans.map((loan) => {
                const title = String(loan?.itemTitle || loan?.itemBarcode || 'Unknown title').trim();
                const barcode = String(loan?.itemBarcode || '').trim();
                const dueDateRaw = loan?.dueDate;
                const dueDate = dueDateRaw ? this.parseCalendarDate(dueDateRaw) : null;
                const dueDateStr = dueDate && !isNaN(dueDate) ? this.formatDate(dueDate) : 'Not available';
                const isOverdue = dueDate && !isNaN(dueDate) && dueDate < new Date();
                const statusColor = isOverdue ? '#ef4444' : '#10b981';
                const statusText = isOverdue ? '\u26a0 Overdue' : '\u2713 Normal';
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
                        <div style="font-size: 0.85rem; font-weight: 600; color: ${color}; margin-top: 0.3rem;">\u25cf ${hold.status}</div>
                    </div>
                `;
            }).join('')
            : '<div style="text-align: center; color: #94a3b8; padding: 1.5rem;">You have no active holds.</div>';

        container.innerHTML = `
            <!-- User Info Card -->
            <div style="background: linear-gradient(135deg, #3b82f6, #2563eb); border-radius: 16px; padding: 1.5rem 2rem; color: white; margin-bottom: 1.5rem; box-shadow: 0 8px 20px rgba(37,99,235,0.3);">
                <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 0.75rem;">
                    <div style="width: 52px; height: 52px; background: rgba(255,255,255,0.2); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.5rem;">\ud83d\udc64</div>
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
                <h3 style="font-size: 1.1rem; color: #1e293b; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem;">\ud83d\udcda Issued Books <span style="background: #e0f2fe; color: #0369a1; font-size: 0.8rem; padding: 0.15rem 0.6rem; border-radius: 10px; font-weight: 600;">${loans.length}</span></h3>
                <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                    ${loansHtml}
                </div>
            </div>

            <!-- My Holds Section -->
            <div style="margin-bottom: 1rem;">
                <h3 style="font-size: 1.1rem; color: #1e293b; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem;">\ud83d\udccd My Holds <span style="background: #fef3c7; color: #92400e; font-size: 0.8rem; padding: 0.15rem 0.6rem; border-radius: 10px; font-weight: 600;">${holds.length}</span></h3>
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
                this.checkoutReturnAccount = false;
            }

            // Show or hide the floating "Finish Checkout" overlay button
            const coOverlay = document.getElementById('btn-co-finish-overlay');
            if (coOverlay) {
                if (viewName === 'account' && this.checkoutReturnAccount) {
                    coOverlay.style.display = '';
                    coOverlay.style.animation = 'coOverlaySlideIn 0.4s cubic-bezier(0.4,0,0.2,1)';
                } else if (viewName !== 'account') {
                    coOverlay.style.display = 'none';
                }
            }
        }

        document.body.dataset.currentView = viewName;
        document.body.classList.toggle('home-view-active', viewName === 'home');
        this.syncViewportLayoutState();

        // Clear any error messages
        this.clearError();

        // Start/Reset the auto-logout timer for the new view
        this.resetAutoLogout();
    }

    syncViewportLayoutState() {
        const compactHome = window.innerHeight <= 730;
        document.body.classList.toggle('compact-home-layout', compactHome);
    }

    showLoading(formId, show) {
        const form = document.getElementById(`${formId}-form`);
        const submitBtn = form?.querySelector('button[type="submit"]');

        if (submitBtn) {
            submitBtn.disabled = show;
            submitBtn.innerHTML = show ? '<span class="spinner"></span> Processing...' : 'Submit';
        }
    }

    showError(error) {
        const normalized = ErrorNormalizer.normalize(error);

        // Suppress background transaction/connection errors if we've already returned Home
        if (this.currentView === 'home' && !this.currentOperation) {
            if (['TRANSACTION_FAILED', 'CONNECTION_FAILURE', 'HARDWARE_ERROR'].includes(normalized.code)) {
                console.warn('[Kiosk] Suppressing background error on Home screen:', normalized);
                return;
            }
        }
        this.triggerHardwareLED('ERROR');
        const errorDiv = document.getElementById('error-message');
        if (errorDiv) {
            errorDiv.textContent = normalized.userMessage;
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



    async triggerHardwareLED(state) {
        try {
            const response = await fetch('/api/hardware/led', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ state })
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
        } catch (e) {
            console.warn('Failed to trigger hardware LED:', e);
        }
    }

    // === HID Card Reader (Keyboard Wedge) Fallback ===
    // Listens at document level to capture input even without focus.
    _setupHidCardReader() {
        this._hidBuffer = '';
        this._hidLastKeyTime = 0;
        this._hidProcessing = false;

        document.addEventListener('keydown', (e) => {
            if (this.currentView !== 'account' && this.currentView !== 'checkout-scan-patron' && this.currentView !== 'renew-scan') return;
            
            const loginScreen = document.getElementById('account-login-screen');
            if (this.currentView === 'account' && (!loginScreen || loginScreen.style.display === 'none')) return;
            if (this._hidProcessing) return;
            
            // If focused on manual input, let the browser handle it entirely.
            if (document.activeElement?.tagName === 'INPUT') {
                this._hidBuffer = ''; 
                return;
            }

            const now = Date.now();
            const delta = now - this._hidLastKeyTime;

            if (e.key === 'Enter' || e.key === 'NumpadEnter' || e.key === 'Tab') {
                e.preventDefault();
                const cardId = this._hidBuffer.trim();
                this._hidBuffer = '';
                
                if (cardId.length > 0) {
                    if (this.currentView === 'account') {
                        this.submitPatronLogin(cardId);
                    } else if (this.currentView === 'checkout-scan-patron') {
                        this.submitCheckoutPatron(cardId);
                    } else if (this.currentView === 'renew-scan') {
                        this.handleRenewPatronScan(cardId);
                    }
                }
                return;
            }

            if (delta > 500) {
                this._hidBuffer = '';
            }

            if (e.key.length === 1) {
                this._hidBuffer += e.key;
                this._hidLastKeyTime = now;
            }
        });
    }

    /** Handler for Patron RFID Reader service (js/patron-rfid-service.js) */
    _handleHidCardRead(cardNumber) {
        console.log('[Reader Service] Patron card captured:', cardNumber);
        this.submitPatronLogin(cardNumber);
    }

    async submitPatronLogin(cardNumber) {
        if (this._hidProcessing) return;
        cardNumber = (cardNumber || '').replace(/[\s\r\n\t]/g, '').trim();
        if (!cardNumber) {
            this.showError('Please enter a valid card number.');
            setTimeout(() => document.getElementById('account-manual-card')?.focus(), 100);
            return;
        }

        this._hidProcessing = true;
        const statusEl = document.getElementById('account-reader-status');
        const errorEl = document.getElementById('account-reader-error');

        console.log('[HID] Card scanned:', cardNumber);

        if (statusEl) { statusEl.textContent = 'Reading card…'; statusEl.style.animation = 'none'; }
        if (errorEl) errorEl.style.display = 'none';

        try {
            const result = await this.api.getAccount(cardNumber);
            if (typeof KioskSounds !== 'undefined') KioskSounds.success();
            this.displayAccountSummary(result.data || {});
        } catch (err) {
            console.error('Account lookup error:', err);
            if (typeof KioskSounds !== 'undefined') KioskSounds.error();
            if (errorEl) {
                errorEl.textContent = '❌ ' + (err.message || 'Invalid Card');
                errorEl.style.display = 'block';
            }
            if (statusEl) {
                statusEl.textContent = 'Waiting for card…';
            }
            setTimeout(() => {
                const input = document.getElementById('account-manual-card');
                if (input) { input.value = ''; input.focus(); }
            }, 100);
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
