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
