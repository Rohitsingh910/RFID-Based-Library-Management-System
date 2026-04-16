const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    silentPrint: (htmlContent) => ipcRenderer.send('silent-print', htmlContent)
});
