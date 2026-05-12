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
let lastSilentPrinterName = '';

function getReceiptPaperConfig(printer) {
  const name = String(printer?.name || '').toLowerCase();
  const is80mm = name.includes('80') || name.includes('xp-80') || name.includes('pos-80');
  const widthMm = is80mm ? 80 : 58;
  return {
    widthMm,
    pageWidthMicrons: is80mm ? 80000 : 58000,
    windowWidth: is80mm ? 340 : 250,
    padding: is80mm ? '2.5mm 1.75mm' : '2mm 1.25mm'
  };
}

function isPhysicalPrinter(printer) {
  const name = String(printer?.name || '').toLowerCase();
  const virtualKeywords = [
    'pdf',
    'xps',
    'onenote',
    'fax',
    'microsoft print',
    'wondershare',
    'google cloud',
    'send to'
  ];
  return !!name && !virtualKeywords.some((kw) => name.includes(kw));
}

function pickSilentPrinter(printers) {
  const physicalPrinters = printers.filter(isPhysicalPrinter);
  if (physicalPrinters.length === 0) {
    return { printer: null, reason: 'No physical printer found' };
  }

  if (lastSilentPrinterName) {
    const remembered = physicalPrinters.find((printer) => printer.name === lastSilentPrinterName);
    if (remembered) {
      return { printer: remembered, reason: 'Last successful printer' };
    }
  }

  const exactNameCandidates = ['kpos printer', 'kpos', 'xprinter', 'xp-80', 'xp-58', 'pos-80', 'pos-58'];
  const thermalKeywords = [
    'kpos', 'thermal', 'pos', 'receipt', 'xprinter', 'xp-80', 'xp-58',
    'pos-80', 'pos-58', '80mm', '58mm', 'usb printer'
  ];

  const exactMatch = physicalPrinters.find((printer) =>
    exactNameCandidates.includes(String(printer.name || '').toLowerCase())
  );
  if (exactMatch) {
    return { printer: exactMatch, reason: 'Exact thermal name match' };
  }

  const keywordMatch = physicalPrinters.find((printer) =>
    thermalKeywords.some((kw) => String(printer.name || '').toLowerCase().includes(kw))
  );
  if (keywordMatch) {
    return { printer: keywordMatch, reason: 'Thermal keyword match' };
  }

  const defaultPhysical = physicalPrinters.find((printer) => printer.isDefault);
  if (defaultPhysical) {
    return { printer: defaultPhysical, reason: 'System default' };
  }

  return { printer: physicalPrinters[0], reason: 'Fallback physical printer' };
}

