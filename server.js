require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sipCheckin } = require('./sip-client');
const uuidv4 = () => Math.random().toString(36).substring(2, 11).toUpperCase(); 

// Fallback logger since logger.js does not yet exist
const logger = {
  _writeToFile: (level, module, msg, meta) => {
    try {
      const logsDir = path.join(__dirname, 'logs');
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      let file = 'app.log';
      if (level === 'ERROR') file = 'error.log';
      else if (module === 'RFID') file = 'rfid.log';
      const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
      fs.appendFileSync(path.join(logsDir, file), `[${new Date().toISOString()}] [${module}] ${level}: ${msg} ${metaStr}\n`);
    } catch (e) {}
  },
  info: (module, msg, meta = {}) => {
    console.log(`[${module}] INFO: ${msg}`, Object.keys(meta).length ? JSON.stringify(meta) : '');
    logger._writeToFile('INFO', module, msg, meta);
  },
  warn: (module, msg, meta = {}) => {
    console.warn(`[${module}] WARN: ${msg}`, Object.keys(meta).length ? JSON.stringify(meta) : '');
    logger._writeToFile('WARN', module, msg, meta);
  },
  error: (module, msg, meta = {}) => {
    console.error(`[${module}] ERROR: ${msg}`, Object.keys(meta).length ? JSON.stringify(meta) : '');
    logger._writeToFile('ERROR', module, msg, meta);
  },
  log: function(level, module, msg, meta = {}) {
    if (this[level]) this[level](module, msg, meta);
    else this.info(module, msg, meta);
  }
};

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const RFID_DIR = path.join(__dirname, 'rfid-integration');
const RFID_PORT = Number(process.env.RFID_BRIDGE_PORT || 3210);
const RFID_BRIDGE_NAME = 'Mr101RfidBridge';
const RFID_BUILD_SCRIPT = path.join(RFID_DIR, 'build.bat');
const RFID_BUILD_DIR = path.join(RFID_DIR, 'build');

const RFID_EXEC_DIR = process.env.RFID_RESOURCES_DIR || RFID_BUILD_DIR;
const RFID_EXECUTABLE = path.join(RFID_EXEC_DIR, `${RFID_BRIDGE_NAME}.exe`);

logger.info('System', 'Initializing RFID...', {
  RFID_DIR,
  RFID_BUILD_DIR,
  RFID_EXEC_DIR,
  RFID_EXECUTABLE,
  exeExists: fs.existsSync(RFID_EXECUTABLE)
});

const APP_LOG_FILE = path.join(__dirname, 'logs', 'app.log');
const RFID_LOG_FILE = path.join(__dirname, 'logs', 'rfid.log');
const ERROR_LOG_FILE = path.join(__dirname, 'logs', 'error.log');
const KOHA_CONFIG = {
  baseUrl: process.env.KOHA_BASE_URL || 'http://164.52.208.94:82/api/v1',
  username: process.env.KOHA_API_USER || 'jivesna',
  password: process.env.KOHA_API_PASS || 'library@koha123',
  libraryId: process.env.KOHA_LIBRARY_ID || 'CPL'
};

const RFID_STATE = {
  enabled: process.env.ENABLE_RFID !== '0',
  bridgePort: RFID_PORT,
  status: 'disabled',
  lastError: '',
  child: null,
  startup: null,
  compileLog: '',
  disconnectionCount: 0,
  monitorTimer: null
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const RFID_UID_BARCODE_CACHE = new Map();

function normalizeRfidUid(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeItemBarcode(value) {
  return String(value || '').trim();
}

function isUsableRfidBarcode(value) {
  return /^[A-Za-z0-9-]{4,32}$/.test(normalizeItemBarcode(value));
}

function rememberRfidUidBarcode(uid, barcode) {
  const normalizedUid = normalizeRfidUid(uid);
  const normalizedBarcode = normalizeItemBarcode(barcode);

  if (!/^[0-9A-F]{8,}$/.test(normalizedUid) || !isUsableRfidBarcode(normalizedBarcode)) {
    return '';
  }

  RFID_UID_BARCODE_CACHE.set(normalizedUid, normalizedBarcode);
  return normalizedBarcode;
}

function getCachedBarcodeForUid(uid) {
  return RFID_UID_BARCODE_CACHE.get(normalizeRfidUid(uid)) || '';
}

function getCachedUidForBarcode(barcode) {
  const normalizedBarcode = normalizeItemBarcode(barcode);
  if (!normalizedBarcode) {
    return '';
  }

  for (const [uid, cachedBarcode] of RFID_UID_BARCODE_CACHE.entries()) {
    if (cachedBarcode === normalizedBarcode) {
      return uid;
    }
  }

  return '';
}

function resolveItemBarcode(itemBarcode, rfidUid) {
  const normalizedBarcode = normalizeItemBarcode(itemBarcode);
  const cachedBarcode = getCachedBarcodeForUid(rfidUid);

  if (cachedBarcode && (!normalizedBarcode || !isUsableRfidBarcode(normalizedBarcode))) {
    return cachedBarcode;
  }

  return normalizedBarcode || cachedBarcode;
}

function normalizeRfidTag(tag) {
  if (!tag || typeof tag !== 'object') {
    return tag;
  }

  const uid = normalizeRfidUid(tag.uid);
  const bridgeBarcode = normalizeItemBarcode(tag.barcode);
  const cachedBarcode = getCachedBarcodeForUid(uid);
  const hasUsableBridgeBarcode = isUsableRfidBarcode(bridgeBarcode);
  const resolvedBarcode = hasUsableBridgeBarcode ? bridgeBarcode : (cachedBarcode || bridgeBarcode);

  if (uid && resolvedBarcode && resolvedBarcode !== cachedBarcode) {
    rememberRfidUidBarcode(uid, resolvedBarcode);
  }

  return {
    ...tag,
    uid,
    barcode: resolvedBarcode
  };
}

function warmRfidBarcodeCacheFromLogs() {
  try {
    if (!fs.existsSync(APP_LOG_FILE)) {
      return;
    }

    const lines = fs.readFileSync(APP_LOG_FILE, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const jsonStart = line.indexOf('{');
      if (jsonStart === -1) {
        continue;
      }

      try {
        const payload = JSON.parse(line.slice(jsonStart));
        if (!payload || typeof payload !== 'object') {
          continue;
        }

        rememberRfidUidBarcode(payload.uid, payload.barcode);
        rememberRfidUidBarcode(payload.rfidUid, payload.itemBarcode);
      } catch (_) {
      }
    }
  } catch (error) {
    logger.error('RFID', `Barcode cache warmup failed: ${error.message}`, { stack: error.stack });
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function logBackend(event, details = {}) {
  const level = event.includes('error') || event.includes('failed') ? 'error' : 'info';
  const module = event.startsWith('rfid') ? 'RFID' : 'APP';
  logger.log(level, module, `${event}: ${JSON.stringify(details)}`, details);
}

function isImportantBridgeMessage(message) {
  return /MR101 Connected|Auto-AFI write success|Auto-AFI write failed|AFI write success|AFI write failed|No FEIG reader|FEUSB_OpenDevice failed|Failed to map all functions|CRITICAL ERROR|FATAL|Exception|Disconnected/i.test(message);
}

function getBridgeEventName(message, streamName) {
  if (/MR101 Connected/i.test(message)) {
    return 'rfid.reader.connected';
  }
  if (/write success/i.test(message)) {
    return 'rfid.security.write';
  }
  if (/write failed/i.test(message)) {
    return 'rfid.security.error';
  }
  if (/Disconnected/i.test(message)) {
    return 'rfid.bridge.exit';
  }
  if (/No FEIG reader|failed|error|exception|fatal|critical/i.test(message)) {
    return 'rfid.bridge.error';
  }
  return `rfid.${streamName}`;
}

function createBridgeOutputHandler(streamName) {
  let buffer = '';

  return (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const message = rawLine.trim();
      if (!message || !isImportantBridgeMessage(message)) {
        continue;
      }
      const eventName = getBridgeEventName(message, streamName);
      logBackend(eventName, { message });

      // Identify errors proactively so monitoring can handle them
      if (eventName === 'rfid.bridge.error') {
        RFID_STATE.status = 'error';
        RFID_STATE.lastError = message;
      }
    }
  };
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { success: false, message: 'File not found' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream'
    });
    res.end(data);
  });
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error((stderr || stdout || `${command} exited with code ${code}`).trim()));
    });
  });
}

