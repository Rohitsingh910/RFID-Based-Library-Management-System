require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { sipCheckin } = require('./sip-client');
const crypto = require('crypto');
let PDFDocument;
try { PDFDocument = require('pdfkit'); } catch (_) { PDFDocument = null; }
const uuidv4 = () => Math.random().toString(36).substring(2, 11).toUpperCase(); 

// Fallback logger
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

const APP_LOG_FILE = path.join(__dirname, 'logs', 'app.log');
const RFID_LOG_FILE = path.join(__dirname, 'logs', 'rfid.log');
const ERROR_LOG_FILE = path.join(__dirname, 'logs', 'error.log');
const KOHA_CONFIG = {
  baseUrl: process.env.KOHA_BASE_URL || 'http://103.86.177.6:92/api/v1',
  username: process.env.KOHA_API_USER || 'rfid',
  password: process.env.KOHA_API_PASS || 'Rfid@#123',
  libraryId: process.env.KOHA_LIBRARY_ID || 'PUPCL'
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
  monitorTimer: null,
  hardwareConnected: false
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

// --- RFID Utilities ---
function normalizeRfidUid(value) { return String(value || '').trim().toUpperCase(); }
function normalizeItemBarcode(value) { return String(value || '').trim(); }
function isUsableRfidBarcode(value) { return /^[A-Za-z0-9-]{4,32}$/.test(normalizeItemBarcode(value)); }

function rememberRfidUidBarcode(uid, barcode) {
  const nUid = normalizeRfidUid(uid), nBc = normalizeItemBarcode(barcode);
  if (!/^[0-9A-F]{8,}$/.test(nUid) || !isUsableRfidBarcode(nBc)) return '';
  RFID_UID_BARCODE_CACHE.set(nUid, nBc);
  return nBc;
}

function getCachedBarcodeForUid(uid) { return RFID_UID_BARCODE_CACHE.get(normalizeRfidUid(uid)) || ''; }
function getCachedUidForBarcode(barcode) {
  const nBc = normalizeItemBarcode(barcode);
  if (!nBc) return '';
  for (const [uid, cachedBc] of RFID_UID_BARCODE_CACHE.entries()) if (cachedBc === nBc) return uid;
  return '';
}

function resolveItemBarcode(itemBarcode, rfidUid) {
  const nBc = normalizeItemBarcode(itemBarcode), cBc = getCachedBarcodeForUid(rfidUid);
  if (cBc && (!nBc || !isUsableRfidBarcode(nBc))) return cBc;
  return nBc || cBc;
}

function normalizeRfidTag(tag) {
  if (!tag || typeof tag !== 'object') return tag;
  const uid = normalizeRfidUid(tag.uid), bBc = normalizeItemBarcode(tag.barcode), cBc = getCachedBarcodeForUid(uid);
  const resBc = isUsableRfidBarcode(bBc) ? bBc : (cBc || bBc);
  if (uid && resBc && resBc !== cBc) rememberRfidUidBarcode(uid, resBc);
  // Enrich for frontend rfid-service.js expectations
  return { 
    ...tag, 
    uid, 
    barcode: resBc, 
    live: true, 
    lastSeen: tag.lastSeen || 0,
    afiWriteAttempted: tag.afiWriteAttempted ?? true 
  };
}

function warmRfidBarcodeCacheFromLogs() {
  try {
    if (!fs.existsSync(APP_LOG_FILE)) return;
    const lines = fs.readFileSync(APP_LOG_FILE, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const start = line.indexOf('{');
      if (start === -1) continue;
      try {
        const p = JSON.parse(line.slice(start));
        if (p && typeof p === 'object') {
          rememberRfidUidBarcode(p.uid, p.barcode);
          rememberRfidUidBarcode(p.rfidUid, p.itemBarcode);
        }
      } catch (_) {}
    }
  } catch (e) { logger.error('RFID', `Cache warmup failed: ${e.message}`); }
}

// --- Server Utilities ---
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(body);
}

function logBackend(event, details = {}) {
  const level = event.includes('error') || event.includes('failed') ? 'error' : 'info';
  const module = event.startsWith('rfid') ? 'RFID' : 'APP';
  logger.log(level, module, `${event}: ${JSON.stringify(details)}`, details);
}

