const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Returns Promise<{ success: boolean, error: string|null }>
    silentPrint: (htmlContent) => ipcRenderer.invoke('silent-print', htmlContent)
});
