const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snapkeeAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectFile: () => ipcRenderer.invoke('select-file'),
  scrapeQueue: (urls) => ipcRenderer.invoke('scrape-queue', urls),
  scrapeSingleUrl: (url) => ipcRenderer.invoke('scrape-single', url),
  startDownload: (items, settings) => ipcRenderer.invoke('start-download', { items, settings }),
  cancelDownload: () => ipcRenderer.invoke('cancel-download'),
  openInFolder: (filePath) => ipcRenderer.invoke('open-in-folder', filePath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  onProgress: (callback) => {
    ipcRenderer.on('download-progress', (_event, data) => callback(data));
  },
  onGlobalMetrics: (callback) => {
    ipcRenderer.on('global-metrics', (_event, data) => callback(data));
  },
  onScrapeProgress: (callback) => {
    ipcRenderer.on('scrape-progress', (_event, data) => callback(data));
  },
  onQueueCompleted: (callback) => {
    ipcRenderer.on('queue-completed', (_event, data) => callback(data));
  }
});