function getLatestMtimeMs(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return 0;
  }

  const stats = fs.statSync(targetPath);
  if (!stats.isDirectory()) {
    return stats.mtimeMs;
  }

  let latest = stats.mtimeMs;
  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    const entryLatest = getLatestMtimeMs(entryPath);
    if (entryLatest > latest) {
      latest = entryLatest;
    }
  }

  return latest;
}

function shouldCompileRfidBridge() {
  if (process.env.RFID_FORCE_REBUILD === '1') {
    return true;
  }

  if (!fs.existsSync(RFID_EXECUTABLE)) {
    return true;
  }

  return false;
}

async function compileRfidBridge() {
  if (!shouldCompileRfidBridge()) {
    RFID_STATE.compileLog = 'Skipped compile: existing bridge executable is up-to-date.';
    return;
  }

  fs.mkdirSync(RFID_BUILD_DIR, { recursive: true });
  const result = await runCommand('cmd.exe', ['/c', RFID_BUILD_SCRIPT], {
    cwd: RFID_DIR
  });

  RFID_STATE.compileLog = `${result.stdout}${result.stderr}`.trim();
}

function proxyRfidRequest(apiPath, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET';
    const payload = options.body ? JSON.stringify(options.body) : null;
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: RFID_PORT,
        path: apiPath,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            }
          : undefined
      },
      (response) => {
        let body = '';

        response.on('data', (chunk) => {
          body += chunk.toString('utf8');
        });

        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            try {
              const errorPayload = JSON.parse(body);
              reject(new Error(errorPayload.message || `RFID bridge responded with status ${response.statusCode}`));
            } catch (_) {
              reject(new Error(`RFID bridge responded with status ${response.statusCode}: ${body}`));
            }
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error('RFID bridge returned invalid JSON'));
          }
        });
      }
    );

    request.on('error', (error) => {
      reject(new Error(`RFID bridge unavailable: ${error.message}`));
    });

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

function isLiveRfidTag(tag) {
  if (!tag || typeof tag !== 'object') {
    return false;
  }

  if (tag.live === true) {
    return true;
  }

  if (typeof tag.live === 'string' && tag.live.toLowerCase() === 'true') {
    return true;
  }

  const lastSeen = Number(tag.lastSeen || 0);
  return Number.isFinite(lastSeen) && lastSeen > 0 && (Date.now() - lastSeen) <= 1000;
}

function filterLiveRfidTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  return tags
    .filter(isLiveRfidTag)
    .sort((left, right) => Number(right?.lastSeen || 0) - Number(left?.lastSeen || 0));
}

async function writeRfidSecurityState({ barcode, uid, afi, state }) {
  if (!RFID_STATE.enabled) {
    return {
      success: false,
      skipped: true,
      message: 'RFID integration is disabled'
    };
  }

  await ensureRfidBridgeStarted();

  let normalizedUid = normalizeRfidUid(uid);
  let normalizedBarcode = normalizeItemBarcode(barcode);
  const normalizedAfi = String(afi || '').trim().toUpperCase();
  const normalizedState = String(state || '').trim();

  if (normalizedUid) {
    normalizedBarcode = resolveItemBarcode(normalizedBarcode, normalizedUid);
  }

  if (!normalizedUid && normalizedBarcode) {
    normalizedUid = getCachedUidForBarcode(normalizedBarcode);
  }

  if (!normalizedBarcode && !normalizedUid) {
    throw new Error('Barcode or UID is required for RFID security update');
  }

  if (!/^[0-9A-F]{2}$/.test(normalizedAfi)) {
    throw new Error('AFI must be a 2-digit hex value');
  }

  if (!normalizedUid) {
    try {
      const visibleTags = filterLiveRfidTags(await proxyRfidRequest('/api/tags')).map(normalizeRfidTag);
      const matchingTag = visibleTags.find((tag) => String(tag.barcode || '').trim() === normalizedBarcode);
      if (matchingTag?.uid) {
        normalizedUid = String(matchingTag.uid).trim().toUpperCase();
      } else if (visibleTags.length === 1 && visibleTags[0]?.uid) {
        normalizedUid = String(visibleTags[0].uid).trim().toUpperCase();
      }
    } catch (_) {
    }
  }

  const params = new URLSearchParams();
  if (normalizedBarcode) params.set('barcode', normalizedBarcode);
  if (normalizedUid) params.set('uid', normalizedUid);
  params.set('afi', normalizedAfi);

  const result = await proxyRfidRequest(`/api/write-afi?${params.toString()}`);
  rememberRfidUidBarcode(normalizedUid, normalizedBarcode);
  logBackend('rfid.security.write', {
    barcode: normalizedBarcode,
    uid: normalizedUid,
    afi: normalizedAfi,
    state: normalizedState,
    result
  });

  return {
    ...result,
    requestedState: normalizedState,
    requestedAfi: normalizedAfi
  };
}

async function handleRfidArm(req, res) {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const afi = reqUrl.searchParams.get('afi') || '';
    if (!afi) {
      sendJson(res, 400, { success: false, message: 'afi query param required' });
      return;
    }
    await ensureRfidBridgeStarted();
    const result = await proxyRfidRequest(`/api/arm?afi=${encodeURIComponent(afi)}`);
    logBackend('rfid.arm', { afi, result });
    sendJson(res, 200, result);
  } catch (error) {
    logBackend('rfid.arm.error', { message: error.message });
    sendJson(res, 500, { success: false, armed: false, message: error.message });
  }
}

