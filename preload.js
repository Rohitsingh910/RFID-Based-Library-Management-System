const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    printReceipt: (htmlContent) => ipcRenderer.invoke('print-receipt', htmlContent),
    silentPrint: (htmlContent) => ipcRenderer.invoke('silent-print', htmlContent),
    closeApp: () => ipcRenderer.invoke('close-app')
});
