const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    printReceipt: (htmlContent) => ipcRenderer.invoke('print-receipt', htmlContent)
});
