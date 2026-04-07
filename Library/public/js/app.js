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
        await this.startHealthCheck();

        // Wait for required duration
        const elapsed = Date.now() - splashStartTime;
        if (elapsed < MIN_SPLASH_MS) {
            await this.delay(MIN_SPLASH_MS - elapsed);
        }

        // Hide splash screen
        const splash = document.getElementById('splash-screen');
        if (splash) {
            splash.style.opacity = '0';
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
        document.getElementById('checkout-form')?.addEventListener('submit', (e) => this.handleCheckOutSubmit(e));
        document.getElementById('checkin-form')?.addEventListener('submit', (e) => this.handleCheckInSubmit(e));
        document.getElementById('account-form')?.addEventListener('submit', (e) => this.handleAccountSubmit(e));

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
    }

    startCheckOut() {
        this.currentOperation = 'checkout';
        this.scanningEnabled = false;
        this.recentRfidTags.clear();
        this.pendingCheckinBarcodes.clear();
        this.processedCheckinBarcodes.clear();
        if (window.rfidService) window.rfidService.resetSession();
        if (window.patronRfidService) window.patronRfidService.resetSession();
        document.getElementById('checkout-form')?.reset();
        this.showView('checkout');
        this.resetAutoLogout();
        if (window.patronRfidService) window.patronRfidService.beginCheckoutSession();
        document.getElementById('patron-card')?.focus();
        
        // Immediately arm for check-out (AFI=0x00) so a book placed early gets the AFI pre-written
        void this.armRfidBridge('00');
    }

    startCheckIn() {
        this.currentOperation = 'checkin';
        this.checkinSessionCount = 0;
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

    startSearch() {
        this.currentOperation = 'search';
        const iframe = document.getElementById('search-iframe');
        if (iframe && !iframe.src) {
            // Load the OPAC URL from config
            iframe.src = CONFIG.opacUrl || 'http://164.52.208.94:800';
        }
        this.showView('search');
        this.resetAutoLogout();
        void this.disarmRfidBridge(true);
    }

    handleDoneCheckIn() {
        // Update Thank You view with stats
        const countSpan = document.getElementById('session-count');
        if (countSpan) countSpan.textContent = this.checkinSessionCount;

        // Add a random quote
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

        // Disarm bridge — done scanning
        void this.disarmRfidBridge(true);

        // Show thank you message
        this.showView('thankyou');
        if (typeof KioskSounds !== 'undefined') KioskSounds.celebration();

        // Auto-return to home after 2 seconds
        setTimeout(() => {
            this.showView('home');
        }, 2000);
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

    async handleCheckOutSubmit(e) {
        e.preventDefault();

        const patronCard = document.getElementById('patron-card').value.trim();
        const itemBarcode = document.getElementById('item-barcode').value.trim();
        const rfidUid = this.consumeRfidUid(itemBarcode);

        if (!patronCard || !itemBarcode) {
            this.showError('Please enter both patron card number and item barcode.');
            return;
        }

        await this.submitCheckoutTransaction({ patronCard, itemBarcode, rfidUid });
    }

    async submitCheckoutTransaction({ patronCard, itemBarcode, rfidUid = '' }) {
        this.showLoading('checkout', true);

        try {
            // Flow: transaction approved in DB first, THEN server writes AFI = 0x00 (unsecured).
            // skipSecurityWrite is false so the server always writes AFI after checkout.
            const result = await this.api.checkOut(patronCard, itemBarcode, {
                rfidUid,
                skipSecurityWrite: false
            });

            // Show success
            this.displayCheckOutSuccess(result.data);
            this.showView('checkout-success');

            // Clear form
            document.getElementById('checkout-form').reset();

            // Disarm bridge — done with this checkout transaction
            void this.disarmRfidBridge(true);
        } catch (error) {
            this.showError(error.message);
            throw error;
        } finally {
            this.showLoading('checkout', false);
        }
    }

    async processCheckoutTag({ barcode, uid }) {
        if (this.currentOperation !== 'checkout') return;

        const patronCard = document.getElementById('patron-card')?.value.trim() || '';
        if (!patronCard || !barcode) return;

        const itemBarcodeEl = document.getElementById('item-barcode');
        if (itemBarcodeEl) {
            itemBarcodeEl.value = barcode;
            itemBarcodeEl.dispatchEvent(new Event('input', { bubbles: true }));
            itemBarcodeEl.dispatchEvent(new Event('change', { bubbles: true }));
        }

        await this.submitCheckoutTransaction({
            patronCard,
            itemBarcode: barcode,
            rfidUid: String(uid || '').trim().toUpperCase()
        });
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
            const patronName = (result.data && result.data.patronName) ? result.data.patronName : 'N/A';
            const fineAmount = Number(result.data?.fineAmount);
            const safeFineAmount = Number.isFinite(fineAmount) ? fineAmount : 0;
            const securityUpdate = result.data?.securityUpdate || result.securityUpdate || null;
            const patronHtml = `<div style="font-size: 0.9rem; margin-top: 4px; color: var(--text-muted);">Patron: ${patronName}</div>`;
            const fineHtml = `<div style="font-size: 0.9rem; color: #ef4444; font-weight: 600;">Fine: Rs. ${safeFineAmount.toFixed(2)}</div>`;
            const securityHtml = securityUpdate && securityUpdate.success !== true
                ? `<div style="font-size: 0.9rem; color: #b45309; font-weight: 600;">Security write failed: ${securityUpdate.message || 'tag state not updated'}</div>`
                : '';

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

        const patronName = String(data?.patronName || '').trim();
        const patronCardNumber = String(data?.patronCardNumber || '').trim();
        const fineAmount = Number(data?.fineAmount || 0) || 0;
        const loans = Array.isArray(data?.loans) ? data.loans : [];

        const fineClass = fineAmount > 0 ? 'account-fine has-fine' : 'account-fine';
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
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.kioskApp = new LibraryKiosk();
});
