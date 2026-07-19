# SnapKee Downloader & Media V1.3.32 (Desktop Edition)

A high-performance Desktop Media Scraper & Multi-Threaded Parallel Downloader built with **Electron + Node.js + Tailwind CSS + Vanilla JS**. Inspired directly by the "SnapKee" architecture and UI design.

---

## 🌟 Key Capabilities & Features

### 1. Top Search & Queue Input (`Queue Downloading`)
- **Pasting & URL Management**: Input bar supporting custom platform URLs, playlists, DramaBox links, YouTube, and TikTok.
- **Add to Queue**: Instantly pushes links to the left-side `Queue Downloading` table.
- **Scrape Now**: Triggers the backend `ScraperEngine` via IPC (`ipcRenderer.invoke('scrape-queue')`) to inspect metadata, extract streams, or generate episode matrices.

### 2. Main Activities Table (`Activities Tables`)
- **Comprehensive Columns**: Displays `#`, `Title`, `URLs`, `Folder`, `Type`, `Size (MB)`, `Profile`, `Platform`, and `Status`.
- **Granular Selection**: Individual row checkboxes plus a master select/unselect all header checkbox.
- **Right-Click Custom Context Menu**:
  - `Select` / `Unselect` rows
  - `Paste links` directly from system clipboard
  - `Delete selected link`
  - `Open link` in external browser (`shell.openExternal`)
  - `Open File in Folder` (`shell.showItemInFolder`) once downloaded.
- **Live Visual Metrics**: Integrated mini progress bars inside row statuses and real-time speed tracking (`105.70 Mbps`).

### 3. Workspace Settings (File Directory Management)
- **Custom Local Storage Path**: Displays and lets you edit your target directory (defaulting to `D:/Channel & Page/Video downloaded`).
- **Browse Directory Dialog**: Native system dialog opened via `ipcRenderer.invoke('select-folder')` -> `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })`.
- **Automatic Sub-directories**: Automatically paths `Videos:` (`.../video`) and `Photos:` (`.../photo`).

### 4. General Downloading & Parallel System Execution
- **Multi-Threaded Concurrency (`threads`)**: Controlled by user input (`1` to `16` parallel streams simultaneously running without blocking).
- **Download Engine (`DownloaderEngine`)**: Streams actual `.mp4` video data and high-speed simulated demo chunks directly to disk using `fs.createWriteStream` and `AbortController`.
- **Cancel Operations**: Immediate abort of all active network requests and workers.
- **Real-Time Global Statistics**: Elapsed timer (`00:00:00`), live aggregate bandwidth speed indicator (`0.00 Mbps`), and completion counter (`4/12 Completed`).

---

## 📁 Project Structure

```text
snapkee-app/
├── package.json         # Dependencies & Electron start scripts
├── main.js              # Electron Main Process (IPC, Window, Native OS access)
├── preload.js           # Secure ContextBridge API exposing window.snapkeeAPI
├── index.html           # Modern Glassmorphic Dark-Mode UI structure
├── styles.css           # Custom CSS, Animations, Progress Bars, and Context Menu
├── renderer.js          # Frontend Controller, Queue Management, Event Handlers
└── src/
    ├── scraper.js       # Backend Scraper Engine (DramaBox, Web, MP4 Extraction)
    └── downloader.js    # Multi-Threaded Parallel Download Engine & Speed Tracking
```

---

## 🚀 How to Run Locally

1. Open a terminal (PowerShell / Command Prompt) in this directory:
   ```powershell
   cd "D:\PROJECT\DOWNLOAD\snapkee-app"
   ```
2. Install dependencies:
   ```powershell
   npm install
   ```
3. Start the application:
   ```powershell
   npm start
   ```
