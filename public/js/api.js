/**
 * API Layer for Koha ILS Integration
 * Supports both Demo mode (mock data) and real Koha API
 */

class KohaAPI {
    constructor(config) {
        this.config = config;
        this.mode = config.mode;

        // Mock database for demo mode
        this.mockDB = {
            items: [
                { barcode: '123456789', title: 'Introduction to Programming', author: 'John Smith', status: 'available' },
                { barcode: '987654321', title: 'Advanced Algorithms', author: 'Jane Doe', status: 'available' },
                { barcode: '111222333', title: 'Database Design', author: 'Bob Johnson', status: 'available' },
                { barcode: '444555666', title: 'Web Development', author: 'Alice Williams', status: 'checked_out' }
            ],
            patrons: [
                { cardNumber: '11111', name: 'Alex Student', email: 'alex@example.com', fineAmount: 0 },
                { cardNumber: '22222', name: 'Maria Garcia', email: 'maria@example.com', fineAmount: 125.50 },
                { cardNumber: '33333', name: 'John Teacher', email: 'john@example.com', fineAmount: 20 }
            ],
            checkouts: []
        };
    }

    /**
     * Simulate network delay for demo mode
     */
    async _simulateDelay() {
        if (this.mode === 'demo' && this.config.demo.simulateNetworkDelay) {
            await new Promise(resolve => setTimeout(resolve, this.config.demo.delayMs));
        }
    }

    /**
     * Check out an item to a patron
     * @param {string} patronCardNumber - Patron's card number
     * @param {string} itemBarcode - Item's barcode
     * @returns {Promise<Object>} Checkout result
     */
    async checkOut(patronCardNumber, itemBarcode, options = {}) {
        if (this.mode === 'demo') {
            return this._mockCheckOut(patronCardNumber, itemBarcode);
        } else if (this.mode === 'backend') {
            return this._backendCheckOut(patronCardNumber, itemBarcode, options);
        } else {
            return this._kohaCheckOut(patronCardNumber, itemBarcode);
        }
    }

    async _mockCheckOut(patronCardNumber, itemBarcode) {
        await this._simulateDelay();

        const patron = this.mockDB.patrons.find(p => p.cardNumber === patronCardNumber);
        if (!patron) {
            throw new Error('Patron not found. Please check the card number.');
        }

        const item = this.mockDB.items.find(i => i.barcode === itemBarcode);
        if (!item) {
            throw new Error('Item not found. Please check the barcode.');
        }

        if (item.status === 'checked_out') {
            throw new Error('This item is already checked out.');
        }

        // Perform checkout
        item.status = 'checked_out';
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 14); // 2 weeks loan period

        const checkout = {
            checkoutId: Date.now(),
            patronCardNumber,
            patronName: patron.name,
            itemBarcode,
            itemTitle: item.title,
            checkoutDate: new Date().toISOString(),
            dueDate: dueDate.toISOString()
        };

        this.mockDB.checkouts.push(checkout);