async function handleRfidDisarm(req, res) {
  try {
    await ensureRfidBridgeStarted();
    const result = await proxyRfidRequest('/api/disarm');
    logBackend('rfid.disarm', { result });
    sendJson(res, 200, result);
  } catch (error) {
    logBackend('rfid.disarm.error', { message: error.message });
    sendJson(res, 500, { success: false, armed: false, message: error.message });
  }
}

function waitForBridgeReady(timeoutMs = 20000) {
  const startedAt = Date.now();
  const retryIntervalMs = 150;

  return new Promise((resolve, reject) => {
    const check = () => {
      proxyRfidRequest('/api/status')
        .then(resolve)
        .catch((error) => {
          if ((Date.now() - startedAt) >= timeoutMs) {
            reject(error);
            return;
          }
          setTimeout(check, retryIntervalMs);
        });
    };

    check();
  });
}

function startRfidMonitor() {
  if (RFID_STATE.monitorTimer) return;

  RFID_STATE.monitorTimer = setInterval(async () => {
    if (!RFID_STATE.enabled || RFID_STATE.status === 'starting' || RFID_STATE.status === 'compiling' || RFID_STATE.startup) {
      return;
    }

    try {
      if (RFID_STATE.status === 'error' && RFID_STATE.child) {
        logger.info('RFID', 'Cleaning up errored bridge process before restart');
        stopRfidBridge();
        return;
      }

      if (!RFID_STATE.child || RFID_STATE.status !== 'running') {
        await ensureRfidBridgeStarted();
        return;
      }

      const bridgeStatus = await proxyRfidRequest('/api/status');
      let isHardwareConnected = (bridgeStatus.status === 'CONNECTED' || bridgeStatus.connected === true);

      // If the bridge reports a fatal USB error but still claims to be CONNECTED, it's a zombie state.
      if (bridgeStatus.lastError && /Device not open|failed|Disconnected/i.test(bridgeStatus.lastError)) {
        logger.warn('RFID', `Hardware connection lost detected via lastError: ${bridgeStatus.lastError}`);
        isHardwareConnected = false;
      }

      // Eagerly probe the reader hardware to detect "Zombie" connection states
      // where the USB was physically removed but the C++ bridge hasn't crashed.
      if (isHardwareConnected) {
        try {
          // Probe actual tag reading. If USB is gone, this should timeout or throw.
          await proxyRfidRequest('/api/tags');
        } catch (probeError) {
          logger.warn('RFID', `Hardware probe failed, device likely physically unplugged: ${probeError.message}`);
          isHardwareConnected = false;
        }
      }

      if (!isHardwareConnected) {
        RFID_STATE.disconnectionCount++;
        if (RFID_STATE.disconnectionCount >= 2) {
          logger.warn('RFID', 'Attempting bridge restart due to missing hardware response');
          stopRfidBridge();
          RFID_STATE.disconnectionCount = 0;
        }
      } else {
        RFID_STATE.disconnectionCount = 0;
      }
    } catch (error) {
      RFID_STATE.disconnectionCount++;
      if (RFID_STATE.disconnectionCount >= 2) {
        logger.warn('RFID', `Bridge unresponsive, restarting: ${error.message}`);
        stopRfidBridge();
        RFID_STATE.disconnectionCount = 0;
      }
    }
  }, 5000);
}

function stopRfidMonitor() {
  if (RFID_STATE.monitorTimer) {
    clearInterval(RFID_STATE.monitorTimer);
    RFID_STATE.monitorTimer = null;
  }
}

async function ensureRfidBridgeStarted() {
  if (!RFID_STATE.enabled) {
    RFID_STATE.status = 'disabled';
    return;
  }

  if (RFID_STATE.child) {
    return;
  }

  if (RFID_STATE.startup) {
    return RFID_STATE.startup;
  }

  RFID_STATE.startup = (async () => {
    try {
      const existingStatus = await proxyRfidRequest('/api/status');
      RFID_STATE.status = 'running';
      RFID_STATE.lastError = '';
      return existingStatus;
    } catch (_) {
    }

    RFID_STATE.status = 'compiling';
    RFID_STATE.lastError = '';
    logger.info('RFID', 'Compiling RFID bridge...');
    await compileRfidBridge();

    RFID_STATE.status = 'starting';
    logger.info('RFID', `Starting bridge executable: ${RFID_EXECUTABLE}`);
    const child = spawn(RFID_EXECUTABLE, [], {
      cwd: RFID_EXEC_DIR,
      env: {
        ...process.env,
        RFID_BRIDGE_PORT: String(RFID_PORT)
      },
      windowsHide: true
    });

    RFID_STATE.child = child;

    child.stdout.on('data', createBridgeOutputHandler('stdout'));
    child.stderr.on('data', createBridgeOutputHandler('stderr'));

    child.on('exit', (code, signal) => {
      RFID_STATE.child = null;
      RFID_STATE.status = 'stopped';
      RFID_STATE.lastError = `RFID bridge exited (code=${code}, signal=${signal || 'none'})`;
      logger.warn('RFID', `RFID bridge stopped unexpectedly: ${RFID_STATE.lastError}`);
      RFID_STATE.startup = null;
    });

    child.on('error', (error) => {
      RFID_STATE.lastError = error.message;
      logger.error('RFID', `RFID bridge process error: ${error.message}`, { error });
    });

    logger.info('RFID', 'Waiting for bridge to become healthy...');
    await waitForBridgeReady();
    logger.info('RFID', 'RFID bridge is running and healthy');
    RFID_STATE.status = 'running';
  })()
    .catch((error) => {
      RFID_STATE.status = 'error';
      RFID_STATE.lastError = error.message;
      RFID_STATE.child = null;
      throw error;
    })
    .finally(() => {
      RFID_STATE.startup = null;
    });

  return RFID_STATE.startup;
}

function stopRfidBridge() {
  if (RFID_STATE.child) {
    try {
      RFID_STATE.child.kill('SIGTERM');
      const oldChild = RFID_STATE.child;
      setTimeout(() => {
        try { oldChild.kill('SIGKILL'); } catch (_) {}
      }, 1000);
    } catch (_) {}
    RFID_STATE.child = null;
  }
}

function readRecentBackendLogLines(maxLines = 200) {
  try {
    if (!fs.existsSync(APP_LOG_FILE)) {
      return [];
    }

    const lines = fs.readFileSync(APP_LOG_FILE, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean);

    return lines.slice(-maxLines);
  } catch (error) {
    return [`failed to read backend log: ${error.message}`];
  }
}

// Cached koha online state logic from earlier optimizations
let cachedKohaOnline = true;
let lastKohaCheckAt = 0;

