const net = require('net');

const CONFIG = {
  host: '164.52.208.94',
  port: 8023,
  telnetUser: 'jivesna',
  telnetPassword: 'library@koha123',
  sipInstitutionId: 'CPL',
  sipPassword: 'library@koha123',
  terminator: '\r\n'
};

function sipDateTime() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `${year}${month}${day}    ${hours}${minutes}${seconds}`;
}

function waitForText(socket, expectedText, timeout) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    };

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes(expectedText)) {
        cleanup();
        resolve(buffer);
      }
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    socket.on('data', onData);
    socket.on('error', onError);

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for: ${expectedText}`));
    }, timeout);
  });
}

function sendLine(socket, value) {
  socket.write(value + CONFIG.terminator);
}

async function telnetLogin(socket) {
  await waitForText(socket, 'login:', 10000);
  sendLine(socket, CONFIG.telnetUser);

  await waitForText(socket, 'password:', 10000);
  sendLine(socket, CONFIG.telnetPassword);

  const response = await waitForText(socket, 'Login OK', 30000);
  if (!response.includes('Initiating SIP')) {
    throw new Error('Telnet login succeeded but SIP session did not start');
  }
}

function sendSIPCommand(socket, command, expectedPrefix, timeout) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
    };

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.trim().startsWith(expectedPrefix)) {
        cleanup();
        resolve(buffer.trim());
      }
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(command + '\r\n');

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for SIP2 response with prefix: ${expectedPrefix}`));
    }, timeout);
  });
}

async function sipCheckin(barcode) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    socket.connect(CONFIG.port, CONFIG.host, async () => {
      try {
        await telnetLogin(socket);

        const timestamp = sipDateTime();
        const checkinCommand =
          '09' +
          'N' +
          timestamp +
          timestamp +
          `|AO${CONFIG.sipInstitutionId}` +
          `|AB${barcode}` +
          `|AC${CONFIG.sipPassword}|`;

        const response = await sendSIPCommand(socket, checkinCommand, '10', 15000);
        socket.end();

        const ok = response.length > 2 && response[2] === '1';
        resolve({
          ok,
          message: ok ? 'Check-in successful via SIP2' : 'Check-in failed via SIP2',
          raw: response
        });
      } catch (error) {
        socket.end();
        reject(error);
      }
    });

    socket.on('error', (error) => {
      reject(new Error(`Telnet connection error: ${error.message}`));
    });

    socket.setTimeout(30000, () => {
      socket.end();
      reject(new Error('Telnet connection timeout'));
    });
  });
}

module.exports = {
  sipCheckin
};
