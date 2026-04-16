class PatronRfidService {
    constructor() {
        this.port = null;
        this.reader = null;
        this.writer = null;
        this.lineBuffer = '';
        this.capturing = false;
        this.capturedLines = [];
        this.isConnecting = false;
        this.autoReconnectTimer = null;
        this.hardwareWatchdog = null;
        this.lastRxTime = 0;
        this.lastPatronValue = '';
        this.lastPatronValueAt = 0;
        this.statusEl = null;
        this.captureResolved = false;
        this.captureUid = '';
        this.captureAscii = '';

        this.CH340_FILTERS = [
            { usbVendorId: 0x1A86 },
            { usbVendorId: 0x10C4 },
            { usbVendorId: 0x0403 }
        ];

        this.init();
    }

    init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.onReady());
        } else {
            this.onReady();
        }
    }

    onReady() {
        this.statusEl = document.getElementById('patron-rfid-status');

        if (!('serial' in navigator)) {
            this.setStatus('Patron RFID reader unavailable in this browser.', 'error');
            return;
        }

        this.setStatus('Looking for saved CH340 reader access...', 'info');
        this.tryAutoConnect();

        navigator.serial.addEventListener?.('disconnect', () => {
            if (this.port) this.handleUnexpectedDisconnect();
        });
    }

    async beginCheckoutSession() {
        this.resetSession();
        this.setStatus('Checkout ready. Waiting for patron RFID card...', 'ok');

        if (this.port) {
            await this.send('IDLE\n');
            await this.send('READ_MODE\n');
            return;
        }

        await this.requestAndConnect();
    }

    async beginAccountSession() {
        this.resetSession();
        this.setStatus('Account lookup ready. Waiting for patron RFID card...', 'ok');

        if (this.port) {
            await this.send('IDLE\n');
            await this.send('READ_MODE\n');
            return;
        }

        await this.requestAndConnect();
    }

    async beginRenewSession() {
        this.resetSession();
        this.setStatus('Renew ready. Waiting for patron RFID card...', 'ok');

        if (this.port) {
            await this.send('IDLE\n');
            await this.send('READ_MODE\n');
            return;
        }

        await this.requestAndConnect();
    }

    async tryAutoConnect() {
        if (this.port || this.isConnecting || !('serial' in navigator)) return;

        this.isConnecting = true;
        clearTimeout(this.autoReconnectTimer);

        try {
            // In Electron, we want to route through our main.js select-serial-port handler
            // because it has robust logging and VID/PID matching logic.
            if (navigator.userAgent.includes('Electron')) {
                console.log('[Patron RFID] Running in Electron, using robust auto-select...');
                this.isConnecting = false;
                return this.requestAndConnect();
            }

            const rememberedPorts = await navigator.serial.getPorts();
            const knownPort = rememberedPorts.find((candidate) => this.isUsbSerialPort(candidate));

            if (!knownPort) {
                this.isConnecting = false;
                // If this is a regular browser, it will throw a user gesture error which is caught safely.
                return this.requestAndConnect();
            }

            this.isConnecting = false;
            await this.openPort(knownPort);
        } catch (error) {
            this.isConnecting = false;
            this.setStatus('Unable to auto-connect patron RFID reader.', 'error');
            console.warn('[Patron RFID] Auto-connect failed:', error);
        }
    }

    async requestAndConnect() {
        if (this.port || this.isConnecting || !('serial' in navigator)) return;

        this.isConnecting = true;
        this.setStatus('Select the USB-SERIAL CH340 patron reader...', 'info');

        try {
            const requestedPort = await navigator.serial.requestPort({ filters: this.CH340_FILTERS });
            this.isConnecting = false;
            await this.openPort(requestedPort);
        } catch (error) {
            this.isConnecting = false;
            this.setStatus('Patron RFID reader was not selected.', 'error');
            console.warn('[Patron RFID] requestPort failed:', error);
        }
    }

    isUsbSerialPort(candidate) {
        const info = candidate?.getInfo ? candidate.getInfo() : {};
        if (!info || info.usbVendorId === undefined) return false;
        return this.CH340_FILTERS.some((filter) => filter.usbVendorId === info.usbVendorId);
    }

    async openPort(port) {
        try {
            await port.open({ baudRate: 115200 });

            try {
                await port.setSignals({ dataTerminalReady: false, requestToSend: false });
            } catch (_) {
            }

            this.port = port;
            this.writer = port.writable.getWriter();
            this.lastRxTime = Date.now();
            this.setStatus('Patron RFID reader connected. Waiting for patron card...', 'ok');
            console.log('[Patron RFID] Connected to CH340 reader');

            if (this.hardwareWatchdog) clearInterval(this.hardwareWatchdog);
            this.hardwareWatchdog = setInterval(() => {
                if (this.port && Date.now() - this.lastRxTime > 6000 && !this.capturing) {
                    console.warn('[Patron RFID] Reader silent, reconnecting');
                    this.handleUnexpectedDisconnect();
                }
            }, 1000);

            this.readLoop();

            setTimeout(async () => {
                if (!this.port) return;
                await this.send('READ_MODE\n');
            }, 2000);
        } catch (error) {
            this.setStatus('Failed to open patron RFID reader.', 'error');
            console.warn('[Patron RFID] openPort failed:', error);
            this.scheduleReconnect();
        }
    }

    async readLoop() {
        const decoder = new TextDecoder();

        try {
            while (this.port && this.port.readable) {
                try {
                    this.reader = this.port.readable.getReader();

                    while (true) {
                        const { value, done } = await this.reader.read();
                        if (done) throw new Error('Port closed');

                        this.lineBuffer += decoder.decode(value, { stream: true });
                        if (this.lineBuffer.length > 4096) {
                            this.lineBuffer = this.lineBuffer.slice(-2048);
                        }

                        let newlineIndex;
                        while ((newlineIndex = this.lineBuffer.indexOf('\n')) !== -1) {
                            const line = this.lineBuffer.slice(0, newlineIndex).replace(/\r/g, '').trim();
                            this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
                            if (line) this.onSerialLine(line);
                        }
                    }
                } catch (error) {
                    console.warn('[Patron RFID] Read loop stopped:', error.message || error);
                    break;
                } finally {
                    if (this.reader) {
                        try { this.reader.releaseLock(); } catch (_) { }
                    }
                }
            }
        } finally {
            if (this.port) {
                this.handleUnexpectedDisconnect();
            }
        }
    }

    onSerialLine(line) {
        this.lastRxTime = Date.now();

        if (line === 'NO_CARD') return;

        if (line === 'CARD_START') {
            this.capturing = true;
            this.capturedLines = [];
            this.captureResolved = false;
            this.captureUid = '';
            this.captureAscii = '';
            this.setStatus('Patron card detected. Reading...', 'info');
            return;
        }

        if (line === 'CARD_END') {
            this.capturing = false;
            if (this.captureResolved) {
                return;
            }
            this.processCard(this.capturedLines);
            return;
        }

        if (this.capturing) {
            this.capturedLines.push(line);
            this.tryFastCapture(line);
            return;
        }

        if (line === 'READY') {
            this.setStatus('Patron RFID reader ready.', 'ok');
            return;
        }

        if (line.startsWith('ERROR:')) {
            this.setStatus(line, 'error');
            return;
        }

        const inlineCardValue = this.extractInlineCardValue(line);
        if (inlineCardValue) {
            this.applyPatronCard(inlineCardValue, '');
        }
    }

    extractInlineCardValue(line) {
        const raw = String(line || '').trim();
        if (!raw) return '';

        const prefixedMatch = raw.match(/^(?:CARD|DATA|TAG|VALUE)\s*:\s*(.+)$/i);
        if (prefixedMatch) {
            return prefixedMatch[1].trim();
        }

        if (!raw.includes(':') && /^[0-9]{5,16}$/.test(raw)) {
            return raw;
        }

        return '';
    }

    tryFastCapture(line) {
        if (this.captureResolved) return;

        const uidMatch = line.match(/^UID\s*:\s*(.+)$/i);
        if (uidMatch) {
            const raw = uidMatch[1].trim().toUpperCase();
            this.captureUid = raw.replace(/\s+/g, '');
            return;
        }

        if (!/^BLOCK\s*:/i.test(line)) return;

        const firstColon = line.indexOf(':');
        const secondColon = line.indexOf(':', firstColon + 1);
        if (firstColon < 0 || secondColon < 0) return;

        const blockNum = Number(line.slice(firstColon + 1, secondColon));
        if (!Number.isFinite(blockNum) || blockNum === 0 || blockNum % 4 === 3) return;

        const hexRaw = line.slice(secondColon + 1).trim().toUpperCase();
        if (hexRaw.length < 32 || hexRaw.startsWith('?')) return;

        const pairs = hexRaw.match(/.{1,2}/g) || [];
        for (const pair of pairs) {
            const value = Number.parseInt(pair, 16);
            if (value >= 32 && value <= 126) {
                this.captureAscii += String.fromCharCode(value);
            }
        }

        const candidate = this.extractFastPatronCandidate(this.captureAscii);
        if (!candidate) return;

        const now = Date.now();
        if (candidate === this.lastPatronValue && now - this.lastPatronValueAt < 2000) {
            this.captureResolved = true;
            return;
        }

        this.lastPatronValue = candidate;
        this.lastPatronValueAt = now;
        this.captureResolved = true;
        this.applyPatronCard(candidate, this.captureUid);
    }

    extractFastPatronCandidate(text) {
        const cleaned = String(text || '').replace(/\0/g, ' ').replace(/\s+/g, ' ').trim();
        if (!cleaned) return '';

        const tokens = cleaned.match(/[A-Za-z0-9_-]{3,24}/g) || [];
        for (const token of tokens) {
            if (/^[0-9A-F]{8,}$/i.test(token)) continue;
            if (/^[A-Za-z]{1,5}[0-9]{1,16}$/.test(token)) return token;
        }

        for (const token of tokens) {
            if (/^[0-9A-F]{8,}$/i.test(token)) continue;
            if (/^[0-9]{4,16}$/.test(token)) return token;
        }

        return '';
    }

    processCard(lines) {
        const parsed = this.extractTagValue(lines);
        const finalValue = parsed.tagValue || '';

        if (!finalValue) {
            this.setStatus('Card read complete, but no patron value was found.', 'error');
            return;
        }

        const now = Date.now();
        if (finalValue === this.lastPatronValue && now - this.lastPatronValueAt < 2000) {
            return;
        }

        this.lastPatronValue = finalValue;
        this.lastPatronValueAt = now;
        this.applyPatronCard(finalValue, parsed.uid);
    }

    extractTagValue(lines) {
        const card = { uid: '', sectors: [] };
        let currentSector = null;

        for (const line of lines) {
            const uidMatch = line.match(/^UID\s*:\s*(.+)$/i);
            if (uidMatch) {
                const raw = uidMatch[1].trim().toUpperCase();
                card.uid = raw.match(/.{1,2}/g)?.join(' ') ?? raw;
                continue;
            }

            if (/^SECTOR\s*:/i.test(line)) {
                currentSector = { blocks: [] };
                card.sectors.push(currentSector);
                continue;
            }

            if (!/^BLOCK\s*:/i.test(line)) continue;

            const firstColon = line.indexOf(':');
            const secondColon = line.indexOf(':', firstColon + 1);
            if (firstColon < 0 || secondColon < 0) continue;

            const blockNum = Number(line.slice(firstColon + 1, secondColon));
            const hexRaw = line.slice(secondColon + 1).trim().toUpperCase();
            const fail = hexRaw.length < 32 || hexRaw.startsWith('?');

            let bytes = [];
            if (!fail) {
                const pairs = hexRaw.match(/.{1,2}/g) || [];
                bytes = pairs.map((pair) => Number.parseInt(pair, 16));
            }

            currentSector?.blocks.push({ num: blockNum, bytes, fail });
        }

        let fullText = '';
        for (const sector of card.sectors) {
            for (const block of sector.blocks) {
                if (block.num === 0 || block.num % 4 === 3 || block.fail) continue;
                for (const value of block.bytes) {
                    if (value >= 32 && value <= 126) {
                        fullText += String.fromCharCode(value);
                    }
                }
            }
        }

        const cleanText = fullText.replace(/\0/g, '').trim();
        const uidCompact = card.uid.replace(/\s+/g, '');

        return {
            tagValue: cleanText || '',
            uid: uidCompact
        };
    }

    applyPatronCard(tagValue, uid) {
        if (!window.kioskApp) {
            return;
        }

        const isCheckout = window.kioskApp.currentOperation === 'checkout';
        const isAccount  = window.kioskApp.currentOperation === 'account';
        const isRenew    = window.kioskApp.currentOperation === 'renew';

        if (!isCheckout && !isAccount && !isRenew) return;

        const safeValue = String(tagValue || '').trim();
        if (!safeValue) return;

        // Renew: delegate to kioskApp.handleRenewPatronScan
        if (isRenew) {
            // Only accept scan while the patron scan screen is shown; ignore after navigation
            if (window.kioskApp.currentView !== 'renew-scan') {
                return;
            }
            window.kioskApp.handleRenewPatronScan(safeValue);
            this.setStatus(`Patron card scanned successfully.`, 'ok');
            console.log('[Patron RFID] Renew patron card captured:', safeValue);
            return;
        }

        const targetInputId = isCheckout ? 'patron-card' : 'account-card';
        const patronCardEl = document.getElementById(targetInputId);
        if (!patronCardEl) return;

        if (patronCardEl.value.trim().length > 0) {
            this.setStatus(
                isCheckout
                    ? 'Patron card already filled. Waiting for item barcode from HF FEIG reader.'
                    : 'Patron card already filled. Press Search to view account.',
                'ok'
            );
            return;
        }

        patronCardEl.value = safeValue;
        patronCardEl.dispatchEvent(new Event('input', { bubbles: true }));
        patronCardEl.dispatchEvent(new Event('change', { bubbles: true }));

        if (isCheckout) {
            document.getElementById('item-barcode')?.focus();
        }

        this.setStatus(`Patron card captured from CH340${uid ? ` (${uid})` : ''}.`, 'ok');
        console.log('[Patron RFID] Filled patron card:', safeValue);
    }

    resetSession() {
        this.lastPatronValue = '';
        this.lastPatronValueAt = 0;
        this.capturing = false;
        this.capturedLines = [];
        this.lineBuffer = '';
        this.captureResolved = false;
        this.captureUid = '';
        this.captureAscii = '';
    }

    async send(text) {
        if (!this.writer) return;
        await this.writer.write(new TextEncoder().encode(text));
    }

    async handleUnexpectedDisconnect() {
        try { await this.send('IDLE\n'); } catch (_) { }
        try { if (this.reader) await this.reader.cancel(); } catch (_) { }
        try { if (this.reader) this.reader.releaseLock(); } catch (_) { }
        try { if (this.writer) this.writer.releaseLock(); } catch (_) { }
        try { if (this.port) await this.port.close(); } catch (_) { }

        this.port = null;
        this.reader = null;
        this.writer = null;
        this.capturing = false;
        this.capturedLines = [];
        this.lineBuffer = '';

        if (this.hardwareWatchdog) {
            clearInterval(this.hardwareWatchdog);
            this.hardwareWatchdog = null;
        }

        this.setStatus('Patron RFID reader disconnected. Reconnecting...', 'error');
        this.scheduleReconnect();
    }

    scheduleReconnect() {
        clearTimeout(this.autoReconnectTimer);
        this.autoReconnectTimer = setTimeout(() => this.tryAutoConnect(), 1500);
    }

    setStatus(message, type = 'info') {
        const elements = [
            document.getElementById('patron-rfid-status'),
            document.getElementById('renew-patron-status')
        ].filter(Boolean);

        for (const el of elements) {
            el.style.display = 'block';
            el.textContent = message;

            if (type === 'ok') {
                el.style.background = 'rgba(16,185,129,0.10)';
                el.style.borderColor = 'rgba(16,185,129,0.24)';
                el.style.color = '#0f6b42';
            } else if (type === 'error') {
                el.style.background = 'rgba(239,68,68,0.10)';
                el.style.borderColor = 'rgba(239,68,68,0.22)';
                el.style.color = '#9f1d1d';
            } else {
                el.style.background = 'rgba(14,165,233,0.08)';
                el.style.borderColor = 'rgba(14,165,233,0.18)';
                el.style.color = '#0f4c6e';
            }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.patronRfidService = new PatronRfidService();
});
