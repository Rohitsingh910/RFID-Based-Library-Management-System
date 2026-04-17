'use strict';

/**
 * Electron Main Process - Punjabi University Library Kiosk
 * Powered by SoCTeamup Semiconductors
 *
 * Responsibilities:
 *  - Spawn the Node.js backend (server.js) as a child process
 *  - Open a kiosk-mode BrowserWindow once the backend is ready
 *  - Cleanly shut down the backend when the Electron app exits
 */

const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

// Global switch to suppress print dialogs across ALL windows
app.commandLine.appendSwitch('kiosk-printing');

// ─── Configuration ─────────────────────────────────────────────────────────────
const BACKEND_PORT = 3000;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const BACKEND_READY_TIMEOUT_MS = 30000; // 30 seconds to allow bridge startup
const BACKEND_POLL_INTERVAL_MS = 300;

// When packaged, __dirname is  <installDir>/resources/app
// When running from source, __dirname is the project root
const SERVER_SCRIPT = path.join(__dirname, 'server.js');
const NODE_EXECUTABLE = process.execPath; // same Node used by Electron

// ─── State ─────────────────────────────────────────────────────────────────────
let backendProcess = null;
let mainWindow = null;
let isQuitting = false;

// ─── Backend Process ────────────────────────────────────────────────────────────
function startBackend() {
  console.log('[electron] Starting backend server…');

  backendProcess = spawn(NODE_EXECUTABLE, [SERVER_SCRIPT], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(BACKEND_PORT),
      // Crucial for packaged apps: tell the Electron binary to act as Node.js
      ELECTRON_RUN_AS_NODE: '1',
      // Only override RFID path when running as a packaged Electron app.
      // In dev mode, server.js uses rfid-integration/build/ directly (its own default).
      ...(app.isPackaged
        ? { RFID_RESOURCES_DIR: path.join(process.resourcesPath, 'rfid-bridge') }
        : {})
    },
    windowsHide: true
  });

  backendProcess.stdout.on('data', (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
  });

  backendProcess.stderr.on('data', (chunk) => {
    process.stderr.write(`[server-err] ${chunk}`);
  });

  backendProcess.on('exit', (code, signal) => {
    console.log(`[electron] Backend exited (code=${code}, signal=${signal})`);
    backendProcess = null;
    if (!isQuitting) {
      dialog.showErrorBox(
        'Server Stopped',
        `The backend server stopped unexpectedly (code=${code}). Please restart the application.`
      );
    }
  });

  backendProcess.on('error', (err) => {
    console.error('[electron] Failed to start backend:', err.message);
    dialog.showErrorBox('Startup Error', `Could not start the backend server:\n${err.message}`);
  });
}

function stopBackend() {
  if (backendProcess) {
    console.log('[electron] Shutting down backend…');
    try {
      backendProcess.kill('SIGTERM');
    } catch (_) {}
    backendProcess = null;
  }
}

// ─── Backend Readiness Poll ─────────────────────────────────────────────────────
function waitForBackend() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + BACKEND_READY_TIMEOUT_MS;

    const poll = () => {
      http.get(`${BACKEND_URL}/api/status`, (res) => {
        // Any HTTP response means the server is up
        res.resume();
        resolve();
      }).on('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error(`Backend did not start within ${BACKEND_READY_TIMEOUT_MS / 1000}s`));
          return;
        }
        setTimeout(poll, BACKEND_POLL_INTERVAL_MS);
      });
    };

    poll();
  });
}