async function isKohaReachable() {
  const now = Date.now();
  if (now - lastKohaCheckAt < 10000) {
    return cachedKohaOnline;
  }

  return new Promise((resolve) => {
    const url = new URL(KOHA_CONFIG.baseUrl);
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: '/',
        method: 'HEAD',
        timeout: 2000
      },
      (res) => {
        res.resume();
        cachedKohaOnline = true;
        lastKohaCheckAt = Date.now();
        resolve(true); // Any response means reachable
      }
    );
    request.on('error', () => {
      cachedKohaOnline = false;
      lastKohaCheckAt = Date.now();
      resolve(false);
    });
    request.on('timeout', () => {
      request.destroy();
      cachedKohaOnline = false;
      lastKohaCheckAt = Date.now();
      resolve(false);
    });
    request.end();
  });
}

function kohaRequest(apiPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${KOHA_CONFIG.baseUrl}${apiPath}`);
    const authHeader = 'Basic ' + Buffer.from(`${KOHA_CONFIG.username}:${KOHA_CONFIG.password}`).toString('base64');

    logBackend('koha.request.start', { url: url.toString(), user: KOHA_CONFIG.username });

    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json'
        }
      },
      (response) => {
        let body = '';

        response.on('data', (chunk) => {
          body += chunk.toString('utf8');
        });

        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const err = new Error(`Koha request failed with status ${response.statusCode}: ${body}`);
            err.url = url.toString();
            logBackend('koha.request.error', { url: err.url, statusCode: response.statusCode, responseBody: body });
            reject(err);
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error('Failed to parse Koha response'));
          }
        });
      }
    );

    request.on('error', (error) => {
      reject(new Error(`Koha connection error: ${error.message}`));
    });

    request.end();
  });
}

function kohaPost(apiPath, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${KOHA_CONFIG.baseUrl}${apiPath}`);
    const authHeader = 'Basic ' + Buffer.from(`${KOHA_CONFIG.username}:${KOHA_CONFIG.password}`).toString('base64');
    const body = JSON.stringify(payload || {});

    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (response) => {
        let responseBody = '';

        response.on('data', (chunk) => {
          responseBody += chunk.toString('utf8');
        });

        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(responseBody || `Koha POST failed with status ${response.statusCode}`));
            return;
          }

          try {
            resolve(responseBody ? JSON.parse(responseBody) : {});
          } catch (error) {
            reject(new Error('Failed to parse Koha POST response'));
          }
        });
      }
    );

    request.on('error', (error) => {
      reject(new Error(`Koha POST error: ${error.message}`));
    });

    request.write(body);
    request.end();
  });
}

function parseKohaErrorPayload(rawMessage) {
  const message = String(rawMessage || '').trim();
  if (!message) {
    return {};
  }

  try {
    return JSON.parse(message);
  } catch (_) {
    return {};
  }
}

function isKohaConfirmationError(error) {
  const message = String(error?.message || '').trim();
  if (!message) {
    return false;
  }

  if (/confirmation error/i.test(message)) {
    return true;
  }

  const payload = parseKohaErrorPayload(message);
  return /confirmation error/i.test(String(payload.error || payload.message || ''));
}

function normalizeCollection(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && Array.isArray(payload.value)) {
    return payload.value;
  }

  return [];
}

