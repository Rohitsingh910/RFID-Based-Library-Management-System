const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    printReceipt: (htmlContent) => ipcRenderer.invoke('print-receipt', htmlContent)
    // Returns Promise<{ success: boolean, error: string|null }>
    silentPrint: (htmlContent) => ipcRenderer.invoke('silent-print', htmlContent)
    silentPrint: (htmlContent) => ipcRenderer.send('silent-print', htmlContent)
});
