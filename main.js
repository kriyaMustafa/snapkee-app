const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const path = require('path');
const ScraperEngine = require('./src/scraper');
const DownloaderEngine = require('./src/downloader');

let mainWindow;
const scraper = new ScraperEngine();
const downloader = new DownloaderEngine();

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1100,
      minHeight: 700,
      title: 'SnapKee Downloader & Media V1.3.55 (Licensed)',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true
      },
      autoHideMenuBar: true,
      backgroundColor: '#0f172a'
    });

    mainWindow.loadFile('index.html');
  }

  // Forward downloader events to frontend — registered ONCE (outside createWindow)
  // to prevent duplicate listener accumulation on window re-creation
  downloader.on('item-progress', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-progress', data);
    }
  });

  downloader.on('global-metrics', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('global-metrics', data);
    }
  });

  downloader.on('log', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-log', data);
    }
  });

  downloader.on('queue-completed', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('queue-completed', data);
    }
  });

  app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    downloader.cancelAll();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // --- IPC HANDLERS ---

  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Workspace & Downloads Storage Directory',
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('select-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Netscape cookies.txt File',
      properties: ['openFile'],
      filters: [
        { name: 'Cookie & Text Files', extensions: ['txt', 'cookies', 'json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle('scrape-queue', async (_event, urls) => {
    try {
      const items = await scraper.scrapeQueue(urls, (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('scrape-progress', progress);
        }
      });
      return { success: true, items };
    } catch (err) {
      console.error('Scrape error:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('scrape-single', async (_event, url) => {
    try {
      const items = await scraper.scrapeSingleUrl(url);
      return { success: true, items };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('start-download', async (_event, { items, settings }) => {
    try {
      downloader.startQueue(items, settings);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('cancel-download', async () => {
    downloader.cancelAll();
    return { success: true };
  });

  ipcMain.handle('open-in-folder', async (_event, filePath) => {
    try {
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('open-external', async (_event, url) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('copy-to-clipboard', async (_event, text) => {
    try {
      clipboard.writeText(String(text ?? ''));
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}