function findExactMatch(records, fieldName, expectedValue) {
  const target = String(expectedValue || '').trim();
  return records.find((record) => String(record?.[fieldName] || '').trim() === target) || null;
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function extractTitle(record) {
  if (!record || typeof record !== 'object') {
    return '';
  }

  const directTitle = firstNonEmpty([
    record.title,
    record.book_title,
    record.display_title,
    record.subtitle
  ]);
  if (directTitle) {
    return directTitle;
  }

  const nestedCandidates = [
    record.biblio,
    record._strings,
    record.metadata,
    record.result
  ];

  for (const candidate of nestedCandidates) {
    const nestedTitle = extractTitle(candidate);
    if (nestedTitle) {
      return nestedTitle;
    }
  }

  return '';
}

function extractSipField(rawMessage, fieldCode) {
  if (typeof rawMessage !== 'string' || !rawMessage) {
    return '';
  }

  const marker = `|${fieldCode}`;
  const start = rawMessage.indexOf(marker);
  if (start === -1) {
    return '';
  }

  const valueStart = start + marker.length;
  const nextPipe = rawMessage.indexOf('|', valueStart);
  const value = nextPipe === -1
    ? rawMessage.slice(valueStart)
    : rawMessage.slice(valueStart, nextPipe);

  return value.trim();
}

function isUsableSipTitle(value) {
  const title = String(value || '').trim();
  if (!title) {
    return false;
  }

  return !/^#+$/.test(title);
}

async function getItemDetails(itemBarcode) {
  const itemsPayload = await kohaRequest(`/items?external_id=${encodeURIComponent(itemBarcode)}`);
  const items = normalizeCollection(itemsPayload);
  const item = findExactMatch(items, 'external_id', itemBarcode);
  if (!item) {
    return {
      itemBarcode,
      itemTitle: itemBarcode
    };
  }

  let itemTitle = firstNonEmpty([
    extractTitle(item),
    item.external_id,
    itemBarcode
  ]);

  if (item.biblio_id) {
    try {
      const biblio = await kohaRequest(`/biblios/${item.biblio_id}`);
      itemTitle = firstNonEmpty([
        extractTitle(biblio),
        itemTitle
      ]);
    } catch (error) {
      itemTitle = itemTitle;
    }
  }

  return {
    itemBarcode,
    itemTitle
  };
}

async function getItemDetailsById(itemId) {
  if (!itemId) {
    return {
      itemBarcode: '',
      itemTitle: ''
    };
  }

  try {
    const item = await kohaRequest(`/items/${itemId}`);
    let itemTitle = firstNonEmpty([
      extractTitle(item),
      item.external_id,
      String(itemId)
    ]);

    if (item.biblio_id) {
      try {
        const biblio = await kohaRequest(`/biblios/${item.biblio_id}`);
        itemTitle = firstNonEmpty([
          extractTitle(biblio),
          itemTitle
        ]);
      } catch (_) {
      }
    }

    return {
      itemBarcode: firstNonEmpty([
        item.external_id,
        item.barcode,
        ''
      ]),
      itemTitle
    };
  } catch (_) {
    return {
      itemBarcode: '',
      itemTitle: ''
    };
  }
}

async function getCurrentLoanDetails(itemBarcode) {
  const itemsPayload = await kohaRequest(`/items?external_id=${encodeURIComponent(itemBarcode)}`);
  const items = normalizeCollection(itemsPayload);
  const item = findExactMatch(items, 'external_id', itemBarcode);

  if (!item || !item.item_id) {
    return {
      patronName: '',
      patronCardNumber: '',
      fineAmount: 0
    };
  }

  const checkoutQuery = encodeURIComponent(JSON.stringify({
    item_id: item.item_id,
    checkin_date: null
  }));
  const checkoutsPayload = await kohaRequest(`/checkouts?q=${checkoutQuery}`);
  const checkouts = normalizeCollection(checkoutsPayload);
  const activeCheckout = checkouts.find((checkout) => Number(checkout?.item_id) === Number(item.item_id) && checkout?.checkin_date == null);

  if (!activeCheckout || !activeCheckout.patron_id) {
    return {
      patronName: '',
      patronCardNumber: '',
      fineAmount: 0
    };
  }

  let patronName = '';
  let patronCardNumber = '';
  let fineAmount = 0;

  try {
    const patron = await kohaRequest(`/patrons/${activeCheckout.patron_id}`);
    patronName = firstNonEmpty([
      `${patron.firstname || ''} ${patron.surname || ''}`.trim(),
      patron.cardnumber
    ]);
    patronCardNumber = String(patron.cardnumber || '').trim();
  } catch (error) {
    patronName = '';
    patronCardNumber = '';
  }

  try {
    const account = await kohaRequest(`/patrons/${activeCheckout.patron_id}/account`);
    fineAmount = Number(account?.outstanding_debits?.total ?? account?.balance ?? 0) || 0;
  } catch (error) {
    fineAmount = 0;
  }

  return {
    patronName,
    patronCardNumber,
    fineAmount
  };
}

async function getActiveCheckoutForItemId(itemId) {
  if (!itemId) {
    return null;
  }

  const checkoutQuery = encodeURIComponent(JSON.stringify({
    item_id: itemId,
    checkin_date: null
  }));
  const checkoutsPayload = await kohaRequest(`/checkouts?q=${checkoutQuery}`);
  const checkouts = normalizeCollection(checkoutsPayload);
  return checkouts.find((checkout) => Number(checkout?.item_id) === Number(itemId) && checkout?.checkin_date == null) || null;
}

async function getPatronAccountSummary(patronCardNumber) {
  if (patronCardNumber === 'E0040150111266FC') {
    logger.info('Patron', `Demo Map: Treating RFID card as Patron 1 (Koha Admin) for testing.`);
    patronCardNumber = '1';
  }

  logger.info('Patron', `Searching for patron with identifier: ${patronCardNumber}`);
  
  let patron = null;
  let patronsPayload = null;
  try {
     patronsPayload = await kohaRequest(`/patrons?cardnumber=${encodeURIComponent(patronCardNumber)}`);
     const initialPatrons = normalizeCollection(patronsPayload);
     patron = findExactMatch(initialPatrons, 'cardnumber', patronCardNumber);
  } catch (exactError) {
     logger.error('Patron', `Exact search failed (Koha 500?): ${exactError.message}`);
  }

  if (!patron) {
    logger.info('Patron', `Exact cardnumber match failed for ${patronCardNumber}. Trying broad search...`);
    try {
        patronsPayload = await kohaRequest(`/patrons?q=${encodeURIComponent(patronCardNumber)}`);
        const broadPatrons = normalizeCollection(patronsPayload);
        
        patron = broadPatrons.find(p => 
          String(p.cardnumber || '').trim().toUpperCase() === patronCardNumber.toUpperCase() ||
          String(p.userid || '').trim().toUpperCase() === patronCardNumber.toUpperCase()
        );
    } catch (searchError) {
        logger.error('Patron', `Broad search failed for ${patronCardNumber} (Koha 500?). Error: ${searchError.message}`);
    }
  }

  if (!patron) {
    logger.warn('Patron', `Zero patrons found for identifier: ${patronCardNumber}`);
    throw new Error(`No patron found with card number ${patronCardNumber}`);
  }

  logger.info('Patron', `Patron found: ${patron.firstname} ${patron.surname} (ID: ${patron.patron_id})`);

  let fineAmount = 0;
  try {
    const account = await kohaRequest(`/patrons/${patron.patron_id}/account`);
    fineAmount = Number(account?.outstanding_debits?.total ?? account?.balance ?? 0) || 0;
  } catch (_) {
    fineAmount = 0;
  }

  const checkoutsQuery = encodeURIComponent(JSON.stringify({
    patron_id: patron.patron_id,
    checkin_date: null
  }));
  const checkoutsPayload = await kohaRequest(`/checkouts?q=${checkoutsQuery}`);
  const checkouts = normalizeCollection(checkoutsPayload)
    .filter((checkout) => Number(checkout?.patron_id) === Number(patron.patron_id) && checkout?.checkin_date == null);

  const loans = await Promise.all(checkouts.map(async (checkout) => {
    const itemId = checkout?.item_id;
    const itemDetails = itemId
      ? await getItemDetailsById(itemId)
      : { itemBarcode: '', itemTitle: '' };

    return {
      itemBarcode: firstNonEmpty([
        itemDetails.itemBarcode,
        checkout?.external_id,
        checkout?.barcode,
        itemId ? String(itemId) : ''
      ]),
      itemTitle: firstNonEmpty([
        itemDetails.itemTitle,
        extractTitle(checkout),
        checkout?.title,
        checkout?.external_id,
        itemId ? `Item ${itemId}` : 'Issued Item'
      ]),
      dueDate: firstNonEmpty([
        checkout?.due_date,
        checkout?.date_due,
        ''
      ])
    };
  }));

  let holds = [];
  try {
    const holdsPayload = await kohaRequest(`/holds?patron_id=${patron.patron_id}`);
    const rawHolds = normalizeCollection(holdsPayload);
    holds = await Promise.all(rawHolds.filter(h => !h.cancellation_date).map(async (h) => {
      let title = `Item ${h.item_id || h.biblio_id}`;
      if (h.biblio_id) {
        try {
          const bib = await kohaRequest(`/biblios/${h.biblio_id}`);
          title = extractTitle(bib) || title;
        } catch (_) {}
      }
      return {
        holdId: h.hold_id,
        biblioId: h.biblio_id,
        itemId: h.item_id,
        title,
        queuePosition: h.priority || 1,
        status: h.found === 'W' ? 'Ready for Pickup' : h.found === 'T' ? 'In Transit' : 'On Hold',
        pickupDeadline: h.expirationdate || 'N/A',
        pickupLibrary: h.pickup_library_id || ''
      };
    }));
  } catch (holdError) {
    logger.warn('Account', `Could not fetch holds: ${holdError.message}`);
  }

  return {
    patronCardNumber,
    patronName: firstNonEmpty([
      `${patron.firstname || ''} ${patron.surname || ''}`.trim(),
      patron.cardnumber
    ]),
    fineAmount,
    loans,
    holds
  };
}

async function handleSearch(req, res) {
  // Add this line to create a fake error: // DEBUG_TEST
  // throw new Error("DEBUG_TEST: This is a manual crash for testing the logger!");

  const requestId = uuidv4();
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const query = String(reqUrl.searchParams.get('q') || '').trim().toLowerCase();

    if (!query) {
      logger.warn('Search', 'Search query is missing', { requestId });
      sendJson(res, 400, { success: false, message: 'Search query is required' });
      return;
    }

    logger.info('Search', `[START] Book search initiated for: "${query}"`, { requestId });
    
    logger.info('Database', 'Fetching bibliography list from Koha', { requestId });
    const searchPayload = await kohaRequest('/biblios?_per_page=1000');
    const biblios = Array.isArray(searchPayload) ? searchPayload : [];
    
    logger.info('Search', `Filtering ${biblios.length} records for matches`, { requestId });
    const matchedBiblios = biblios.filter(b => {
      const title = String(b.title || '').toLowerCase();
      const author = String(b.author || '').toLowerCase();
      const isbn = String(b.isbn || '').toLowerCase();
      return title.includes(query) || author.includes(query) || isbn.includes(query);
    });
    
    const results = matchedBiblios.slice(0, 50).map(b => ({
      title: b.title,
      author: b.author,
      barcode: b.external_id || b.isbn || 'N/A',
      status: 'available'
    }));

    logger.info('Search', `[SUCCESS] Found ${results.length} matches`, { requestId });
    sendJson(res, 200, { success: true, data: results });
  } catch (error) {
    logger.error('Search', `[FAIL] Search failed: ${error.message}`, { requestId, error });
    
    logger.info('Search', 'Switching to offline fallback search results', { requestId });
    const mockDb = [
        { barcode: '123456789', title: 'Introduction to Programming', author: 'John Smith', status: 'available' },
        { barcode: '987654321', title: 'Advanced Algorithms', author: 'Jane Doe', status: 'available' },
        { barcode: '111222333', title: 'Database Design', author: 'Bob Johnson', status: 'available' },
        { barcode: '444555666', title: 'Web Development', author: 'Alice Williams', status: 'checked_out' }
    ];
    const results = mockDb.filter(i => 
        i.title.toLowerCase().includes(query) || 
        i.author.toLowerCase().includes(query) ||
        i.barcode.includes(query)
    );
    
    sendJson(res, 200, { success: true, data: results, fallback: true, error: error.message });
  }
}

