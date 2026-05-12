$content = Get-Content -Path "d:\Dropbox\public\js\app.js" -Raw
$index = $content.IndexOf("    async triggerHardwareLED(state) {")
if ($index -ne -1) {
    $newContent = $content.Substring(0, $index) + @"
    /**
     * Send command to Node.js backend to control ESP hardware
     */
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
            if (this.currentView !== 'account' && this.currentView !== 'checkout-scan-patron') return;
            
            const loginScreen = document.getElementById('account-login-screen');
            if (this.currentView === 'account' && (!loginScreen || loginScreen.style.display === 'none')) return;
            if (this._hidProcessing) return;
            
            if (document.activeElement?.id === 'account-manual-card' || document.activeElement?.id === 'patron-card') return;

            const now = Date.now();

            if (e.key === 'Enter' || e.key === 'NumpadEnter' || e.key === 'Tab') {
                e.preventDefault();
                const cardId = this._hidBuffer.trim();
                this._hidBuffer = '';
                if (cardId.length > 0) {
                    if (this.currentView === 'account') {
                        this.submitPatronLogin(cardId);
                    } else if (this.currentView === 'checkout-scan-patron') {
                        this.submitCheckoutPatron(cardId);
                    }
                }
                return;
            }

            if (now - this._hidLastKeyTime > 500) {
                this._hidBuffer = '';
            }

            if (e.key.length === 1) {
                this._hidBuffer += e.key;
                this._hidLastKeyTime = now;
            }
        });
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

        if (statusEl) { statusEl.textContent = 'Reading card\u2026'; statusEl.style.animation = 'none'; }
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
                statusEl.textContent = 'Waiting for card\u2026';
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
"@
    Set-Content -Path "d:\Dropbox\public\js\app.js" -Value $newContent -Encoding UTF8
    Write-Host "Successfully fixed app.js"
} else {
    Write-Host "Could not find triggerHardwareLED"
}