        return {
            success: true,
            message: 'Item checked out successfully!',
            data: checkout
        };
    }

    async _kohaCheckOut(patronCardNumber, itemBarcode) {
        try {
            // Step 1: Find patron by card number
            const patronUrl = `${this.config.koha.baseUrl}/patrons`;
            const patronResponse = await fetch(`${patronUrl}?cardnumber=${patronCardNumber}`, {
                method: 'GET',
                headers: {
                    'Authorization': this._getAuthHeader()
                }
            });

            if (!patronResponse.ok) {
                throw new Error('Failed to find patron. Check card number.');
            }

            const patrons = await patronResponse.json();
            if (!patrons || patrons.length === 0) {
                throw new Error(`No patron found with card number ${patronCardNumber}`);
            }
            const patron = patrons[0];

            // Step 2: Find item by barcode
            const itemUrl = `${this.config.koha.baseUrl}/items`;
            const itemResponse = await fetch(`${itemUrl}?external_id=${itemBarcode}`, {
                method: 'GET',
                headers: {
                    'Authorization': this._getAuthHeader()
                }
            });

            if (!itemResponse.ok) {
                throw new Error('Failed to find item. Check barcode.');
            }

            const items = await itemResponse.json();
            if (!items || items.length === 0) {
                throw new Error(`No item found with barcode ${itemBarcode}`);
            }
            const item = items[0];

            // Step 3: Create checkout
            const checkoutUrl = `${this.config.koha.baseUrl}/checkouts`;
            const checkoutResponse = await fetch(checkoutUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': this._getAuthHeader()
                },
                body: JSON.stringify({
                    patron_id: patron.patron_id,
                    item_id: item.item_id,
                    library_id: this.config.koha.branchCode
                })
            });

            if (!checkoutResponse.ok) {
                const errorText = await checkoutResponse.text();
                throw new Error(`Checkout failed: ${errorText}`);
            }

            const checkout = await checkoutResponse.json();

            return {
                success: true,
                message: 'Item checked out successfully!',
                data: {
                    checkoutId: checkout.checkout_id,
                    patronCardNumber: patronCardNumber,
                    patronName: patron.firstname + ' ' + patron.surname,
                    itemBarcode: itemBarcode,
                    itemTitle: item.external_id, // Will show barcode for now
                    checkoutDate: checkout.checkout_date || new Date().toISOString(),
                    dueDate: checkout.due_date || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
                }
            };
        } catch (error) {
            throw new Error(`Koha API Error: ${error.message}`);
        }
    }

    /**
     * Check in an item
     * @param {string} itemBarcode - Item's barcode
     * @returns {Promise<Object>} Checkin result
     */
    async checkIn(itemBarcode, options = {}) {
        if (this.mode === 'demo') {
            return this._mockCheckIn(itemBarcode);
        } else if (this.mode === 'backend') {
            return this._backendCheckIn(itemBarcode, options);
        } else {
            return this._kohaCheckIn(itemBarcode);
        }
    }

    async _mockCheckIn(itemBarcode) {
        await this._simulateDelay();

        const item = this.mockDB.items.find(i => i.barcode === itemBarcode);
        if (!item) {
            throw new Error('Item not found. Please check the barcode.');
        }

        if (item.status !== 'checked_out') {
            throw new Error('This item is not checked out.');
        }

        // Find and remove the checkout record
        const checkoutIndex = this.mockDB.checkouts.findIndex(c => c.itemBarcode === itemBarcode);
        let checkout = null;
        if (checkoutIndex >= 0) {
            checkout = this.mockDB.checkouts[checkoutIndex];
            this.mockDB.checkouts.splice(checkoutIndex, 1);
        }

        // Update item status
        item.status = 'available';

        return {
            success: true,
            message: 'Item checked in successfully!',
            data: {
                itemBarcode,
                itemTitle: item.title,
                checkinDate: new Date().toISOString(),
                previousCheckout: checkout
            }
        };
    }

    async _kohaCheckIn(itemBarcode) {
        try {
            // Step 1: Find item by barcode
            const itemUrl = `${this.config.koha.baseUrl}/items`;
            const itemResponse = await fetch(`${itemUrl}?external_id=${itemBarcode}`, {
                method: 'GET',
                headers: {
                    'Authorization': this._getAuthHeader()
                }
            });

            if (!itemResponse.ok) {
                throw new Error('Failed to find item. Check barcode.');
            }

            const items = await itemResponse.json();
            if (!items || items.length === 0) {
                throw new Error(`No item found with barcode ${itemBarcode}`);
            }
            const item = items[0];

            // Step 2: Try REST API check-in (might return 404 in some Koha versions)
            const checkinUrl = `${this.config.koha.baseUrl}/checkouts/checkin`;

            try {
                const checkinResponse = await fetch(checkinUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': this._getAuthHeader()
                    },
                    body: JSON.stringify({
                        item_id: item.item_id,
                        library_id: this.config.koha.branchCode
                    })
                });

                if (checkinResponse.ok) {
                    const data = await checkinResponse.json();
                    return {
                        success: true,
                        message: 'Item checked in successfully!',
                        data: {
                            itemBarcode: itemBarcode,
                            itemTitle: item.external_id,
                            checkinDate: new Date().toISOString()
                        }
                    };
                }
            } catch (restError) {
                // REST API check-in might not be available
                console.log('REST check-in failed, this is expected:', restError);
            }

            // If REST check-in failed, inform user
            throw new Error('Check-in requires SIP2 backend. Please use the Python Flask app for check-in operations, or contact administrator to enable SIP2 proxy.');

        } catch (error) {
            throw new Error(`Koha Check-in Error: ${error.message}`);
        }
    }

    /**
     * Get authentication header for Koha API
     * @private
     */
    _getAuthHeader() {
        if (this.config.koha.auth.type === 'basic') {
            const credentials = btoa(`${this.config.koha.auth.username}:${this.config.koha.auth.password}`);
            return `Basic ${credentials}`;
        }
        // OAuth2 implementation would go here
        return '';
    }

    /**
     * Backend mode: Check out via localhost server
     */
    async _backendCheckOut(patronCardNumber, itemBarcode, options = {}) {
        try {
            const response = await fetch(`${this.config.backend.baseUrl}/checkout`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    patronCardNumber: patronCardNumber,
                    itemBarcode: itemBarcode,
                    rfidUid: options.rfidUid || '',
                    skipSecurityWrite: options.skipSecurityWrite === true
                })
            });

            const result = await response.json();

            if (!result.success) {
                throw new Error(result.message || 'Checkout failed');
            }

            return result;
        } catch (error) {
            throw new Error(`Backend Error: ${error.message}`);
        }
    }

    /**
     * Backend mode: Check in via localhost server (uses SIP2)
     */
    async _backendCheckIn(itemBarcode, options = {}) {
        try {
            const response = await fetch(`${this.config.backend.baseUrl}/checkin`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    itemBarcode: itemBarcode,
                    rfidUid: options.rfidUid || '',
                    skipSecurityWrite: options.skipSecurityWrite === true
                })
            });

            const result = await response.json();

            if (!result.success) {
                throw new Error(result.message || 'Check-in failed');
            }

            return result;
        } catch (error) {
            throw new Error(`Backend Error: ${error.message}`);
        }
    }

    async updateRfidSecurity({ state, barcode = '', uid = '' }) {
        try {
            const response = await fetch(`${this.config.backend.baseUrl}/rfid/security`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    state,
                    barcode,
                    uid
                })
            });

            const result = await response.json();

            if (!result.success) {
                throw new Error(result.message || 'RFID security write failed');
            }

            return result;
        } catch (error) {
            throw new Error(`RFID Security Error: ${error.message}`);
        }
    }

    async getAccount(patronCardNumber) {
        if (this.mode === 'demo') {
            return this._mockGetAccount(patronCardNumber);
        } else if (this.mode === 'backend') {
            return this._backendGetAccount(patronCardNumber);
        }

        throw new Error('My Account is available only in backend mode.');
    }

    async _mockGetAccount(patronCardNumber) {
        await this._simulateDelay();

        const patron = this.mockDB.patrons.find(p => p.cardNumber === patronCardNumber);
        if (!patron) {
            throw new Error('Patron not found. Please check the card number.');
        }

        const loans = this.mockDB.checkouts
            .filter(checkout => checkout.patronCardNumber === patronCardNumber)
            .map(checkout => ({
                itemBarcode: checkout.itemBarcode,
                itemTitle: checkout.itemTitle,
                dueDate: checkout.dueDate || ''
            }));

        return {
            success: true,
            data: {
                patronCardNumber,
                patronName: patron.name,
                fineAmount: Number(patron.fineAmount || 0),
                loans
            }
        };
    }

    async _backendGetAccount(patronCardNumber) {
        try {
            const response = await fetch(`${this.config.backend.baseUrl}/account?cardnumber=${encodeURIComponent(patronCardNumber)}`);
            const result = await response.json();

            if (!result.success) {
                throw new Error(result.message || 'Unable to fetch account details');
            }

            return result;
        } catch (error) {
            throw new Error(`Backend Error: ${error.message}`);
        }
    }

    /**
     * Renew an item for a patron via Koha REST (backend mode only)
     * @param {string} patronCardNumber
     * @param {string} itemBarcode
     * @returns {Promise<Object>}
     */
    async renew(patronCardNumber, itemBarcode) {
        if (this.mode === 'demo') {
            return this._mockRenew(patronCardNumber, itemBarcode);
        }
        return this._backendRenew(patronCardNumber, itemBarcode);
    }

    async _mockRenew(patronCardNumber, itemBarcode) {
        await this._simulateDelay();
        const patron = this.mockDB.patrons.find(p => p.cardNumber === patronCardNumber);
        if (!patron) throw new Error('Patron not found. Please check the card number.');
        const checkout = this.mockDB.checkouts.find(c => c.itemBarcode === itemBarcode && c.patronCardNumber === patronCardNumber);
        if (!checkout) throw new Error('This item is not currently checked out to this patron.');
        const newDue = new Date();
        newDue.setDate(newDue.getDate() + 14);
        checkout.dueDate = newDue.toISOString();
        return {
            success: true,
            message: 'Item renewed successfully.',
            data: {
                patronCardNumber,
                patronName: patron.name,
                itemBarcode,
                itemTitle: checkout.itemTitle || itemBarcode,
                newDueDate: checkout.dueDate
            }
        };
    }

    async _backendRenew(patronCardNumber, itemBarcode) {
        try {
            const response = await fetch(`${this.config.backend.baseUrl}/renew`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ patronCardNumber, itemBarcode })
            });
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.message || 'Renewal failed');
            }
            return result;
        } catch (error) {
            throw new Error(error.message || 'Renewal failed');
        }
    }

    /**
     * Renew — fetch items out for a patron with renewable/not-renewable classification.
     * @param {string} patronCardNumber
     * @returns {Promise<Object>} { success, data: { patronName, patronCardNumber, items[] } }
     */
    async getItemsForRenew(patronCardNumber) {
        if (this.mode === 'demo') {
            return this._mockGetItemsForRenew(patronCardNumber);
        }
        return this._backendGetItemsForRenew(patronCardNumber);
    }

    async _mockGetItemsForRenew(patronCardNumber) {
        await this._simulateDelay();
        const patron = this.mockDB.patrons.find(p => p.cardNumber === patronCardNumber);
        if (!patron) throw new Error('Patron not found. Please check the card number.');
        const loans = this.mockDB.checkouts.filter(c => c.patronCardNumber === patronCardNumber);
        const items = loans.map((c, i) => ({
            checkoutId: 1000 + i,
            itemId: i + 1,
            itemBarcode: c.itemBarcode,
            itemTitle: c.itemTitle || c.itemBarcode,
            dueDate: c.dueDate ? new Date(c.dueDate).toISOString().slice(0, 10) : '',
            renewable: i % 2 === 0 ? true : false,
            notRenewableReason: i % 2 !== 0 ? 'Maximum renewals reached' : '',
            renewalsRemaining: i % 2 === 0 ? 2 : 0
        }));
        // Add demo items if empty so the UI has data to show
        if (items.length === 0) {
            items.push(
                { checkoutId: 1001, itemId: 1, itemBarcode: 'DEMO001', itemTitle: 'Introduction to Programming', dueDate: '2026-04-25', renewable: true,  notRenewableReason: '',                         renewalsRemaining: 2 },
                { checkoutId: 1002, itemId: 2, itemBarcode: 'DEMO002', itemTitle: 'Advanced Algorithms',         dueDate: '2026-03-10', renewable: false, notRenewableReason: 'Maximum renewals reached', renewalsRemaining: 0 },
                { checkoutId: 1003, itemId: 3, itemBarcode: 'DEMO003', itemTitle: 'Database Design',             dueDate: '2026-04-30', renewable: null,  notRenewableReason: '',                         renewalsRemaining: null }
            );
        }
        return { success: true, data: { patronName: patron.name, patronCardNumber, items } };
    }

    async _backendGetItemsForRenew(patronCardNumber) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        try {
            console.log(`[API] Fetching renew items for: ${patronCardNumber}`);
            const response = await fetch(`${this.config.backend.baseUrl}/renew/items?cardnumber=${encodeURIComponent(patronCardNumber)}`, { signal: controller.signal });
            clearTimeout(timeoutId);
            const result = await response.json();
            if (!result.success) throw new Error(result.message || 'Unable to fetch items');
            return result;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') throw new Error('Request timed out. Please try again.');
            throw new Error(error.message || 'Unable to fetch items');
        }
    }

    /**
     * Renew — submit a batch of barcodes for renewal.
     * @param {string} patronCardNumber
     * @param {string[]} barcodes
     * @returns {Promise<Object>} { success, results: [{ barcode, ok, itemTitle, newDueDate, message }] }
     */
    async renewBatch(patronCardNumber, barcodes) {
        if (this.mode === 'demo') {
            return this._mockRenewBatch(patronCardNumber, barcodes);
        }
        return this._backendRenewBatch(patronCardNumber, barcodes);
    }

    async _mockRenewBatch(patronCardNumber, barcodes) {
        await this._simulateDelay();
        const results = barcodes.map((barcode, i) => {
            const ok = i % 3 !== 2; // every 3rd item fails
            const newDue = new Date();
            newDue.setDate(newDue.getDate() + 14);
            return {
                barcode,
                ok,
                itemTitle: `Item ${barcode}`,
                newDueDate: ok ? newDue.toISOString().slice(0, 10) : '',
                message: ok ? 'Renewed successfully' : 'Maximum renewal limit reached for this item.'
            };
        });
        return { success: true, results };
    }

    async _backendRenewBatch(patronCardNumber, barcodes) {
        try {
            const response = await fetch(`${this.config.backend.baseUrl}/renew/batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ patronCardNumber, barcodes })
            });
            const result = await response.json();
            if (!result.success) throw new Error(result.message || 'Batch renewal failed');
            return result;
        } catch (error) {
            throw new Error(error.message || 'Batch renewal failed');
        }
    }

    // ─── QR Receipt (Renew Only) ──────────────────────────────────────────────

    /**
     * Create a QR receipt token + PDF link for the Renew flow.
     * NEW isolated endpoint — not used by Check-In / Check-Out / Account.
     * @param {Object} transactionData - lastTransaction from Renew flow
     * @returns {Promise<{ token: string, url: string, expiresAt: string, localOnly: boolean }>}
     */
    async createQrReceipt(transactionData) {
        try {
            const response = await fetch('/api/receipt/qr', {
                method : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body   : JSON.stringify({ transactionData })
            });
            const result = await response.json();
            if (!result.token) throw new Error(result.message || 'Failed to create QR receipt');
            return result;
        } catch (error) {
            throw new Error(error.message || 'QR receipt creation failed');
        }
    }

    /**
     * Poll QR receipt download status.
     * NEW isolated endpoint — not used by Check-In / Check-Out / Account.
     * @param {string} token
     * @returns {Promise<{ downloaded: boolean, remainingSeconds: number, expired: boolean }>}
     */
    async getQrReceiptStatus(token) {
        try {
            const response = await fetch(`/api/receipt/qr-status/${encodeURIComponent(token)}`);
            return await response.json();
        } catch (error) {
            throw new Error(error.message || 'QR status check failed');
        }
    }

    // ─── End QR Receipt ───────────────────────────────────────────────────────

    async placeHold(patronCardNumber, barcode) {
        if (this.mode === 'demo') {
            await this._simulateDelay();
            return { success: true, message: 'Hold placed successfully (Demo Mode)' };
        }
        
        try {
            const response = await fetch(`${this.config.backend.baseUrl}/hold`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ patronCardNumber, barcode })
            });

            const result = await response.json();

            if (!result.success) {
                throw new Error(result.message || 'Failed to place hold');
            }

            return result;
        } catch (error) {
            throw new Error(`Backend Error: ${error.message}`);
        }
    }

    /**
     * Get current mode
     */
    getMode() {
        return this.mode;
    }

    /**
     * Switch between modes
     */
    setMode(mode) {
        if (mode === 'demo' || mode === 'koha' || mode === 'backend') {
            this.mode = mode;
            this.config.mode = mode;
        }
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = KohaAPI;
}