function isImportantBridgeMessage(msg) { return /MR101 Connected|Auto-AFI write success|Auto-AFI write failed|AFI write success|AFI write failed|No FEIG reader|FEUSB_OpenDevice failed|Failed to map all functions|CRITICAL ERROR|FATAL|Exception|Disconnected/i.test(msg); }
function getBridgeEventName(msg, stream) {
  if (/MR101 Connected/i.test(msg)) return 'rfid.reader.connected';
  if (/write success/i.test(msg)) return 'rfid.security.write';
  if (/write failed/i.test(msg)) return 'rfid.security.error';
  if (/Disconnected/i.test(msg)) return 'rfid.bridge.exit';
  if (/No FEIG reader|failed|error|exception|fatal|critical/i.test(msg)) return 'rfid.bridge.error';
  return `rfid.${stream}`;
}

function createBridgeOutputHandler(stream) {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) {
      const msg = line.trim();
      if (!msg || !isImportantBridgeMessage(msg)) continue;
      const ev = getBridgeEventName(msg, stream);
      logBackend(ev, { message: msg });
      if (ev === 'rfid.reader.connected') { RFID_STATE.hardwareConnected = true; }
      if (ev === 'rfid.bridge.error') { 
        RFID_STATE.status = 'error'; 
        RFID_STATE.lastError = msg; 
        if (/No FEIG reader|Device not open|Disconnected|FEUSB_OpenDevice/i.test(msg)) {
          RFID_STATE.hardwareConnected = false;
        }
      }
    }
  };
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { success: false, message: 'File not found' });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); if (body.length > 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); } });
    req.on('end', () => { if (!body) return resolve({}); try { resolve(JSON.parse(body)); } catch (_) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || process.env, windowsHide: true });
    let so = '', se = '';
    child.stdout.on('data', (c) => so += c.toString('utf8'));
    child.stderr.on('data', (c) => se += c.toString('utf8'));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ stdout: so, stderr: se }) : reject(new Error((se || so || `${cmd} failed`).trim())));
  });
}

// --- RFID Bridge Management ---
function shouldCompileRfidBridge() { return process.env.RFID_FORCE_REBUILD === '1' || !fs.existsSync(RFID_EXECUTABLE); }
async function compileRfidBridge() {
  if (!shouldCompileRfidBridge()) { RFID_STATE.compileLog = 'Skipped: up-to-date.'; return; }
  fs.mkdirSync(RFID_BUILD_DIR, { recursive: true });
  const res = await runCommand('cmd.exe', ['/c', RFID_BUILD_SCRIPT], { cwd: RFID_DIR });
  RFID_STATE.compileLog = `${res.stdout}${res.stderr}`.trim();
}