async function handleAccount(req, res) {
  const requestId = uuidv4();
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const patronCardNumber = String(reqUrl.searchParams.get('cardnumber') || '').trim();

    if (!patronCardNumber) {
      logger.warn('Account', 'Card number missing in account request', { requestId });
      sendJson(res, 400, {
        success: false,
        message: 'cardnumber query param is required'
      });
      return;
    }

    logger.info('Account', `[START] Fetching account details for Patron: ${patronCardNumber}`, { requestId });
    const data = await getPatronAccountSummary(patronCardNumber);
    logger.info('Account', `[SUCCESS] Account details retrieved for ${data.patronName}`, {
      requestId,
      patronCardNumber,
      loansCount: data.loans.length,
      fineAmount: data.fineAmount
    });

    sendJson(res, 200, {
      success: true,
      data
    });
  } catch (error) {
    logger.error('Account', `[FAIL] Account retrieval failed: ${error.message}`, { requestId, error });
    const statusCode = /No patron found/i.test(error.message) ? 404 : 500;
    sendJson(res, statusCode, {
      success: false,
      message: error.message || 'Unable to fetch account details'
    });
  }
}

async function handlePlaceHold(req, res) {
  const requestId = uuidv4();
  try {
    const body = await parseRequestBody(req);
    const patronCardNumber = String(body.patronCardNumber || '').trim();
    const barcode = String(body.barcode || '').trim();

    if (!patronCardNumber || !barcode) {
      sendJson(res, 400, { success: false, message: 'Card number and barcode are required' });
      return;
    }

    logger.info('Hold', `[START] Placing hold for ${patronCardNumber} on ${barcode}`, { requestId });

    // Find Patron
    let patronsPayload = await kohaRequest(`/patrons?cardnumber=${encodeURIComponent(patronCardNumber)}`);
    let patrons = normalizeCollection(patronsPayload);
    let patron = findExactMatch(patrons, 'cardnumber', patronCardNumber);
    if (!patron) {
      patronsPayload = await kohaRequest(`/patrons?q=${encodeURIComponent(patronCardNumber)}`);
      patrons = normalizeCollection(patronsPayload);
      patron = patrons.find(p => String(p.cardnumber || '').trim() === patronCardNumber) || null;
    }
    if (!patron) {
      sendJson(res, 404, { success: false, message: 'Patron not found' });
      return;
    }

    // Find item
    const itemsPayload = await kohaRequest(`/items?external_id=${encodeURIComponent(barcode)}`);
    const items = normalizeCollection(itemsPayload);
    const item = findExactMatch(items, 'external_id', barcode) || items[0];
    if (!item) {
      sendJson(res, 404, { success: false, message: 'Item not found' });
      return;
    }

    const holdPayload = {
      patron_id: patron.patron_id,
      biblio_id: item.biblio_id,
      pickup_library_id: KOHA_CONFIG.libraryId || 'CPL'
    };

    const response = await kohaPost('/holds', holdPayload);
    logger.info('Hold', `[SUCCESS] Hold placed for ${patronCardNumber}`, { requestId, holdId: response.hold_id });
    sendJson(res, 200, { success: true, message: 'Hold placed successfully', hold: response });
  } catch (error) {
    logger.error('Hold', `[FAIL] Failed to place hold: ${error.message}`, { requestId });
    sendJson(res, 500, { success: false, message: error.message || 'Failed to place hold' });
  }
}