// ─── Browser Window ─────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    fullscreen: false,      // Set to true for kiosk/touch-screen deployment
    kiosk: false,           // Set to true for locked-down kiosk mode
    autoHideMenuBar: true,
    title: 'Punjabi University Library Kiosk',
    icon: path.join(__dirname, 'public', 'jivesna_logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    },
    backgroundColor: '#0f172a'
  });

  // Remove the menu bar
  mainWindow.setMenuBarVisibility(false);

  // Auto-approve Web Serial API requests and auto-select the CH340 device
  mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    
    console.log(`[electron] Found ${portList.length} serial ports:`);
    portList.forEach(p => {
      console.log(`[electron]   - ${p.portName} (VID: ${p.vendorId}, PID: ${p.productId})`);
    });

    // Vendor IDs for common USB-Serial chips (CH340: 0x1A86 / 6790)
    const knownVidsDec = [6790, 4292, 1027]; // CH340, CP2102, FTDI
    const knownVidsHex = ['1a86', '10c4', '0403', '0x1a86', '0x10c4', '0x0403'];
    
    const selectedPort = portList.find(port => {
      if (!port.vendorId) return false;
      const vidStr = String(port.vendorId).toLowerCase();
      const vidNum = parseInt(vidStr, 10);
      
      return knownVidsDec.includes(vidNum) || knownVidsHex.includes(vidStr);
    });
    
    if (selectedPort) {
      console.log(`[electron] Matching known reader: ${selectedPort.portName} (VID: ${selectedPort.vendorId})`);
      callback(selectedPort.portId);
    } else {
      console.log('[electron] No matching CH340/Serial reader found in port list.');
      callback(''); // Cancel auto-selection, user will need to select manually or fix hardware
    }
  });

  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'serial') {
      return true; // Auto-approve serial permission
    }
    return false;
  });

  mainWindow.webContents.session.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'serial') {
      return true; // Auto-approve serial devices
    }
    return false;
  });

  // Load the local backend server
  mainWindow.loadURL(BACKEND_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  startBackend();

  try {
    console.log('[electron] Waiting for backend to be ready…');
    await waitForBackend();
    console.log('[electron] Backend is ready. Opening window.');
    createWindow();
  } catch (err) {
    console.error('[electron] Backend startup timed out:', err.message);
    dialog.showErrorBox(
      'Startup Timeout',
      `The application backend did not start in time.\n\nError: ${err.message}\n\nPlease check that no firewall is blocking port ${BACKEND_PORT}.`
    );
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // On Windows and Linux, quit when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});

app.on('activate', () => {
  // macOS: re-create window when dock icon is clicked and no windows are open
  if (mainWindow === null) {
    createWindow();
  }
});

// IPC handler for physical thermal printing only
ipcMain.handle('print-receipt', async (event, htmlContent) => {
  console.log('[Printing] --- New Print Request Received ---');
  
  try {
    // 1. Detect all installed printers
    const printers = await mainWindow.webContents.getPrintersAsync();
    console.log('[Printing] Full Printer Inventory:');
    printers.forEach(p => {
      console.log(`  - Name: "${p.name}", Default: ${p.isDefault}, Status: ${p.status}`);
    });
    
    // 2. Define Virtual Printer keywords for exclusion
    const virtualKeywords = ['pdf', 'xps', 'onenote', 'fax', 'microsoft print', 'wondershare', 'google cloud', 'send to'];
    
    // Helper to check if a printer is physical
    const isPhysical = (p) => {
      const name = p.name.toLowerCase();
      return !virtualKeywords.some(kw => name.includes(kw));
    };

    // 3. New Priority Selection Logic (Supporting All Printer Types)
    let targetPrinter = null;
    let selectionReason = '';

    // Level 1: System Default (if physical)
    // This allows the user to switch between any printer (KPOS or HP) via OS settings
    targetPrinter = printers.find(p => p.isDefault && isPhysical(p));
    if (targetPrinter) selectionReason = 'System default (Physical device)';

    // Level 2: Exact match for "KPOS Printer" (as a strong fallback)
    if (!targetPrinter) {
      targetPrinter = printers.find(p => p.name.toLowerCase() === 'kpos printer');
      if (targetPrinter) selectionReason = 'Exact match for "KPOS Printer" found (not default)';
    }

    // Level 3: Keyboard match (KPOS, Thermal, POS, 80mm)
    if (!targetPrinter) {
      const thermalKeywords = ['kpos', 'thermal', 'pos', '80mm'];
      targetPrinter = printers.find(p => {
        const name = p.name.toLowerCase();
        return isPhysical(p) && thermalKeywords.some(kw => name.includes(kw));
      });
      if (targetPrinter) selectionReason = 'Keyword match (Thermal/POS) found';
    }

    // Level 4: First available Physical Printer
    if (!targetPrinter) {
      targetPrinter = printers.find(isPhysical);
      if (targetPrinter) selectionReason = 'First non-virtual physical printer fallback';
    }

    // 4. Handle "No Printer" state
    if (!targetPrinter) {
      console.error('[Printing] FAILURE: No physical printer detected in inventory.');
      return { success: false, error: 'NO_PHYSICAL_PRINTER' };
    }

    console.log(`[Printing] SELECTION: "${targetPrinter.name}" (Reason: ${selectionReason})`);

    // 5. Create a hidden window for printing
    let printWindow = new BrowserWindow({ 
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });

    // 6. Execute SILENT printing
    return new Promise((resolve) => {
      // Use data URL to avoid file system delays
      printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
      
      printWindow.webContents.on('did-finish-load', async () => {
        // Brief render delay for complex thermal templates
        await new Promise(r => setTimeout(r, 600));

        console.log(`[Printing] ATTEMPT: Sending silent print job to "${targetPrinter.name}"...`);
        
        printWindow.webContents.print({ 
          silent: true, 
          printBackground: true, 
          deviceName: targetPrinter.name 
        }, (success, failureReason) => {
          if (!success) {
            console.error(`[Printing] FAILURE: Print job failed. Reason: ${failureReason}`);
            resolve({ success: false, error: failureReason });
          } else {
            console.log(`[Printing] SUCCESS: Job sent to "${targetPrinter.name}" successfully.`);
            resolve({ success: true });
          }
          
          if (printWindow) {
            printWindow.close();
            printWindow = null;
          }
        });
      });
    });

  } catch (err) {
    console.error('[Printing] CRITICAL ERROR in handler:', err);
    return { success: false, error: err.message };
  }
});

