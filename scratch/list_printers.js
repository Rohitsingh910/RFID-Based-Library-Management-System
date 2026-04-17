const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false });
    const printers = await win.webContents.getPrintersAsync();
    console.log('--- PRINTER LIST ---');
    console.log(JSON.stringify(printers, null, 2));
    console.log('--- END PRINTER LIST ---');
    app.quit();
});