async function handleCheckout(req, res) {
  const requestId = uuidv4();
  try {
    const body = await parseRequestBody(req);
    const patronCardNumber = String(body.patronCardNumber || '').trim();
    const rfidUid = normalizeRfidUid(body.rfidUid);
    const submittedBarcode = normalizeItemBarcode(body.itemBarcode);
    const itemBarcode = resolveItemBarcode(submittedBarcode, rfidUid);

    logger.info('Checkout', `[START] Checkout initiated for Patron: ${patronCardNumber}, Item: ${itemBarcode}`, {
      requestId,
      patronCardNumber,
      itemBarcode,
      rfidUid
    });

    if (!patronCardNumber || !itemBarcode) {
      logger.warn('Checkout', '[FAIL] Missing required fields for checkout', { requestId, patronCardNumber, itemBarcode });
      sendJson(res, 400, {
        success: false,
        message: 'Patron card number and item barcode are required'
      });
      return;
    }

    logger.info('Patron', `Searching for patron: ${patronCardNumber}`, { requestId });
    let patronsPayload = await kohaRequest(`/patrons?cardnumber=${encodeURIComponent(patronCardNumber)}`);
    let patrons = normalizeCollection(patronsPayload);
    let patron = findExactMatch(patrons, 'cardnumber', patronCardNumber);
    if (!patron) {
      logger.warn('Patron', `Patron not found: ${patronCardNumber}`, { requestId });
      sendJson(res, 404, {
        success: false,
        message: `No patron found with card number ${patronCardNumber}`
      });
      return;
    }
    logger.info('Patron', `Patron identified: ${patron.firstname} ${patron.surname}`, { requestId, patronId: patron.patron_id });

    logger.info('Database', `Fetching item details: ${itemBarcode}`, { requestId });
    const itemsPayload = await kohaRequest(`/items?external_id=${encodeURIComponent(itemBarcode)}`);
    const items = normalizeCollection(itemsPayload);
    const item = findExactMatch(items, 'external_id', itemBarcode);
    if (!item) {
      logger.warn('Database', `Item not found: ${itemBarcode}`, { requestId });
      sendJson(res, 404, {
        success: false,
        message: `No item found with barcode ${itemBarcode}`
      });
      return;
    }
    const itemDetails = await getItemDetails(itemBarcode);
    const libraryId = firstNonEmpty([
      item.home_library_id,
      item.holding_library_id,
      KOHA_CONFIG.libraryId
    ]);

    logger.info('Checkout', `Registering checkout in Koha for Item: ${item.item_id}`, { requestId });
    let checkout = null;
    try {
      checkout = await kohaPost('/checkouts', {
        patron_id: patron.patron_id,
        item_id: item.item_id,
        library_id: libraryId
      });
      logger.info('Checkout', 'Database transaction successful', { requestId, checkoutId: checkout.checkout_id });
    } catch (postError) {
      if (!isKohaConfirmationError(postError)) {
        logger.error('Checkout', `Database transaction failed: ${postError.message}`, { requestId, error: postError });
        throw postError;
      }

      logger.warn('Checkout', 'Koha returned confirmation error, attempting recovery...', { requestId });
      const activeCheckout = await getActiveCheckoutForItemId(item.item_id);
      const samePatronLoan = activeCheckout && Number(activeCheckout.patron_id) === Number(patron.patron_id);
      if (!samePatronLoan) {
        logger.error('Checkout', 'Recovery failed: item checked out by different patron', { requestId });
        throw postError;
      }

      checkout = activeCheckout;
      logger.info('Checkout', 'Recovery successful: existing loan found for same patron', { requestId });
    }

    let securityUpdate = null;
    try {
      logger.info('RFID', `[WRITE] Attempting security update (AFI: 00) for Barcode: ${itemBarcode}`, { requestId, uid: rfidUid });
      securityUpdate = await writeRfidSecurityState({
        barcode: itemBarcode,
        uid: rfidUid,
        afi: '00',
        state: 'Unsecure'
      });
      
      if (securityUpdate.success) {
        logger.info('RFID', 'RFID write successful', { requestId, result: securityUpdate });
      } else {
        logger.warn('RFID', `RFID write failed: ${securityUpdate.message}`, { requestId, result: securityUpdate });
      }
    } catch (securityError) {
      securityUpdate = {
        success: false,
        message: securityError.message
      };
      logger.error('RFID', `RFID write error: ${securityError.message}`, { requestId, error: securityError });
    }

    sendJson(res, 200, {
      success: true,
      message: 'Item checked out successfully',
      data: {
        checkoutId: checkout.checkout_id,
        patronCardNumber,
        patronName: `${patron.firstname || ''} ${patron.surname || ''}`.trim(),
        itemBarcode,
        itemTitle: itemDetails.itemTitle,
        checkoutDate: checkout.checkout_date || new Date().toISOString(),
        dueDate: checkout.due_date || '',
        securityUpdate
      },
      securityUpdate
    });
    
    rememberRfidUidBarcode(rfidUid, itemBarcode);
    logger.info('Checkout', `[SUCCESS] Checkout completed for Item: ${itemBarcode}`, { requestId });
  } catch (error) {
    logger.error('Checkout', `[CRITICAL] Checkout process failed: ${error.message}`, { requestId, stack: error.stack });
    sendJson(res, 500, {
      success: false,
      message: error.message || 'Checkout failed'
    });
  }
}


async function handleCheckin(req, res) {
  const requestId = uuidv4();
  try {
    const body = await parseRequestBody(req);
    const rfidUid = normalizeRfidUid(body.rfidUid);
    const submittedBarcode = normalizeItemBarcode(body.itemBarcode);
    const itemBarcode = resolveItemBarcode(submittedBarcode, rfidUid);

    logger.info('Checkin', `[START] Check-in initiated for Item: ${itemBarcode}`, {
      requestId,
      itemBarcode,
      rfidUid
    });

    if (!itemBarcode) {
      logger.warn('Checkin', '[FAIL] Missing item barcode for check-in', { requestId });
      sendJson(res, 400, {
        success: false,
        message: 'Book number is required'
      });
      return;
    }

    logger.info('Database', `Fetching item details: ${itemBarcode}`, { requestId });
    const itemDetails = await getItemDetails(itemBarcode);
    
    let loanDetails = {
      patronName: '',
      patronCardNumber: '',
      fineAmount: 0
    };
    try {
      logger.info('Database', `Looking up current loan for: ${itemBarcode}`, { requestId });
      loanDetails = await getCurrentLoanDetails(itemBarcode);
      if (loanDetails.patronCardNumber) {
        logger.info('Database', `Active loan found for Patron: ${loanDetails.patronCardNumber}`, { requestId });
      } else {
        logger.warn('Database', 'No active loan found for this item', { requestId });
      }
    } catch (loanError) {
      logger.error('Database', `Loan lookup failed: ${loanError.message}`, { requestId, error: loanError });
    }

    logger.info('SIP2', `[ACTION] Sending check-in command for: ${itemBarcode}`, { requestId });
    const result = await sipCheckin(itemBarcode);
    
    if (!result.ok) {
      logger.error('SIP2', `[FAIL] SIP2 check-in failed for ${itemBarcode}`, { requestId, response: result });
      sendJson(res, 500, {
        success: false,
        message: result.message || 'SIP2 check-in failed',
        raw: result.raw
      });
      return;
    }
    logger.info('SIP2', `[SUCCESS] SIP2 check-in confirmed for: ${itemBarcode}`, { requestId });

    const sipTitleCandidate = extractSipField(result.raw, 'AJ');
    const sipTitle = isUsableSipTitle(sipTitleCandidate)
      ? sipTitleCandidate
      : '';

    const finalTitle = firstNonEmpty([
      itemDetails.itemTitle,
      sipTitle,
      extractSipField(result.raw, 'AB'),
      itemBarcode
    ]);

    let securityUpdate = null;
    try {
      logger.info('RFID', `[WRITE] Attempting security update (AFI: 90) for Barcode: ${itemBarcode}`, { requestId, uid: rfidUid });
      securityUpdate = await writeRfidSecurityState({
        barcode: itemBarcode,
        uid: rfidUid,
        afi: '90',
        state: 'Secure'
      });
      
      if (securityUpdate.success) {
        logger.info('RFID', 'RFID write successful', { requestId, result: securityUpdate });
      } else {
        logger.warn('RFID', `RFID write failed: ${securityUpdate.message}`, { requestId, result: securityUpdate });
      }
    } catch (securityError) {
      securityUpdate = {
        success: false,
        message: securityError.message
      };
      logger.error('RFID', `RFID write error: ${securityError.message}`, { requestId, error: securityError });
    }

    sendJson(res, 200, {
      success: true,
      message: 'Book checked in successfully',
      data: {
        itemBarcode: itemDetails.itemBarcode,
        itemTitle: finalTitle,
        patronName: loanDetails.patronName,
        patronCardNumber: loanDetails.patronCardNumber,
        fineAmount: loanDetails.fineAmount,
        checkinDate: new Date().toISOString(),
        raw: result.raw,
        securityUpdate
      },
      securityUpdate
    });
    
    rememberRfidUidBarcode(rfidUid, itemBarcode);
    logger.info('Checkin', `[SUCCESS] Check-in completed for Item: ${itemBarcode}`, { requestId });
  } catch (error) {
    logger.error('Checkin', `[CRITICAL] Check-in process failed: ${error.message}`, { requestId, stack: error.stack });
    sendJson(res, 500, {
      success: false,
      message: error.message || 'Check-in failed'
    });
  }
}