function sanitizeRawReceiptText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[^\x09\x0A\x20-\x7E]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapePowerShellSingleQuotes(text) {
  return String(text || '').replace(/'/g, "''");
}

function extractPowerShellErrorText(stderr, stdout) {
  const combined = String(stderr || stdout || '').trim();
  if (!combined) return '';

  const withoutCliXmlTags = combined
    .replace(/#<\s*CLIXML/gi, '')
    .replace(/<Objs[\s\S]*?<\/Objs>/gi, '')
    .trim();

  return withoutCliXmlTags || combined;
}

async function printRawReceiptWindows(printerName, receiptText) {
  if (process.platform !== 'win32') {
    throw new Error('RAW_PRINT_WINDOWS_ONLY');
  }

  const normalizedText = sanitizeRawReceiptText(receiptText);
  if (!normalizedText) {
    throw new Error('EMPTY_RECEIPT_TEXT');
  }

  const payload = Buffer.concat([
    Buffer.from(`${normalizedText}\n\n\n\n\n`.replace(/\n/g, '\r\n'), 'ascii'),
    Buffer.from([0x1d, 0x56, 0x00])
  ]);

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)]
    public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)]
    public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)]
    public string pDataType;
  }

  [DllImport("winspool.Drv", EntryPoint = "GetDefaultPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool GetDefaultPrinter(System.Text.StringBuilder pszBuffer, ref Int32 pcchBuffer);

  [DllImport("winspool.Drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

  [DllImport("winspool.Drv", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern Int32 StartDocPrinter(IntPtr hPrinter, Int32 level, DOCINFO di);

  [DllImport("winspool.Drv", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, Int32 dwCount, out Int32 dwWritten);
}
"@

try {
  $requestedPrinterName = '${escapePowerShellSingleQuotes(printerName)}'
  $defaultPrinterName = $null
  $requiredLength = 0
  [void][RawPrinterHelper]::GetDefaultPrinter($null, [ref]$requiredLength)
  if ($requiredLength -gt 0) {
    $buffer = New-Object System.Text.StringBuilder $requiredLength
    if ([RawPrinterHelper]::GetDefaultPrinter($buffer, [ref]$requiredLength)) {
      $defaultPrinterName = $buffer.ToString()
    }
  }
  $printerName = if (-not [string]::IsNullOrWhiteSpace($defaultPrinterName)) {
    $defaultPrinterName
  } else {
    $requestedPrinterName
  }
  if ([string]::IsNullOrWhiteSpace($printerName)) {
    throw 'No default printer configured.'
  }

  $data = [Convert]::FromBase64String('${payload.toString('base64')}')
  $docInfo = New-Object RawPrinterHelper+DOCINFO
  $docInfo.pDocName = 'Punjabi University Library Receipt'
  $docInfo.pDataType = 'RAW'

  $printerHandle = [IntPtr]::Zero
  $docStarted = $false
  $pageStarted = $false

  if (-not [RawPrinterHelper]::OpenPrinter($printerName, [ref]$printerHandle, [IntPtr]::Zero)) {
    throw "OpenPrinter failed for '$printerName': $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }

  try {
    $jobId = [RawPrinterHelper]::StartDocPrinter($printerHandle, 1, $docInfo)
    if ($jobId -le 0) {
      throw "StartDocPrinter failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $docStarted = $true

    if (-not [RawPrinterHelper]::StartPagePrinter($printerHandle)) {
      throw "StartPagePrinter failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $pageStarted = $true

    $written = 0
    if (-not [RawPrinterHelper]::WritePrinter($printerHandle, $data, $data.Length, [ref]$written)) {
      throw "WritePrinter failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }

    if ($written -ne $data.Length) {
      throw "WritePrinter wrote $written of $($data.Length) bytes"
    }

    if (-not [RawPrinterHelper]::EndPagePrinter($printerHandle)) {
      throw "EndPagePrinter failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $pageStarted = $false

    if (-not [RawPrinterHelper]::EndDocPrinter($printerHandle)) {
      throw "EndDocPrinter failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $docStarted = $false
  }
  finally {
    if ($pageStarted) {
      [void][RawPrinterHelper]::EndPagePrinter($printerHandle)
    }
    if ($docStarted) {
      [void][RawPrinterHelper]::EndDocPrinter($printerHandle)
    }
    if ($printerHandle -ne [IntPtr]::Zero) {
      [void][RawPrinterHelper]::ClosePrinter($printerHandle)
    }
  }
}
catch {
  [Console]::Out.WriteLine($_.Exception.Message)
  exit 1
}
`;

  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');

  await new Promise((resolve, reject) => {
    let stderr = '';
    let stdout = '';
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedCommand
    ], {
      windowsHide: true
    });

    ps.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    ps.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ps.on('error', reject);
    ps.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(extractPowerShellErrorText(stderr, stdout) || `RAW_PRINT_FAILED_${code}`));
    });
  });
}

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
    } catch (_) { }
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
    useContentSize: true,
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
  mainWindow.webContents.setZoomFactor(1);

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
    if (!mainWindow.isMaximized()) {
      mainWindow.maximize();
    }
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────────
// ─── Printing IPC Handler ───────────────────────────────────────────────────────
// Unified handle for kiosk receipt printing.
// Prefers direct RAW printer writes for instant thermal output and falls back to HTML printing when needed.
async function handleSilentPrint(event, printPayload) {
  console.log('[Printing] --- New Silent Print Request Received ---');
  try {
    const printerSource = event?.sender || mainWindow?.webContents;
    if (!printerSource?.getPrintersAsync) {
      return { success: false, error: 'PRINT_CONTEXT_NOT_READY' };
    }
    const printers = await printerSource.getPrintersAsync();
    const { printer: targetPrinter, reason } = pickSilentPrinter(printers);

    if (!targetPrinter) {
      console.error('[Printing] No physical printer found.');
      return { success: false, error: 'NO_PHYSICAL_PRINTER' };
    }

    console.log(`[Printing] SELECTION: "${targetPrinter.name}" (${reason})`);
    const payload = (printPayload && typeof printPayload === 'object' && !Array.isArray(printPayload))
      ? printPayload
      : { html: printPayload };
    const rawReceiptText = typeof payload.text === 'string' ? payload.text : '';

    if (rawReceiptText.trim()) {
      await printRawReceiptWindows(targetPrinter.name, rawReceiptText);
      lastSilentPrinterName = targetPrinter.name;
      return { success: true, printer: targetPrinter.name, mode: 'raw' };
    }

    const paper = getReceiptPaperConfig(targetPrinter);
    const receiptPrintCss = `<style>
      *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
      @page { size: ${paper.widthMm}mm auto; margin: 0; }
      html, body {
        width: ${paper.widthMm}mm; margin: 0; padding: ${paper.padding};
        font-family: 'Courier New', Courier, monospace; font-size: 15px;
        line-height: 1.35;
        color: #000; background: #fff; -webkit-print-color-adjust: exact;
      }
      #thermal-print-container {
        width: 100%;
        max-width: 100%;
        font-size: 15px;
      }
    </style>`;
    const rawHtml = String(payload.html || '');
    if (!rawHtml.trim()) {
      return { success: false, error: 'EMPTY_RECEIPT_PAYLOAD' };
    }
    const fullHtml = /<html[\s>]/i.test(rawHtml)
      ? rawHtml.replace(/<\/head>/i, `${receiptPrintCss}</head>`)
      : `<!DOCTYPE html><html><head><meta charset="utf-8">${receiptPrintCss}</head><body>${rawHtml}</body></html>`;

    return new Promise((resolve) => {
      let printWindow = new BrowserWindow({
        show: false, width: paper.windowWidth, height: 720,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
      });
      printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);
      printWindow.webContents.on('did-finish-load', async () => {
        await new Promise(r => setTimeout(r, 150));
        printWindow.webContents.print({
          silent: true, printBackground: true, deviceName: targetPrinter.name,
          margins: { marginType: 'none' },
          scaleFactor: 100,
          pageSize: { width: paper.pageWidthMicrons, height: 200000 }
        }, (success, failureReason) => {
          if (success) {
            lastSilentPrinterName = targetPrinter.name;
          }
          try { if (!printWindow.isDestroyed()) printWindow.close(); } catch (_) { }
          resolve(success ? { success: true, printer: targetPrinter.name } : { success: false, error: failureReason });
        });
      });
    });
  } catch (err) {
    console.error('[Printing] Error:', err);
    return { success: false, error: err.message };
  }
}

ipcMain.handle('silent-print', handleSilentPrint);


// Alias for legacy calls
ipcMain.handle('print-receipt', handleSilentPrint);
ipcMain.handle('close-app', async () => {
  isQuitting = true;
  app.quit();
  return { success: true };
});

// ─── App Lifecycle ───────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    startBackend();
    await waitForBackend();
    createWindow();
  } catch (err) {
    console.error('[electron] Startup failed:', err.message);
    dialog.showErrorBox('Initialization Error', `Failed to initialize the application:\n${err.message}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});



