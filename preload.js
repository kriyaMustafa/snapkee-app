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
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),

  onProgress: (callback) => {
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.on('download-progress', (_event, data) => callback(data));
  },
  onGlobalMetrics: (callback) => {
    ipcRenderer.removeAllListeners('global-metrics');
    ipcRenderer.on('global-metrics', (_event, data) => callback(data));
  },
  onLog: (callback) => {
    ipcRenderer.removeAllListeners('download-log');
    ipcRenderer.on('download-log', (_event, data) => callback(data));
  },
  onScrapeProgress: (callback) => {
    ipcRenderer.removeAllListeners('scrape-progress');
    ipcRenderer.on('scrape-progress', (_event, data) => callback(data));
  },
  onQueueCompleted: (callback) => {
    ipcRenderer.removeAllListeners('queue-completed');
    ipcRenderer.on('queue-completed', (_event, data) => callback(data));
  }
});