function proxyRfidRequest(apiPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const method = opts.method || 'GET', payload = opts.body ? JSON.stringify(opts.body) : null;
    const req = http.request({ hostname: '127.0.0.1', port: RFID_PORT, path: apiPath, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : undefined }, (res) => {
      let b = '';
      res.on('data', (c) => b += c.toString('utf8'));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { try { reject(new Error(JSON.parse(b).message || `Status ${res.statusCode}`)); } catch (_) { reject(new Error(`Status ${res.statusCode}: ${b}`)); } return; }
        try { resolve(JSON.parse(b)); } catch (_) { reject(new Error('Invalid JSON from bridge')); }
      });
    });
    req.on('error', (e) => {
      RFID_STATE.hardwareConnected = false; // Mark as disconnected if bridge is down
      reject(new Error(`Bridge unavailable: ${e.message}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function writeRfidSecurityState({ barcode, uid, afi, state }) {
  if (!RFID_STATE.enabled) return { success: false, skipped: true, message: 'Disabled' };
  await ensureRfidBridgeStarted();
  let nUid = normalizeRfidUid(uid), nBc = resolveItemBarcode(normalizeItemBarcode(barcode), nUid);
  if (!nUid && nBc) nUid = getCachedUidForBarcode(nBc);
  if (!nBc && !nUid) throw new Error('Barcode or UID required');
  if (!/^[0-9A-F]{2}$/.test(String(afi))) throw new Error('Invalid AFI');
  if (!nUid) {
    try {
      const tags = filterLiveRfidTags(await proxyRfidRequest('/api/tags')).map(normalizeRfidTag);
      const match = tags.find(t => t.barcode === nBc) || (tags.length === 1 ? tags[0] : null);
      if (match?.uid) nUid = match.uid;
    } catch (_) {}
  }
  const res = await proxyRfidRequest(`/api/write-afi?barcode=${encodeURIComponent(nBc || '')}&uid=${encodeURIComponent(nUid || '')}&afi=${encodeURIComponent(afi)}`);
  rememberRfidUidBarcode(nUid, nBc);
  logBackend('rfid.security.write', { barcode: nBc, uid: nUid, afi, state, result: res });
  return { ...res, requestedState: state, requestedAfi: afi };
}

function waitForBridgeReady(timeoutMs = 25000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => proxyRfidRequest('/api/status').then(resolve).catch((e) => (Date.now() - start >= timeoutMs) ? reject(e) : setTimeout(check, 200));
    check();
  });
}

function startRfidMonitor() {
  if (RFID_STATE.monitorTimer) return;
  RFID_STATE.monitorTimer = setInterval(async () => {
    if (!RFID_STATE.enabled || RFID_STATE.status === 'starting' || RFID_STATE.startup) return;
    try {
      if (RFID_STATE.status === 'error' && RFID_STATE.child) { stopRfidBridge(); return; }
      if (!RFID_STATE.child || RFID_STATE.status !== 'running') {
        if (Date.now() - (RFID_STATE.child?.exitTime || 0) < 3000) return;
        await ensureRfidBridgeStarted();
        return;
      }

      const bs = await proxyRfidRequest('/api/status');
      const bridgeConnected = bs.status === 'CONNECTED' || bs.connected === true;
      let hardwareHealthy = bridgeConnected;
      
      // If bridge says connected but we have a critical error, check if it's stale or active
      if (bridgeConnected && bs.lastError && /Device not open|Disconnected|FEUSB_OpenDevice|No FEIG reader/i.test(bs.lastError)) {
          // If we haven't seen a tag in a while AND we have this error, mark as unhealthy
          // But give it a few chances to clear itself
          hardwareHealthy = false;
      }

      // Final health check: try to fetch tags if bridge thinks it's okay
      if (hardwareHealthy) { 
          try { await proxyRfidRequest('/api/tags'); } 
          catch (_) { hardwareHealthy = false; } 
      }

      if (!hardwareHealthy) {
        RFID_STATE.disconnectionCount++;
        // If we have at least 1 failure, mark as disconnected for UI immediate feedback
        RFID_STATE.hardwareConnected = false;
        
        // Require 3 consecutive failures (6 seconds) before restarting
        if (RFID_STATE.disconnectionCount >= 3) {
          logger.warn('RFID', `Restarting bridge: hardware health check failed 3 times. LastError: ${bs.lastError || 'None'}`);
          stopRfidBridge();
          RFID_STATE.disconnectionCount = 0;
        }
      } else {
        RFID_STATE.hardwareConnected = true;
        RFID_STATE.disconnectionCount = 0;
      }
    } catch (e) {
      if (++RFID_STATE.disconnectionCount >= 5) { 
          logger.warn('RFID', `Restarting bridge: multiple poll failures. Error: ${e.message}`);
          stopRfidBridge(); 
          RFID_STATE.disconnectionCount = 0; 
      }
    }
  }, 2000);
}

async function ensureRfidBridgeStarted() {
  if (!RFID_STATE.enabled) { RFID_STATE.status = 'disabled'; return; }
  if (RFID_STATE.child) return;
  if (RFID_STATE.startup) return RFID_STATE.startup;

  RFID_STATE.startup = (async () => {
    try { return await proxyRfidRequest('/api/status'); } catch (_) {}
    RFID_STATE.status = 'compiling';
    await compileRfidBridge();
    if (RFID_STATE.compileLog.includes('failed')) throw new Error('Compile failed');
    RFID_STATE.status = 'starting';
    const child = spawn(RFID_EXECUTABLE, [], { cwd: RFID_EXEC_DIR, env: { ...process.env, RFID_BRIDGE_PORT: String(RFID_PORT) }, windowsHide: true });
    RFID_STATE.child = child;
    child.stdout.on('data', createBridgeOutputHandler('stdout'));
    child.stderr.on('data', createBridgeOutputHandler('stderr'));
    child.on('exit', (c, s) => { if (RFID_STATE.child === child) RFID_STATE.child = null; child.exitTime = Date.now(); RFID_STATE.status = 'stopped'; RFID_STATE.startup = null; });
    await waitForBridgeReady();
    RFID_STATE.status = 'running';
  })().catch((e) => { RFID_STATE.status = 'error'; RFID_STATE.lastError = e.message; stopRfidBridge(); throw e; }).finally(() => RFID_STATE.startup = null);
  return RFID_STATE.startup;
}

function stopRfidBridge() {
  if (RFID_STATE.child) { try { RFID_STATE.child.kill('SIGTERM'); const c = RFID_STATE.child; setTimeout(() => { try { c.kill('SIGKILL'); } catch (_) {} }, 1000); } catch (_) {} RFID_STATE.child = null; }
  RFID_STATE.status = 'stopped';
}

function stopRfidMonitor() {
  if (RFID_STATE.monitorTimer) { clearInterval(RFID_STATE.monitorTimer); RFID_STATE.monitorTimer = null; }
}

async function restartRfidBridge() {
  stopRfidBridge();
  return ensureRfidBridgeStarted();
}

function filterLiveRfidTags(ts) {
  const tags = Array.isArray(ts) ? ts : (ts?.tags || []);
  return tags.filter(t => t && t.uid);
}

// --- Reachability ---
async function isInternetReachable() {
  return new Promise((resolve) => {
    require('dns').lookup('google.com', (err) => {
      if (!err) return resolve(true);
      const s = require('net').createConnection(53, '8.8.8.8');
      s.setTimeout(2000);
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => { s.destroy(); resolve(false); });
      s.on('timeout', () => { s.destroy(); resolve(false); });
    });
  });
}

async function isKohaReachable() {
  return new Promise((resolve) => {
    const url = new URL(KOHA_CONFIG.baseUrl);
    const req = http.request({ hostname: url.hostname, port: url.port || 80, path: '/', method: 'HEAD', timeout: 2000 }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// --- Koha API ---
function kohaRequest(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${KOHA_CONFIG.baseUrl}${path}`), auth = 'Basic ' + Buffer.from(`${KOHA_CONFIG.username}:${KOHA_CONFIG.password}`).toString('base64');
    const req = http.request({ hostname: url.hostname, port: url.port || 80, path: `${url.pathname}${url.search}`, method: 'GET', headers: { Authorization: auth, Accept: 'application/json' }, timeout: 10000 }, (res) => {
      let b = ''; res.on('data', (c) => b += c.toString('utf8'));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Koha error ${res.statusCode}: ${b}`));
        try { resolve(JSON.parse(b)); } catch (_) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Koha request timed out')); });
    req.on('error', reject); req.end();
  });
}

function kohaPost(path, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${KOHA_CONFIG.baseUrl}${path}`), auth = 'Basic ' + Buffer.from(`${KOHA_CONFIG.username}:${KOHA_CONFIG.password}`).toString('base64'), body = JSON.stringify(payload);
    const req = http.request({ hostname: url.hostname, port: url.port || 80, path: `${url.pathname}${url.search}`, method: 'POST', headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 }, (res) => {
      let b = ''; res.on('data', (c) => b += c.toString('utf8'));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(b || `Koha error ${res.statusCode}`));
        try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Koha request timed out')); });
    req.on('error', reject); req.write(body); req.end();
  });
}

function normalizeCollection(p) { return Array.isArray(p) ? p : (p && Array.isArray(p.value) ? p.value : []); }
function findExactMatch(rs, f, v) { const t = String(v || '').trim(); return rs.find(r => String(r?.[f] || '').trim() === t) || null; }
function firstNonEmpty(vs) { for (const v of vs) if (typeof v === 'string' && v.trim()) return v.trim(); return ''; }

function extractTitle(r) {
  if (!r || typeof r !== 'object') return '';
  const t = firstNonEmpty([r.title, r.book_title, r.display_title]);
  if (t) return t;
  for (const c of [r.biblio, r._strings, r.metadata]) { const nt = extractTitle(c); if (nt) return nt; }
  return '';
}

// --- Domain Helpers ---
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const n of Object.keys(nets)) {
    for (const net of nets[n]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

async function getPatronForRenew(card) {
  if (card === 'E0040150111266FC') card = '1';
  let p = null;
  try {
    const ps = normalizeCollection(await kohaRequest(`/patrons?cardnumber=${encodeURIComponent(card)}`));
    p = findExactMatch(ps, 'cardnumber', card);
  } catch (_) {}
  if (!p) {
    try {
      const ps = normalizeCollection(await kohaRequest(`/patrons?q=${encodeURIComponent(card)}`));
      p = ps.find(x => String(x.cardnumber || '').trim().toUpperCase() === card.toUpperCase() || String(x.userid || '').trim().toUpperCase() === card.toUpperCase());
    } catch (_) {}
  }
  return p;
}

async function getActiveCheckoutForItemId(itemId) {
  try {
    const cos = normalizeCollection(await kohaRequest(`/checkouts?q=${encodeURIComponent(JSON.stringify({ item_id: itemId, checkin_date: null }))}`));
    return cos[0] || null;
  } catch (_) { return null; }
}

async function getItemDetails(bc) {
  try {
    const items = normalizeCollection(await kohaRequest(`/items?external_id=${encodeURIComponent(bc)}`));
    const item = findExactMatch(items, 'external_id', bc);
    if (!item) return { itemBarcode: bc, itemTitle: bc };
    let t = firstNonEmpty([extractTitle(item), item.external_id, bc]);
    if (item.biblio_id) { try { t = extractTitle(await kohaRequest(`/biblios/${item.biblio_id}`)) || t; } catch (_) {} }
    return { itemBarcode: bc, itemTitle: t };
  } catch (_) { return { itemBarcode: bc, itemTitle: bc }; }
}

async function getItemDetailsById(id) {
  if (!id) return { itemBarcode: '', itemTitle: '' };
  try {
    const item = await kohaRequest(`/items/${id}`);
    let t = firstNonEmpty([extractTitle(item), item.external_id, String(id)]);
    if (item.biblio_id) { try { t = extractTitle(await kohaRequest(`/biblios/${item.biblio_id}`)) || t; } catch (_) {} }
    return { itemBarcode: firstNonEmpty([item.external_id, item.barcode, '']), itemTitle: t };
  } catch (_) { return { itemBarcode: '', itemTitle: '' }; }
}

async function getPatronAccountSummary(card) {
  if (card === 'E0040150111266FC') card = '1';
  let p = null;
  try { p = findExactMatch(normalizeCollection(await kohaRequest(`/patrons?cardnumber=${encodeURIComponent(card)}`)), 'cardnumber', card); } catch (_) {}
  if (!p) { try { p = normalizeCollection(await kohaRequest(`/patrons?q=${encodeURIComponent(card)}`)).find(x => String(x.cardnumber || '').toUpperCase() === card.toUpperCase()); } catch (_) {} }
  if (!p) throw new Error('Patron not found');

  let fine = 0; try { const a = await kohaRequest(`/patrons/${p.patron_id}/account`); fine = Number(a?.outstanding_debits?.total ?? a?.balance ?? 0) || 0; } catch (_) {}
  const cos = normalizeCollection(await kohaRequest(`/checkouts?q=${encodeURIComponent(JSON.stringify({ patron_id: p.patron_id, checkin_date: null }))}`));
  const loans = await Promise.all(cos.map(async (c) => {
    const d = await getItemDetailsById(c.item_id);
    return { itemBarcode: d.itemBarcode || c.external_id || String(c.item_id), itemTitle: d.itemTitle || c.title || `Item ${c.item_id}`, dueDate: c.due_date || c.date_due || '' };
  }));
  return { patronCardNumber: card, patronName: firstNonEmpty([`${p.firstname || ''} ${p.surname || ''}`.trim(), p.cardnumber]), fineAmount: fine, loans };
}

// --- Route Handlers ---
async function handleAccount(req, res) {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`), c = String(u.searchParams.get('cardnumber') || '').trim();
    if (!c) return sendJson(res, 400, { success: false, message: 'Card number required' });
    sendJson(res, 200, { success: true, data: await getPatronAccountSummary(c) });
  } catch (e) { sendJson(res, 500, { success: false, message: e.message }); }
}

async function handleCheckout(req, res) {
  try {
    const b = await parseRequestBody(req), uid = normalizeRfidUid(b.rfidUid), bc = resolveItemBarcode(normalizeItemBarcode(b.itemBarcode), uid);
    if (!b.patronCardNumber || !bc) return sendJson(res, 400, { success: false, message: 'Missing fields' });
    const ps = normalizeCollection(await kohaRequest(`/patrons?cardnumber=${encodeURIComponent(b.patronCardNumber)}`));
    const p = findExactMatch(ps, 'cardnumber', b.patronCardNumber);
    if (!p) return sendJson(res, 404, { success: false, message: 'Patron not found' });
    const is = normalizeCollection(await kohaRequest(`/items?external_id=${encodeURIComponent(bc)}`));
    const i = findExactMatch(is, 'external_id', bc);
    if (!i) return sendJson(res, 404, { success: false, message: 'Item not found' });
    const co = await kohaPost('/checkouts', { patron_id: p.patron_id, item_id: i.item_id, library_id: i.home_library_id || KOHA_CONFIG.libraryId });
    let su = null; try { su = await writeRfidSecurityState({ barcode: bc, uid, afi: '00', state: 'Unsecure' }); } catch (se) { su = { success: false, message: se.message }; }
    const dt = await getItemDetails(bc);
    sendJson(res, 200, { success: true, message: 'Checked out', data: { checkoutId: co.checkout_id, patronName: `${p.firstname} ${p.surname}`.trim(), itemBarcode: bc, itemTitle: dt.itemTitle, dueDate: co.due_date, securityUpdate: su } });
  } catch (e) { sendJson(res, 500, { success: false, message: e.message }); }
}

async function handleCheckin(req, res) {
  try {
    const b = await parseRequestBody(req), uid = normalizeRfidUid(b.rfidUid), bc = resolveItemBarcode(normalizeItemBarcode(b.itemBarcode), uid);
    if (!bc) return sendJson(res, 400, { success: false, message: 'Barcode required' });
    const r = await sipCheckin(bc);
    if (!r.ok) return sendJson(res, 500, { success: false, message: r.message });
    let su = null; try { su = await writeRfidSecurityState({ barcode: bc, uid, afi: '90', state: 'Secure' }); } catch (se) { su = { success: false, message: se.message }; }
    const dt = await getItemDetails(bc);
    sendJson(res, 200, { success: true, message: 'Checked in', data: { itemBarcode: bc, itemTitle: dt.itemTitle, securityUpdate: su } });
  } catch (e) { sendJson(res, 500, { success: false, message: e.message }); }
}

async function handleRenewBatch(req, res) {
  try {
    const b = await parseRequestBody(req), card = String(b.patronCardNumber || '').trim(), bcs = Array.isArray(b.barcodes) ? b.barcodes : [];
    if (!card || bcs.length === 0) return sendJson(res, 400, { success: false, message: 'Invalid request' });
    const results = [];
    for (const bc of bcs) {
      try {
        const is = normalizeCollection(await kohaRequest(`/items?external_id=${encodeURIComponent(bc)}`));
        const i = findExactMatch(is, 'external_id', bc);
        if (!i) { results.push({ barcode: bc, ok: false, message: 'Not found' }); continue; }
        const q = encodeURIComponent(JSON.stringify({ item_id: i.item_id, checkin_date: null }));
        const cos = normalizeCollection(await kohaRequest(`/checkouts?q=${q}`));
        const c = cos[0];
        if (!c) { results.push({ barcode: bc, ok: false, message: 'Not checked out' }); continue; }
        const rr = await kohaPost(`/checkouts/${c.checkout_id}/renewal`, {});
        results.push({ barcode: bc, ok: true, message: 'Renewed', newDueDate: rr.due_date });
      } catch (e) { results.push({ barcode: bc, ok: false, message: e.message }); }
    }
    sendJson(res, 200, { success: true, results });
  } catch (e) { sendJson(res, 500, { success: false, message: e.message }); }
}


// --- Missing Domain Helpers ---
async function handleRenew(req, res) {
  try {
    const b = await parseRequestBody(req), card = String(b.patronCardNumber || '').trim(), bc = normalizeItemBarcode(b.itemBarcode);
    if (!card || !bc) return sendJson(res, 400, { success: false, message: 'Missing fields' });
    const p = await getPatronForRenew(card);
    if (!p) return sendJson(res, 404, { success: false, message: 'Patron not found' });
    const is = normalizeCollection(await kohaRequest(`/items?external_id=${encodeURIComponent(bc)}`));
    const i = findExactMatch(is, 'external_id', bc);
    if (!i) return sendJson(res, 404, { success: false, message: 'Item not found' });
    const co = await getActiveCheckoutForItemId(i.item_id);
    if (!co || Number(co.patron_id) !== Number(p.patron_id)) return sendJson(res, 403, { success: false, message: 'Not issued to this patron' });
    const rr = await kohaPost(`/checkouts/${co.checkout_id}/renewal`, {});
    const dt = await getItemDetails(bc);
    sendJson(res, 200, { success: true, message: 'Renewed', data: { patronName: `${p.firstname} ${p.surname}`.trim(), itemBarcode: bc, itemTitle: dt.itemTitle, newDueDate: rr.due_date } });
  } catch (e) { sendJson(res, 500, { success: false, message: e.message }); }
}

async function handleRenewItemsOut(req, res) {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`), card = String(u.searchParams.get('cardnumber') || '').trim();
    if (!card) return sendJson(res, 400, { success: false, message: 'Card required' });
    const p = await getPatronForRenew(card);
    if (!p) return sendJson(res, 404, { success: false, message: 'Patron not found' });
    const cos = normalizeCollection(await kohaRequest(`/checkouts?q=${encodeURIComponent(JSON.stringify({ patron_id: p.patron_id, checkin_date: null }))}`));
    const items = await Promise.all(cos.filter(c => Number(c?.patron_id) === Number(p.patron_id) && c?.checkin_date == null).map(async (c) => {
      const d = await getItemDetailsById(c.item_id);
      let renewable = null, reason = '';
      try {
        const check = await kohaRequest(`/checkouts/${c.checkout_id}/renewability`);
        renewable = check.renewable;
        if (!renewable) reason = check.error || check.reason || 'Not renewable';
      } catch (_) {}
      return { checkoutId: c.checkout_id, itemId: c.item_id, itemBarcode: d.itemBarcode || c.external_id, itemTitle: d.itemTitle || c.title, dueDate: c.due_date, renewable, notRenewableReason: reason };
    }));
    sendJson(res, 200, { success: true, data: { patronName: `${p.firstname} ${p.surname}`.trim(), patronCardNumber: card, items } });
  } catch (e) { sendJson(res, 500, { success: false, message: e.message }); }
}

async function handlePlaceHold(req, res) {
  try {
    const b = await parseRequestBody(req), card = String(b.patronCardNumber || '').trim(), bc = String(b.barcode || '').trim();
    const ps = normalizeCollection(await kohaRequest(`/patrons?cardnumber=${encodeURIComponent(card)}`));
    const p = findExactMatch(ps, 'cardnumber', card);
    const is = normalizeCollection(await kohaRequest(`/items?external_id=${encodeURIComponent(bc)}`));
    const i = findExactMatch(is, 'external_id', bc) || is[0];
    if (!p || !i) throw new Error('Patron or Item not found');
    const r = await kohaPost('/holds', { patron_id: p.patron_id, biblio_id: i.biblio_id, pickup_library_id: KOHA_CONFIG.libraryId });
    sendJson(res, 200, { success: true, hold: r });
  } catch (e) { sendJson(res, 500, { success: false, message: e.message }); }
}

// --- QR Receipt Module (isolated) ---
const QR_TOKEN_TTL_SEC = 180, QR_TEMP_DIR = path.join(__dirname, 'tmp', 'receipts'), QR_TOKENS = new Map();
try { fs.mkdirSync(QR_TEMP_DIR, { recursive: true }); } catch (_) {}
function resolveReceiptBaseUrl(req) { const lan = getLanIp(); return { url: lan ? `http://${lan}:${PORT}` : `http://${req.headers.host || 'localhost:'+PORT}`, localOnly: true }; }
async function generateReceiptPdf(tx) {
  return new Promise((resolve, reject) => {
    if (!PDFDocument) return reject(new Error('pdfkit missing'));
    const doc = new PDFDocument({ margin: 40, size: 'A4' }), chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(18).text('Punjabi University Library', { align: 'center' });
    doc.fontSize(12).text('Renewal Receipt', { align: 'center' });
    doc.moveDown(); doc.fontSize(10).text(`Date: ${new Date().toLocaleString()}`);
    if (tx.patronName) doc.text(`Patron: ${tx.patronName}`);
    doc.moveDown(); const items = Array.isArray(tx.items) ? tx.items : [];
    items.forEach(it => doc.text(`${it.status === 'renewed' ? '✓' : '✗'} ${it.title || it.barcode} - ${it.newDueDate || 'N/A'}`));
    doc.end();
  });
}
async function handleQrReceiptCreate(req, res) {
  try {
    const b = await parseRequestBody(req), tx = b.transactionData, token = crypto.randomBytes(24).toString('hex');
    const pdfPath = path.join(QR_TEMP_DIR, `receipt_${token}.pdf`);
    fs.writeFileSync(pdfPath, await generateReceiptPdf(tx));
    QR_TOKENS.set(token, { pdfPath, expiresAt: Date.now() + QR_TOKEN_TTL_SEC*1000, downloaded: false });
    const { url } = resolveReceiptBaseUrl(req);
    sendJson(res, 200, { token, url: `${url}/receipt/pdf/${token}`, expiresAt: new Date(Date.now() + QR_TOKEN_TTL_SEC*1000).toISOString() });
  } catch (e) { sendJson(res, 500, { success: false, message: e.message }); }
}
function handleQrReceiptPdf(res, token) {
  const e = QR_TOKENS.get(token);
  if (!e || Date.now() > e.expiresAt) return sendJson(res, 404, { message: 'Expired' });
  e.downloaded = true; res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="receipt.pdf"' });
  res.end(fs.readFileSync(e.pdfPath));
}

// --- Main Router ---
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': '*' }); return res.end(); }
  
  if (u.pathname === '/api/status') return sendJson(res, 200, { status: 'ok', online: await isKohaReachable(), internet: await isInternetReachable(), rfid: { enabled: RFID_STATE.enabled, state: RFID_STATE.status, connected: RFID_STATE.hardwareConnected && RFID_STATE.status === 'running' } });
  if (u.pathname === '/api/account') return handleAccount(req, res);
  if (u.pathname === '/api/checkout') return handleCheckout(req, res);
  if (u.pathname === '/api/checkin') return handleCheckin(req, res);
  if (u.pathname === '/api/renew') return handleRenew(req, res);
  if (u.pathname === '/api/renew/items') return handleRenewItemsOut(req, res);
  if (u.pathname === '/api/renew/batch') return handleRenewBatch(req, res);
  if (u.pathname === '/api/hold') return handlePlaceHold(req, res);
  if (u.pathname === '/api/receipt/qr') return handleQrReceiptCreate(req, res);
  if (u.pathname.startsWith('/receipt/pdf/')) return handleQrReceiptPdf(res, u.pathname.slice(13));
  if (u.pathname === '/api/rfid/debug') {
    return sendJson(res, 200, {
      enabled: RFID_STATE.enabled,
      status: RFID_STATE.status,
      disconnectionCount: RFID_STATE.disconnectionCount,
      startup: RFID_STATE.startup,
      hasChild: !!RFID_STATE.child,
      port: RFID_PORT
    });
  }
  if (u.pathname === '/api/rfid/status') {
    await ensureRfidBridgeStarted();
    const bs = await proxyRfidRequest('/api/status').catch(() => ({}));
    return sendJson(res, 200, { enabled: RFID_STATE.enabled, state: RFID_STATE.status, bridgePort: RFID_PORT, ...bs });
  }
  if (u.pathname === '/api/rfid/restart') return sendJson(res, 200, { success: true, ...(await restartRfidBridge()) });
  if (u.pathname === '/api/rfid/tags' || u.pathname === '/api/tags' || u.pathname === '/api/rfid/poll') {
    try { 
      await ensureRfidBridgeStarted(); 
      const ts = filterLiveRfidTags(await proxyRfidRequest('/api/tags')).map(normalizeRfidTag); 
      sendJson(res, 200, { success: true, tags: ts }); 
    }
    catch (e) { sendJson(res, 503, { success: false, message: e.message }); }
    return;
  }
  if (u.pathname === '/api/rfid/arm') {
    try {
      const afi = u.searchParams.get('afi') || '00';
      const resBridge = await proxyRfidRequest(`/api/arm?afi=${encodeURIComponent(afi)}`);
      return sendJson(res, 200, { success: true, ...resBridge });
    } catch (e) { return sendJson(res, 500, { success: false, message: e.message }); }
  }
  if (u.pathname === '/api/rfid/disarm') {
    try {
      const resBridge = await proxyRfidRequest('/api/disarm');
      return sendJson(res, 200, { success: true, ...resBridge });
    } catch (e) { return sendJson(res, 500, { success: false, message: e.message }); }
  }
  if (u.pathname === '/api/rfid/security' && req.method === 'POST') {
    try {
      const b = await parseRequestBody(req), m = { secure: '90', unsecure: '00' };
      const afi = b.afi || m[b.state?.toLowerCase()];
      sendJson(res, 200, await writeRfidSecurityState({ barcode: b.barcode, uid: b.uid, afi, state: b.state }));
    } catch (e) { sendJson(res, 500, { success: false, message: e.message }); }
    return;
  }

  if (req.method === 'GET') {
    const fp = path.normalize(path.join(PUBLIC_DIR, u.pathname === '/' ? 'index.html' : u.pathname));
    if (fp.startsWith(PUBLIC_DIR)) return serveFile(res, fp);
  }
  sendJson(res, 404, { success: false, message: 'Not found' });
});

warmRfidBarcodeCacheFromLogs();
startRfidMonitor();
ensureRfidBridgeStarted().catch((e) => logger.warn('RFID', `Startup skipped: ${e.message}`));

const cleanup = () => { stopRfidMonitor(); stopRfidBridge(); };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

server.listen(PORT, () => logger.info('System', `Running at http://localhost:${PORT}`));