async function handleRfidStatus(res) {
  try {
    if (!RFID_STATE.enabled) {
      sendJson(res, 200, {
        enabled: false,
        bridge: 'disabled',
        message: 'RFID integration is disabled'
      });
      return;
    }

    await ensureRfidBridgeStarted();
    const bridgeStatus = await proxyRfidRequest('/api/status');
    sendJson(res, 200, {
      enabled: true,
      bridge: RFID_STATE.status,
      bridgePort: RFID_PORT,
      ...bridgeStatus
    });
  } catch (error) {
    sendJson(res, 503, {
      enabled: RFID_STATE.enabled,
      bridge: RFID_STATE.status,
      bridgePort: RFID_PORT,
      lastError: RFID_STATE.lastError || error.message,
      compileLog: RFID_STATE.compileLog
    });
  }
}

async function handleRfidTags(res) {
  try {
    if (!RFID_STATE.enabled) {
      sendJson(res, 200, []);
      return;
    }

    await ensureRfidBridgeStarted();
    const tags = filterLiveRfidTags(await proxyRfidRequest('/api/tags')).map(normalizeRfidTag);
    
    if (tags.length > 0) {
      logger.info('RFID', `Detected ${tags.length} tag(s) on reader`, { tags });
    }
    
    sendJson(res, 200, tags);
  } catch (error) {
    logger.error('RFID', `Tag polling failed: ${error.message}`);
    sendJson(res, 503, {
      success: false,
      message: RFID_STATE.lastError || error.message
    });
  }
}

async function handleRfidSecurity(req, res) {
  try {
    const body = await parseRequestBody(req);
    const state = String(body.state || '').trim().toLowerCase();
    const barcode = String(body.barcode || '').trim();
    const uid = String(body.uid || '').trim();

    const afiMap = {
      secure: '90',
      unsecure: '00'
    };

    const afi = body.afi ? String(body.afi).trim().toUpperCase() : afiMap[state];
    logBackend('rfid.security.request', { state, barcode, uid, afi });

    if (!afi) {
      sendJson(res, 400, {
        success: false,
        message: 'state must be Secure or Unsecure, or provide afi directly'
      });
      return;
    }

    const result = await writeRfidSecurityState({
      barcode,
      uid,
      afi,
      state: state || (afi === '90' ? 'secure' : afi === '00' ? 'unsecure' : '')
    });

    sendJson(res, 200, result);
  } catch (error) {
    const message = error.message || 'RFID security update failed';
    const statusCode = /responded with status 503|bridge unavailable|reader/i.test(message) ? 503 : 500;
    logBackend('rfid.security.error', { message, statusCode });

    sendJson(res, statusCode, {
      success: false,
      message
    });
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/status') {
    const isOnline = await isKohaReachable();
    let rfidConnected = false;
    
    if (RFID_STATE.status === 'running') {
      try {
        const bridgeStatus = await proxyRfidRequest('/api/status');
        rfidConnected = (bridgeStatus.status === 'CONNECTED' || bridgeStatus.connected === true);
        
        if (bridgeStatus.lastError && /Device not open|failed|Disconnected/i.test(bridgeStatus.lastError)) {
          rfidConnected = false;
        }
        
        if (rfidConnected) {
          try {
            await proxyRfidRequest('/api/tags');
          } catch (_) {
            rfidConnected = false;
          }
        }
      } catch (_) {}
    }

    sendJson(res, 200, {
      status: 'ok',
      service: 'finalpUI-checkin',
      port: PORT,
      online: isOnline,
      rfid: {
        enabled: RFID_STATE.enabled,
        state: RFID_STATE.status,
        connected: rfidConnected,
        bridgePort: RFID_PORT,
        lastError: RFID_STATE.lastError
      }
    });
    return;
  }


  if (req.method === 'GET' && reqUrl.pathname === '/api/rfid/status') {
    await handleRfidStatus(res);
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/search') {
    await handleSearch(req, res);
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/account') {
    await handleAccount(req, res);
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/debug/logs') {
    sendJson(res, 200, {
      success: true,
      logFile: APP_LOG_FILE,
      lines: readRecentBackendLogLines(Number(reqUrl.searchParams.get('lines') || 200))
    });
    return;
  }

  if (req.method === 'GET' && (reqUrl.pathname === '/api/rfid/tags' || reqUrl.pathname === '/api/tags')) {
    await handleRfidTags(res);
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/rfid/security') {
    await handleRfidSecurity(req, res);
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/rfid/arm') {
    await handleRfidArm(req, res);
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/rfid/disarm') {
    await handleRfidDisarm(req, res);
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/checkout') {
    await handleCheckout(req, res);
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/checkin') {
    await handleCheckin(req, res);
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/hold') {
    await handlePlaceHold(req, res);
    return;
  }

  if (req.method === 'GET') {
    const filePath = path.join(PUBLIC_DIR, reqUrl.pathname === '/' ? 'index.html' : reqUrl.pathname);
    const normalized = path.normalize(filePath);

    if (!normalized.startsWith(PUBLIC_DIR)) {
      sendJson(res, 403, { success: false, message: 'Forbidden' });
      return;
    }

    fs.stat(normalized, (err, stats) => {
      if (!err && stats.isDirectory()) {
        serveFile(res, path.join(normalized, 'index.html'));
        return;
      }

      serveFile(res, normalized);
    });
    return;
  }

  sendJson(res, 404, { success: false, message: 'Not found' });
});

warmRfidBarcodeCacheFromLogs();
startRfidMonitor();

ensureRfidBridgeStarted().catch((error) => {
  logger.warn('RFID', `Startup skipped: ${error.message}`);
});

process.on('exit', () => {
  stopRfidMonitor();
  stopRfidBridge();
});
process.on('SIGINT', () => {
  stopRfidMonitor();
  stopRfidBridge();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopRfidMonitor();
  stopRfidBridge();
  process.exit(0);
});

server.listen(PORT, () => {
  logger.info('System', `finalpUI running at http://localhost:${PORT}`);
  logger.info('System', 'Open the page, press Check-In, enter the book number, or use RFID when the reader is connected.');
});
