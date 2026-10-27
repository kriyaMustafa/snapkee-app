// =========================================================================
// SnapKee Studio Pro - Master Renderer Engine
// =========================================================================

// --- APP STATE ---
let queueList = [];
let activitiesList = [];
let currentFilter = 'all';
let currentView = 'cards'; // 'cards' | 'table'
let activeContextTarget = { type: null, index: null };
let timerInterval = null;
let startTime = null;

// --- DOM ELEMENTS ---
const urlInput = document.getElementById('urlInput');
const btnPasteClipboard = document.getElementById('btnPasteClipboard');
const btnAddQueue = document.getElementById('btnAddQueue');
const btnScrapeNow = document.getElementById('btnScrapeNow');

const queueCountBadge = document.getElementById('queueCountBadge');
const queueItemsList = document.getElementById('queueItemsList');
const queueEmptyState = document.getElementById('queueEmptyState');
const btnPasteQueueList = document.getElementById('btnPasteQueueList');
const btnClearQueue = document.getElementById('btnClearQueue');

const activitiesCountBadge = document.getElementById('activitiesCountBadge');
const mediaEmptyState = document.getElementById('mediaEmptyState');
const mediaCardsGrid = document.getElementById('mediaCardsGrid');
const mediaTableWrapper = document.getElementById('mediaTableWrapper');
const activitiesTableBody = document.getElementById('activitiesTableBody');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const tableSelectAllCheckbox = document.getElementById('tableSelectAllCheckbox');
const btnClearAll = document.getElementById('btnClearAll');

const btnViewCards = document.getElementById('btnViewCards');
const btnViewTable = document.getElementById('btnViewTable');
const filterBtns = document.querySelectorAll('.filter-btn');

const workspaceDirInput = document.getElementById('workspaceDirInput');
const btnBrowseDir = document.getElementById('btnBrowseDir');
const btnOpenTargetDir = document.getElementById('btnOpenTargetDir');
const btnOpenDownloadsFolder = document.getElementById('btnOpenDownloadsFolder');
const videosSubpathInput = document.getElementById('videosSubpathInput');
const photosSubpathInput = document.getElementById('photosSubpathInput');

const selectFileType = document.getElementById('selectFileType');
const selectFileFormat = document.getElementById('selectFileFormat');
const selectVideoCodec = document.getElementById('selectVideoCodec');
const selectBilibiliMode = document.getElementById('selectBilibiliMode');
const inputThreads = document.getElementById('inputThreads');
const inputCookies = document.getElementById('inputCookies');
const btnBrowseCookies = document.getElementById('btnBrowseCookies');

const selectSpeedLimit = document.getElementById('selectSpeedLimit');
const customSpeedRow = document.getElementById('customSpeedRow');
const inputCustomSpeed = document.getElementById('inputCustomSpeed');
const chkWifiFriendly = document.getElementById('chkWifiFriendly');
const engineIndicatorText = document.getElementById('engineIndicatorText');

const chkEngCaption = document.getElementById('chkEngCaption');
const chkParaphrase = document.getElementById('chkParaphrase');
const chkEnableGpu = document.getElementById('chkEnableGpu');
const chkRemoveMention = document.getElementById('chkRemoveMention');
const selectSubtitleLang = document.getElementById('selectSubtitleLang');
const chkDownloadThumbnail = document.getElementById('chkDownloadThumbnail');

const btnDownloadNow = document.getElementById('btnDownloadNow');
const btnDownloadCount = document.getElementById('btnDownloadCount');
const btnCancel = document.getElementById('btnCancel');
const btnClearLog = document.getElementById('btnClearLog');
const btnCopyLog = document.getElementById('btnCopyLog');
const btnCopyLogText = document.getElementById('btnCopyLogText');
const btnToggleLogSize = document.getElementById('btnToggleLogSize');
const logShell = document.getElementById('logShell');
const liveLogPanel = document.getElementById('liveLogPanel');

const tabDownloader = document.getElementById('tabDownloader');
const tabQueue = document.getElementById('tabQueue');
const tabSettings = document.getElementById('tabSettings');
const tabLogs = document.getElementById('tabLogs');

const timerDisplay = document.getElementById('timerDisplay');
const speedDisplay = document.getElementById('speedDisplay');
const footerStatusText = document.getElementById('footerStatusText');
const footerStatusBadge = document.getElementById('footerStatusBadge');
const downloadSummaryBar = document.getElementById('downloadSummaryBar');
const summaryProgressText = document.getElementById('summaryProgressText');

const contextMenu = document.getElementById('contextMenu');
const MAX_LOG_ROWS = 300;

const SNAPKEY_SETTINGS_STORAGE_KEY = 'snapkee_app_settings_v1';

function updateEngineIndicator() {
  const mode = selectSpeedLimit ? selectSpeedLimit.value : 'unlimited';
  const customVal = inputCustomSpeed ? (inputCustomSpeed.value || '10') : '10';
  const wifiLag = chkWifiFriendly ? chkWifiFriendly.checked : true;

  if (customSpeedRow) {
    if (mode === 'custom') {
      customSpeedRow.classList.remove('hidden');
      customSpeedRow.classList.add('flex');
    } else {
      customSpeedRow.classList.add('hidden');
      customSpeedRow.classList.remove('flex');
    }
  }

  if (engineIndicatorText) {
    let label = 'Max Speed (Uncapped 🚀 100%)';
    if (mode === 'unlimited') label = 'Max Speed (Uncapped 🚀 100%)';
    else if (mode === '10' || mode === 'wifi-balanced') label = '100M Wi-Fi (10 MB/s 🛡️)';
    else if (mode === '11.5' || mode === 'wifi-turbo') label = '100M Turbo (11.5 MB/s ⚡)';
    else if (mode === '8' || mode === 'wifi-safe') label = '100M Safe (8 MB/s 🍃)';
    else if (mode === '20') label = '200M Plan (20 MB/s 🏎️)';
    else if (mode === '30') label = '300M+ Plan (30 MB/s 🔥)';
    else if (mode === '5' || mode === 'wifi-light') label = '50M Plan (5 MB/s 🌱)';
    else if (mode === 'custom') label = `Cap ${customVal} MB/s ${wifiLag ? '🛡️' : '⚙️'}`;
    else label = `Cap ${mode} MB/s ${wifiLag ? '🛡️' : '⚙️'}`;

    engineIndicatorText.textContent = label;
  }
}

function saveUserSettings() {
  try {
    const data = {
      workspaceDir: workspaceDirInput ? workspaceDirInput.value : '',
      videosSubpath: videosSubpathInput ? videosSubpathInput.value : '',
      photosSubpath: photosSubpathInput ? photosSubpathInput.value : '',
      fileType: selectFileType ? selectFileType.value : 'video',
      fileFormat: selectFileFormat ? selectFileFormat.value : 'mp4',
      videoCodec: selectVideoCodec ? selectVideoCodec.value : 'quality',
      bilibiliMode: selectBilibiliMode ? selectBilibiliMode.value : 'fast',
      threads: inputThreads ? inputThreads.value : '16',
      speedLimitMode: selectSpeedLimit ? selectSpeedLimit.value : 'unlimited',
      customSpeedMB: inputCustomSpeed ? inputCustomSpeed.value : '10',
      chkWifiFriendly: chkWifiFriendly ? chkWifiFriendly.checked : true,
      cookies: inputCookies ? inputCookies.value.trim() : '',
      chkEngCaption: chkEngCaption ? chkEngCaption.checked : true,
      chkParaphrase: chkParaphrase ? chkParaphrase.checked : false,
      chkEnableGpu: chkEnableGpu ? chkEnableGpu.checked : true,
      chkRemoveMention: chkRemoveMention ? chkRemoveMention.checked : true,
      chkDownloadThumbnail: chkDownloadThumbnail ? chkDownloadThumbnail.checked : true,
      selectSubtitleLang: selectSubtitleLang ? selectSubtitleLang.value : 'zh-en'
    };
    localStorage.setItem(SNAPKEY_SETTINGS_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {}
}

function loadUserSettings() {
  try {
    const raw = localStorage.getItem(SNAPKEY_SETTINGS_STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data.workspaceDir && workspaceDirInput) workspaceDirInput.value = data.workspaceDir;
      if (data.videosSubpath && videosSubpathInput) videosSubpathInput.value = data.videosSubpath;
      if (data.photosSubpath && photosSubpathInput) photosSubpathInput.value = data.photosSubpath;
      if (data.fileType && selectFileType) selectFileType.value = data.fileType;
      if (data.fileFormat && selectFileFormat) selectFileFormat.value = data.fileFormat;
      if (data.videoCodec && selectVideoCodec) selectVideoCodec.value = data.videoCodec;
      if (data.bilibiliMode && selectBilibiliMode) selectBilibiliMode.value = data.bilibiliMode;
      if (data.threads && inputThreads) inputThreads.value = data.threads;
      if (data.speedLimitMode && selectSpeedLimit) selectSpeedLimit.value = data.speedLimitMode;
      if (data.customSpeedMB && inputCustomSpeed) inputCustomSpeed.value = data.customSpeedMB;
      if (typeof data.chkWifiFriendly === 'boolean' && chkWifiFriendly) chkWifiFriendly.checked = data.chkWifiFriendly;
      if (data.cookies && inputCookies) inputCookies.value = data.cookies;
      if (typeof data.chkEngCaption === 'boolean' && chkEngCaption) chkEngCaption.checked = data.chkEngCaption;
      if (typeof data.chkParaphrase === 'boolean' && chkParaphrase) chkParaphrase.checked = data.chkParaphrase;
      if (typeof data.chkEnableGpu === 'boolean' && chkEnableGpu) chkEnableGpu.checked = data.chkEnableGpu;
      if (typeof data.chkRemoveMention === 'boolean' && chkRemoveMention) chkRemoveMention.checked = data.chkRemoveMention;
      if (typeof data.chkDownloadThumbnail === 'boolean' && chkDownloadThumbnail) chkDownloadThumbnail.checked = data.chkDownloadThumbnail;
      if (data.selectSubtitleLang && selectSubtitleLang) selectSubtitleLang.value = data.selectSubtitleLang;
    }
  } catch (e) {}
  updateEngineIndicator();
}

// --- INITIALIZE APPLICATION ---
window.addEventListener('DOMContentLoaded', () => {
  loadUserSettings();
  renderQueueList();
  renderActivities();
  appendLiveLog({ level: 'info', message: 'SnapKee Studio Engine initialized with Smart Wi-Fi QoS & Anti-Bufferbloat Shield.' });

  // Auto-save setting changes & update QoS indicators
  if (selectSpeedLimit) {
    selectSpeedLimit.addEventListener('change', () => {
      updateEngineIndicator();
      saveUserSettings();
    });
  }
  if (inputCustomSpeed) {
    inputCustomSpeed.addEventListener('input', () => {
      updateEngineIndicator();
      saveUserSettings();
    });
  }
  if (chkWifiFriendly) {
    chkWifiFriendly.addEventListener('change', () => {
      updateEngineIndicator();
      saveUserSettings();
    });
  }

  [
    workspaceDirInput, videosSubpathInput, photosSubpathInput,
    selectFileType, selectFileFormat, selectVideoCodec, selectBilibiliMode,
    inputThreads, inputCookies, chkEngCaption, chkParaphrase,
    chkEnableGpu, chkRemoveMention, selectSubtitleLang, chkDownloadThumbnail
  ].filter(Boolean).forEach(el => {
    el.addEventListener('change', saveUserSettings);
    if (el.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number')) {
      el.addEventListener('input', saveUserSettings);
    }
  });

  // Platform pills click handler
  document.querySelectorAll('.platform-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      urlInput.focus();
      urlInput.placeholder = `Paste link for ${pill.textContent.trim()} here...`;
    });
  });
});

function extractCleanUrl(text) {
  if (!text || typeof text !== 'string') return '';
  const match = text.match(/https?:\/\/[^\s"'<>\n\r]+/i);
  if (match) {
    return match[0].trim().replace(/[.,;!]+$/, '');
  }
  return text.trim();
}

// --- CLIPBOARD PASTE IN HERO BAR ---
if (btnPasteClipboard) {
  btnPasteClipboard.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const clean = extractCleanUrl(text);
        urlInput.value = clean || text.trim();
        setStatus('Link pasted from clipboard', 'blue');
      }
    } catch {
      urlInput.focus();
    }
  });
}

// --- QUEUE MANAGEMENT ---
btnAddQueue.addEventListener('click', () => {
  const raw = urlInput.value.trim();
  const url = extractCleanUrl(raw);
  if (!url) return;
  
  if (!queueList.includes(url)) {
    queueList.push(url);
    renderQueueList();
    urlInput.value = '';
    setStatus(`Added 1 URL to batch queue (Total: ${queueList.length})`, 'blue');
  }
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (e.ctrlKey || e.shiftKey) {
      handleScrapeNow();
    } else {
      btnAddQueue.click();
    }
  }
});

if (btnPasteQueueList) {
  btnPasteQueueList.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const lines = text.split(/\r?\n/)
          .map(l => extractCleanUrl(l))
          .filter(l => l && (l.startsWith('http://') || l.startsWith('https://')));
        let added = 0;
        lines.forEach(l => {
          if (!queueList.includes(l)) {
            queueList.push(l);
            added++;
          }
        });
        renderQueueList();
        setStatus(`Imported ${added} URLs into batch queue.`, 'emerald');
      }
    } catch {
      alert('Unable to read clipboard. Please paste manually into the search box.');
    }
  });
}

if (btnClearQueue) {
  btnClearQueue.addEventListener('click', () => {
    queueList = [];
    renderQueueList();
    setStatus('Batch queue cleared.', 'slate');
  });
}

function renderQueueList() {
  queueCountBadge.textContent = queueList.length;

  if (queueList.length === 0) {
    if (queueEmptyState) queueEmptyState.classList.remove('hidden');
    if (queueItemsList) queueItemsList.innerHTML = '';
    return;
  }

  if (queueEmptyState) queueEmptyState.classList.add('hidden');
  queueItemsList.innerHTML = '';

  queueList.forEach((url, index) => {
    const card = document.createElement('div');
    card.className = 'group flex items-center justify-between p-2 rounded-lg bg-[#0d162d] hover:bg-[#142040] border border-[#1b2848] transition cursor-pointer';
    card.dataset.type = 'queue';
    card.dataset.index = index;

    const platform = detectPlatformName(url);
    const domain = getCleanDomain(url);

    card.innerHTML = `
      <div class="flex items-center space-x-2 min-w-0 flex-1">
        <span class="w-5 h-5 rounded bg-blue-950 border border-blue-500/40 text-blue-300 font-mono text-[10px] font-bold flex items-center justify-center shrink-0">
          ${index + 1}
        </span>
        <div class="flex flex-col min-w-0 flex-1">
          <span class="text-xs text-slate-200 font-medium truncate" title="${url}">${domain}</span>
          <span class="text-[10px] text-slate-400 font-mono truncate">${url}</span>
        </div>
      </div>
      <button class="text-slate-500 hover:text-red-400 text-xs px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition shrink-0" title="Remove URL">
        ✕
      </button>
    `;

    // Remove button
    card.querySelector('button').addEventListener('click', (e) => {
      e.stopPropagation();
      queueList.splice(index, 1);
      renderQueueList();
    });

    // Right click
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, 'queue', index);
    });

    queueItemsList.appendChild(card);
  });
}

// --- SCRAPING LOGIC ---
btnScrapeNow.addEventListener('click', handleScrapeNow);

async function handleScrapeNow() {
  const rawInput = urlInput.value.trim();
  const inputVal = extractCleanUrl(rawInput);
  let targetUrls = [...queueList];
  
  // If user typed a URL that isn't in queue yet, include it
  if (inputVal && !targetUrls.includes(inputVal)) {
    targetUrls.push(inputVal);
    if (!queueList.includes(inputVal)) {
      queueList.push(inputVal);
      renderQueueList();
    }
  }

  if (targetUrls.length === 0) {
    alert('Please enter or add at least one video link to scrape.');
    return;
  }

  startTimer();
  setStatus(`Scraping & analyzing ${targetUrls.length} target(s)...`, 'amber');
  btnScrapeNow.disabled = true;
  btnScrapeNow.innerHTML = `<span class="animate-spin text-sm">⏳</span> Analyzing...`;

  try {
    const response = await window.snapkeeAPI.scrapeQueue(targetUrls);
    if (response.success) {
      activitiesList = response.items;
      renderActivities();
      setStatus(`Scraping completed: ${activitiesList.length} media stream(s) detected.`, 'emerald');
      appendLiveLog({
        level: 'info',
        message: `Successfully detected ${activitiesList.length} video stream(s) from ${targetUrls.length} target URL(s).`
      });
    } else {
      setStatus(`Scrape failed: ${response.error}`, 'red');
      appendLiveLog({ level: 'error', message: `Scrape error: ${response.error}` });
    }
  } catch (error) {
    setStatus('Error connecting to scraper service.', 'red');
  } finally {
    btnScrapeNow.disabled = false;
    btnScrapeNow.innerHTML = `<span>⚡</span> Scrape & Analyze`;
    stopTimer();
  }
}

// --- ACTIVITIES (CARDS & TABLE) RENDERING ---
function renderActivities() {
  const filteredItems = getFilteredItems();
  activitiesCountBadge.textContent = `${filteredItems.length} ready`;
  updateDownloadCount();

  if (activitiesList.length === 0) {
    if (mediaEmptyState) mediaEmptyState.classList.remove('hidden');
    if (mediaCardsGrid) mediaCardsGrid.classList.add('hidden');
    if (mediaTableWrapper) mediaTableWrapper.classList.add('hidden');
    return;
  }

  if (mediaEmptyState) mediaEmptyState.classList.add('hidden');

  if (currentView === 'cards') {
    if (mediaCardsGrid) mediaCardsGrid.classList.remove('hidden');
    if (mediaTableWrapper) mediaTableWrapper.classList.add('hidden');
    renderCardsView(filteredItems);
  } else {
    if (mediaCardsGrid) mediaCardsGrid.classList.add('hidden');
    if (mediaTableWrapper) mediaTableWrapper.classList.remove('hidden');
    renderTableView(filteredItems);
  }

  updateSelectAllHeaderState();
}

function getFilteredItems() {
  if (currentFilter === 'all') return activitiesList;
  if (currentFilter === 'youtube') return activitiesList.filter(i => String(i.platform).toLowerCase().includes('youtube'));
  if (currentFilter === 'bilibili') return activitiesList.filter(i => String(i.platform).toLowerCase().includes('bili'));
  if (currentFilter === 'other') {
    return activitiesList.filter(i => {
      const p = String(i.platform).toLowerCase();
      return !p.includes('youtube') && !p.includes('bili');
    });
  }
  return activitiesList;
}

// --- CARDS VIEW RENDERER ---
function renderCardsView(items) {
  mediaCardsGrid.innerHTML = '';

  items.forEach((item) => {
    const origIndex = activitiesList.indexOf(item);
    const completed = isCompletedItem(item);
    const card = document.createElement('div');
    card.className = `media-card p-3 flex flex-col justify-between ${completed ? 'card-completed' : item.selected ? 'card-selected' : ''}`;
    card.dataset.id = item.id;
    card.dataset.index = origIndex;

    const platformBadgeHtml = getPlatformBadgeHtml(item.platform);
    const subtitleBadgeHtml = getSubtitleBadgeHtml(item);
    const timeRangeBadgeHtml = getTimeRangeBadgeHtml(item, origIndex);
    const statusBadgeHtml = getStatusBadgeHtml(item);
    const thumbnailSrc = item.thumbnail || getPlatformDefaultThumbnail(item.platform);

    card.innerHTML = `
      <div>
        <!-- Top: Platform Badge, Duration & Checkbox -->
        <div class="flex items-center justify-between gap-2 mb-2">
          <div class="flex items-center gap-1.5">
            <input type="checkbox" class="custom-checkbox row-checkbox" data-index="${origIndex}" ${item.selected ? 'checked' : ''} ${completed ? 'disabled' : ''}>
            ${platformBadgeHtml}
          </div>
          <div class="flex items-center gap-1.5 text-[10px] text-slate-400 font-mono">
            <span>#${origIndex + 1}</span>
            ${item.sizeMB ? `<span class="bg-[#0b101e] px-1.5 py-0.2 rounded border border-slate-700/50">${item.sizeMB} MB</span>` : ''}
          </div>
        </div>

        <!-- Middle: Thumbnail Preview & Title Metadata -->
        <div class="flex gap-2.5">
          <div class="thumbnail-box shadow-md">
            <img src="${thumbnailSrc}" alt="Thumbnail" class="thumbnail-img" onerror="this.src='https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=300&q=80'">
            ${item.duration ? `<span class="duration-tag">${item.duration}</span>` : ''}
            ${item.resolution ? `<span class="res-tag">${item.resolution}</span>` : ''}
          </div>

          <div class="flex-1 min-w-0 flex flex-col justify-between py-0.5">
            <h4 class="text-xs font-semibold text-slate-100 line-clamp-2 leading-snug" title="${item.title}">
              ${item.title}
            </h4>
            <div class="flex items-center gap-1 text-[11px] text-blue-300 font-medium truncate mt-1">
              <span>👤</span>
              <span class="truncate">${item.profile || item.platform}</span>
            </div>
            <div class="mt-1.5 flex items-center gap-1.5 flex-wrap">
              ${subtitleBadgeHtml}
              ${timeRangeBadgeHtml}
            </div>
          </div>
        </div>
      </div>

      <!-- Bottom: Status & Realtime Progress -->
      <div class="mt-3 pt-2 border-t border-slate-800/80">
        <div class="flex items-center justify-between text-xs">
          ${statusBadgeHtml}
          ${item.speedMbps && item.speedMbps !== '0.00' ? `<span class="text-[10px] font-mono text-cyan-300 font-bold">${item.speedMbps} Mbps</span>` : ''}
        </div>
        ${item.percentage !== undefined && item.percentage > 0 && item.percentage < 100 ? `
          <div class="row-progress-bg">
            <div class="row-progress-fill" style="width: ${item.percentage}%"></div>
          </div>
        ` : ''}
      </div>
    `;

    // Checkbox toggle
    const checkbox = card.querySelector('.row-checkbox');
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      activitiesList[origIndex].selected = checkbox.checked;
      updateSelectAllHeaderState();
      updateDownloadCount();
      card.className = `media-card p-3 flex flex-col justify-between ${checkbox.checked ? 'card-selected' : ''}`;
    });

    // Right-click menu
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, 'activity', origIndex);
    });

    // Double-click to open file if completed
    card.addEventListener('dblclick', () => {
      if (item.filePath && isCompletedItem(item)) {
        window.snapkeeAPI.openInFolder(item.filePath);
      }
    });

    mediaCardsGrid.appendChild(card);
  });
}

// --- TABLE VIEW RENDERER ---
function renderTableView(items) {
  activitiesTableBody.innerHTML = '';

  items.forEach((item) => {
    const origIndex = activitiesList.indexOf(item);
    const completed = isCompletedItem(item);
    const tr = document.createElement('tr');
    tr.className = `transition ${completed ? 'completed-row' : item.selected ? 'selected-row' : ''}`;
    tr.dataset.id = item.id;
    tr.dataset.index = origIndex;

    const platformBadgeHtml = getPlatformBadgeHtml(item.platform);
    const subtitleBadgeHtml = getSubtitleBadgeHtml(item);
    const timeRangeBadgeHtml = getTimeRangeBadgeHtml(item, origIndex);
    const statusBadgeHtml = getStatusBadgeHtml(item);
    const thumbnailSrc = item.thumbnail || getPlatformDefaultThumbnail(item.platform);

    tr.innerHTML = `
      <td class="text-center">
        <input type="checkbox" class="custom-checkbox row-checkbox" data-index="${origIndex}" ${item.selected ? 'checked' : ''} ${completed ? 'disabled' : ''}>
      </td>
      <td class="text-center text-slate-400 font-mono text-xs">${origIndex + 1}</td>
      <td>
        <div class="w-14 h-9 rounded bg-[#0b101e] border border-slate-700/60 overflow-hidden relative">
          <img src="${thumbnailSrc}" class="w-full h-full object-cover" onerror="this.src='https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=100&q=80'">
          ${item.duration ? `<span class="absolute bottom-0 right-0 bg-black/80 text-slate-200 text-[8px] font-mono px-1 rounded-tl">${item.duration}</span>` : ''}
        </div>
      </td>
      <td class="max-w-[260px]">
        <div class="flex flex-col">
          <span class="font-semibold text-slate-100 text-xs truncate" title="${item.title}">${item.title}</span>
          <div class="flex items-center gap-1.5 mt-0.5">
            <span class="text-[10px] text-blue-300 font-medium truncate">${item.profile || item.platform}</span>
            ${timeRangeBadgeHtml}
          </div>
        </div>
      </td>
      <td>${platformBadgeHtml}</td>
      <td class="font-mono text-xs text-slate-300">${item.resolution || '1080p'}</td>
      <td class="font-mono text-xs text-slate-300">${item.sizeMB || '25.0'} MB</td>
      <td>${subtitleBadgeHtml}</td>
      <td class="min-w-[170px]">
        <div class="flex flex-col">
          <div class="flex items-center justify-between">
            ${statusBadgeHtml}
            ${item.speedMbps && item.speedMbps !== '0.00' ? `<span class="text-[10px] font-mono text-cyan-300">${item.speedMbps} Mbps</span>` : ''}
          </div>
          ${item.percentage !== undefined && item.percentage > 0 && item.percentage < 100 ? `
            <div class="row-progress-bg">
              <div class="row-progress-fill" style="width: ${item.percentage}%"></div>
            </div>
          ` : ''}
        </div>
      </td>
      <td class="text-center">
        <div class="flex items-center justify-center gap-1">
          <button class="text-slate-400 hover:text-cyan-300 p-1 rounded transition" title="Set Time Range (Clip)" onclick="handleOpenItemTimeRange(${origIndex}, event)">
            ✂️
          </button>
          <button class="text-slate-400 hover:text-cyan-300 p-1 rounded transition" title="Open Folder" onclick="handleOpenItemFolder(${origIndex})">
            📂
          </button>
        </div>
      </td>
    `;

    // Checkbox toggle
    const checkbox = tr.querySelector('.row-checkbox');
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      activitiesList[origIndex].selected = checkbox.checked;
      updateSelectAllHeaderState();
      updateDownloadCount();
      tr.className = `transition ${checkbox.checked ? 'selected-row' : ''}`;
    });

    // Right-click menu
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, 'activity', origIndex);
    });

    activitiesTableBody.appendChild(tr);
  });
}

// --- BADGE GENERATORS ---
function getPlatformBadgeHtml(platform) {
  const p = String(platform || 'Direct').toLowerCase();
  if (p.includes('youtube')) return `<span class="platform-pill platform-youtube" title="Local Speed Channel"><span>🔴</span> YouTube <span class="text-[9px] text-amber-300 font-mono font-bold">(Local)</span></span>`;
  if (p.includes('bilibili') || p.includes('bili')) return `<span class="platform-pill platform-bilibili" title="Global Speed Channel"><span>🔵</span> BiliBili <span class="text-[9px] text-blue-300 font-mono font-bold">(Global)</span></span>`;
  if (p.includes('tiktok')) return `<span class="platform-pill platform-tiktok" title="Local Speed Channel"><span>🎵</span> TikTok <span class="text-[9px] text-amber-300 font-mono font-bold">(Local)</span></span>`;
  if (p.includes('facebook')) return `<span class="platform-pill platform-facebook" title="Local Speed Channel"><span>📘</span> Facebook <span class="text-[9px] text-amber-300 font-mono font-bold">(Local)</span></span>`;
  if (p.includes('instagram')) return `<span class="platform-pill platform-instagram" title="Local Speed Channel"><span>📸</span> Instagram <span class="text-[9px] text-amber-300 font-mono font-bold">(Local)</span></span>`;
  if (p.includes('twitter') || p.includes('x')) return `<span class="platform-pill platform-twitter" title="Local Speed Channel"><span>🐦</span> Twitter/X <span class="text-[9px] text-amber-300 font-mono font-bold">(Local)</span></span>`;
  if (p.includes('dramabox')) return `<span class="platform-pill platform-dramabox" title="Global Speed Channel"><span>🎬</span> DramaBox <span class="text-[9px] text-blue-300 font-mono font-bold">(Global)</span></span>`;
  if (p.includes('novelquick') || p.includes('hongguo')) return `<span class="platform-pill platform-novelquick" title="Global Speed Channel"><span>🍎</span> NovelQuick <span class="text-[9px] text-orange-300 font-mono font-bold">(Global)</span></span>`;
  if (p.includes('odysee') || p.includes('lbry')) return `<span class="platform-pill platform-odysee" title="Global Speed Channel"><span>🚀</span> Odysee <span class="text-[9px] text-blue-300 font-mono font-bold">(Global)</span></span>`;
  if (p.includes('donghua')) return `<span class="platform-pill platform-donghua" title="Global Speed Channel"><span>🐉</span> Donghua <span class="text-[9px] text-blue-300 font-mono font-bold">(Global)</span></span>`;
  if (p.includes('dailymotion')) return `<span class="platform-pill platform-dailymotion" title="Global Speed Channel"><span>▶️</span> Dailymotion <span class="text-[9px] text-blue-300 font-mono font-bold">(Global)</span></span>`;
  if (p.includes('ganjing')) return `<span class="platform-pill platform-ganjing" title="Global Speed Channel"><span>⭐</span> GanJing <span class="text-[9px] text-blue-300 font-mono font-bold">(Global)</span></span>`;
  return `<span class="platform-pill platform-generic" title="Global Speed Channel"><span>🌐</span> ${platform || 'Direct'} <span class="text-[9px] text-blue-300 font-mono font-bold">(Global)</span></span>`;
}

function getSubtitleBadgeHtml(item) {
  if (item.hasAiSubtitle) {
    return `<span class="badge-subtitle-ai"><span>✨</span> AI-Sub [zh]</span>`;
  }
  if (item.hasCC) {
    const langs = Array.isArray(item.subtitleLangs) && item.subtitleLangs.length > 0 ? item.subtitleLangs.join(', ') : 'en, zh';
    return `<span class="badge-subtitle-cc" title="Auto-Extract 1 Best Subtitle (.srt)"><span>✓</span> CC [${langs}]</span>`;
  }
  return `<span class="text-[10px] text-slate-500 font-mono">No Subtitle</span>`;
}

function getTimeRangeBadgeHtml(item, index) {
  const tr = item.timeRange;
  if (tr && tr.enabled) {
    const label = tr.label || `${tr.start || '00:00:00'} → ${tr.toEnd ? 'End' : (tr.end || 'End')}`;
    return `<button type="button" class="time-range-pill active bg-amber-950/80 hover:bg-amber-900 border border-amber-500/60 text-amber-300 text-[9px] font-bold px-1.5 py-0.5 rounded cursor-pointer transition shadow-sm" onclick="handleOpenItemTimeRange(${index}, event)" title="Custom Range Active: ${label} (Click to edit)">✂️ ${label}</button>`;
  }
  return `<button type="button" class="time-range-pill bg-[#0b101e] hover:bg-[#151f38] border border-slate-700/60 hover:border-slate-500 text-slate-400 hover:text-cyan-300 text-[9px] px-1.5 py-0.5 rounded cursor-pointer transition" onclick="handleOpenItemTimeRange(${index}, event)" title="Click to cut / download section (e.g. 9h to last hour)">✂️ Full Video</button>`;
}

function getStatusBadgeHtml(item) {
  const st = item.status || 'Ready';
  if (st.includes('Completed') || item.completed) {
    return `<span class="status-badge status-completed"><span>✓</span> Completed</span>`;
  }
  if (st.includes('Downloading') || st.includes('Merging') || st.includes('Fetching') || st.includes('Remuxing')) {
    return `<span class="status-badge status-downloading"><span class="animate-spin text-xs">⏳</span> ${st}</span>`;
  }
  if (st.includes('Error')) {
    const safeSt = st.replace(/"/g, '&quot;');
    return `<span class="status-badge status-error" title="${safeSt}"><span>❌</span> Failed</span>`;
  }
  if (st.includes('Cancelled')) {
    return `<span class="status-badge status-error"><span>⏹️</span> Cancelled</span>`;
  }
  return `<span class="status-badge status-ready"><span>⏳</span> Ready</span>`;
}

function getPlatformDefaultThumbnail(platform) {
  const p = String(platform || '').toLowerCase();
  if (p.includes('youtube')) return 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=300&q=80';
  if (p.includes('bilibili')) return 'https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=300&q=80';
  if (p.includes('tiktok')) return 'https://images.unsplash.com/photo-1596526131083-e8c633c948d2?w=300&q=80';
  return 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=300&q=80';
}

function isCompletedItem(item) {
  return String(item?.status || '').includes('Completed') || !!item?.completed;
}

function updateDownloadCount() {
  const count = activitiesList.filter(i => i.selected && !isCompletedItem(i)).length;
  if (btnDownloadCount) btnDownloadCount.textContent = count;
}

// --- SELECT ALL & FILTER CONTROLS ---
selectAllCheckbox.addEventListener('change', () => {
  const isChecked = selectAllCheckbox.checked;
  activitiesList.forEach(item => {
    if (!isCompletedItem(item)) item.selected = isChecked;
  });
  renderActivities();
});

if (tableSelectAllCheckbox) {
  tableSelectAllCheckbox.addEventListener('change', () => {
    const isChecked = tableSelectAllCheckbox.checked;
    activitiesList.forEach(item => {
      if (!isCompletedItem(item)) item.selected = isChecked;
    });
    renderActivities();
  });
}

function updateSelectAllHeaderState() {
  const selectable = activitiesList.filter(item => !isCompletedItem(item));
  if (selectable.length === 0) {
    selectAllCheckbox.checked = false;
    selectAllCheckbox.indeterminate = false;
    if (tableSelectAllCheckbox) {
      tableSelectAllCheckbox.checked = false;
      tableSelectAllCheckbox.indeterminate = false;
    }
    return;
  }
  const allChecked = selectable.every(i => i.selected);
  const anyChecked = selectable.some(i => i.selected);
  selectAllCheckbox.checked = allChecked;
  selectAllCheckbox.indeterminate = !allChecked && anyChecked;
  if (tableSelectAllCheckbox) {
    tableSelectAllCheckbox.checked = allChecked;
    tableSelectAllCheckbox.indeterminate = !allChecked && anyChecked;
  }
}

btnClearAll.addEventListener('click', () => {
  activitiesList = [];
  renderActivities();
  setStatus('Media workspace cleared.', 'slate');
});

// --- VIEW SWITCHER ---
btnViewCards.addEventListener('click', () => {
  currentView = 'cards';
  btnViewCards.className = 'px-2 py-0.5 rounded text-[11px] font-semibold text-cyan-300 bg-blue-600/30 shadow-sm';
  btnViewTable.className = 'px-2 py-0.5 rounded text-[11px] font-semibold text-slate-400 hover:text-slate-200';
  renderActivities();
});

btnViewTable.addEventListener('click', () => {
  currentView = 'table';
  btnViewTable.className = 'px-2 py-0.5 rounded text-[11px] font-semibold text-cyan-300 bg-blue-600/30 shadow-sm';
  btnViewCards.className = 'px-2 py-0.5 rounded text-[11px] font-semibold text-slate-400 hover:text-slate-200';
  renderActivities();
});

// --- FILTER BUTTONS ---
filterBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    filterBtns.forEach(b => {
      b.className = 'filter-btn text-slate-400 hover:text-slate-200 px-2 py-0.5 rounded';
    });
    btn.className = 'filter-btn active bg-blue-600/30 border border-blue-500/40 text-blue-300 px-2 py-0.5 rounded';
    currentFilter = btn.dataset.filter;
    renderActivities();
  });
});

// --- DIRECTORY MANAGEMENT ---
btnBrowseDir.addEventListener('click', async () => {
  const selectedPath = await window.snapkeeAPI.selectFolder();
  if (selectedPath) {
    const cleanPath = selectedPath.replace(/\\/g, '/');
    workspaceDirInput.value = cleanPath;
    videosSubpathInput.value = `${cleanPath}/video`;
    photosSubpathInput.value = `${cleanPath}/photo`;
    setStatus(`Target workspace set to: ${cleanPath}`, 'emerald');
  }
});

workspaceDirInput.addEventListener('input', () => {
  const val = workspaceDirInput.value.trim().replace(/\\/g, '/');
  videosSubpathInput.value = `${val}/video`;
  photosSubpathInput.value = `${val}/photo`;
});

if (btnOpenTargetDir) {
  btnOpenTargetDir.addEventListener('click', () => {
    const p = workspaceDirInput.value.trim();
    if (p && window.snapkeeAPI) {
      window.snapkeeAPI.openInFolder(p);
    }
  });
}

if (btnOpenDownloadsFolder) {
  btnOpenDownloadsFolder.addEventListener('click', () => {
    const p = workspaceDirInput.value.trim();
    if (p && window.snapkeeAPI) {
      window.snapkeeAPI.openInFolder(p);
    }
  });
}

if (btnBrowseCookies) {
  btnBrowseCookies.addEventListener('click', async () => {
    if (window.snapkeeAPI && window.snapkeeAPI.selectFile) {
      const selectedFile = await window.snapkeeAPI.selectFile();
      if (selectedFile) {
        if (inputCookies) inputCookies.value = selectedFile.replace(/\\/g, '/');
        saveUserSettings();
        setStatus(`Cookies auth set to: ${selectedFile.replace(/\\/g, '/')}`, 'emerald');
      }
    }
  });
}

// --- DOWNLOADING EXECUTION ---
btnDownloadNow.addEventListener('click', async () => {
  const selectedItems = activitiesList.filter(i => i.selected && !isCompletedItem(i));
  const skippedCompleted = activitiesList.filter(i => i.selected && isCompletedItem(i));
  
  if (selectedItems.length === 0) {
    if (skippedCompleted.length > 0) {
      setStatus('Selected items have already finished downloading.', 'emerald');
      return;
    }
    alert('Please select at least one media item to download.');
    return;
  }

  const subtitlePref = selectSubtitleLang ? selectSubtitleLang.value : 'zh-en';
  let subtitleLangList = 'zh-Hans,zh-Hant,zh-CN,zh-TW,zh-HK,zh,cmn,en,en-US,en-GB,en-orig';
  if (subtitlePref === 'en') {
    subtitleLangList = 'en,en-US,en-GB,en-orig,zh-Hans,zh-Hant,zh-CN,zh-TW,zh-HK,zh,cmn';
  } else if (subtitlePref === 'zh-only') {
    subtitleLangList = 'zh-Hans,zh-Hant,zh-CN,zh-TW,zh-HK,zh,cmn';
  } else if (subtitlePref === 'en-only') {
    subtitleLangList = 'en,en-US,en-GB,en-orig';
  } else if (subtitlePref === 'all') {
    subtitleLangList = 'zh-Hans,zh-Hant,zh,en,en-US,en-orig,ja,ko,es,fr,de,ru,vi,th,id,ar';
  }

  const speedMode = selectSpeedLimit ? selectSpeedLimit.value : 'unlimited';
  const customSpeed = inputCustomSpeed ? (parseFloat(inputCustomSpeed.value) || 10) : 10;
  const wifiLag = chkWifiFriendly ? chkWifiFriendly.checked : true;

  const settings = {
    directory: workspaceDirInput.value.trim(),
    threads: Math.max(2, Math.min(16, parseInt(inputThreads.value) || 16)),
    itemConcurrency: 4,
    globalConcurrency: 2,
    localConcurrency: 2,
    speedLimitMode: speedMode,
    customSpeedMB: customSpeed,
    wifiFriendly: wifiLag,
    bilibiliMode: selectBilibiliMode ? selectBilibiliMode.value : 'fast',
    bilibiliThreads: selectBilibiliMode
      ? (selectBilibiliMode.value === 'fast' ? 16 : selectBilibiliMode.value === 'stable' ? 8 : 12)
      : 16,
    fileType: selectFileType.value,
    fileFormat: selectFileFormat.value,
    videoCodec: selectVideoCodec ? selectVideoCodec.value : 'quality',
    downloadThumbnails: chkDownloadThumbnail ? chkDownloadThumbnail.checked : true,
    downloadSubtitles: selectFileFormat.value !== 'Video Only (.mp4)' && selectFileFormat.value !== 'Audio MP3 Only',
    subtitleOnly: selectFileFormat.value === 'Subtitle Only (.srt)',
    autoSubtitles: true,
    downloadAutoSubtitles: true,
    subtitlePriority: subtitlePref,
    subtitleLanguagePref: subtitlePref,
    subtitleLanguage: subtitleLangList,
    englishCaption: chkEngCaption ? chkEngCaption.checked : true,
    paraphraseCaption: chkParaphrase ? chkParaphrase.checked : false,
    cookies: inputCookies ? inputCookies.value.trim() : ''
  };

  startTimer();
  setStatus(`Launching dual-speed download (${selectedItems.length} streams: 2 Global + 2 Local together)...`, 'blue');
  downloadSummaryBar.classList.remove('hidden');
  downloadSummaryBar.classList.add('flex');
  summaryProgressText.textContent = `0 / ${selectedItems.length} Completed`;

  btnDownloadNow.disabled = true;
  btnDownloadNow.classList.add('opacity-75');
  appendLiveLog({
    level: 'info',
    message: `Starting dual-speed download for ${selectedItems.length} item(s) [2 Global (Bilibili) + 2 Local (YouTube) together, Mode: ${speedMode}, QoS: ${wifiLag ? 'Active' : 'Off'}]${settings.subtitleOnly ? ' (subtitle only)' : ' (video + best .srt)'}.`
  });

  const result = await window.snapkeeAPI.startDownload(selectedItems, settings);
  if (!result.success) {
    setStatus(`Download launch error: ${result.error}`, 'red');
    btnDownloadNow.disabled = false;
    btnDownloadNow.classList.remove('opacity-75');
    stopTimer();
  }
});

btnCancel.addEventListener('click', async () => {
  await window.snapkeeAPI.cancelDownload();
  setStatus('All active downloads stopped by user.', 'red');
  appendLiveLog({ level: 'warn', message: 'Download cancelled by user.' });
  btnDownloadNow.disabled = false;
  btnDownloadNow.classList.remove('opacity-75');
  stopTimer();
  speedDisplay.textContent = '0.00 Mbps';
});

// --- LIVE LOGS & TELEMETRY ---
function formatLogTime(ts) {
  const d = new Date(ts || Date.now());
  return d.toTimeString().slice(0, 8);
}

function appendLiveLog(entry) {
  if (!liveLogPanel) return;

  const wasNearBottom = liveLogPanel.scrollTop + liveLogPanel.clientHeight >= liveLogPanel.scrollHeight - 30;
  const level = String(entry?.level || 'info').toLowerCase();

  const row = document.createElement('div');
  row.className = `log-entry log-${level}`;

  const ts = document.createElement('span');
  ts.className = 'log-ts';
  ts.textContent = formatLogTime(entry?.ts);

  const lvl = document.createElement('span');
  lvl.className = 'log-level';
  lvl.textContent = level;

  const msg = document.createElement('span');
  msg.className = 'log-message';
  const elapsed = typeof entry?.elapsedMs === 'number' ? `+${Math.max(0, Math.round(entry.elapsedMs))}ms ` : '';
  const itemTag = entry?.itemId !== undefined ? `[Item #${entry.itemId}] ` : '';
  msg.textContent = `${elapsed}${itemTag}${entry?.message || ''}`;

  row.appendChild(ts);
  row.appendChild(lvl);
  row.appendChild(msg);
  liveLogPanel.appendChild(row);

  while (liveLogPanel.children.length > MAX_LOG_ROWS) {
    liveLogPanel.removeChild(liveLogPanel.firstChild);
  }

  if (wasNearBottom) {
    liveLogPanel.scrollTop = liveLogPanel.scrollHeight;
  }
}

async function copyTextToClipboard(text) {
  if (!text) return false;
  try {
    if (window.snapkeeAPI && typeof window.snapkeeAPI.copyToClipboard === 'function') {
      const res = await window.snapkeeAPI.copyToClipboard(text);
      if (res && res.success) return true;
    }
  } catch (err) {
    console.warn('Native copyToClipboard failed:', err);
  }
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn('navigator.clipboard.writeText failed:', err);
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(ta);
    return successful;
  } catch (err) {
    console.error('All clipboard methods failed:', err);
    return false;
  }
}

async function copyLogContent(forceAll = false) {
  if (!liveLogPanel) return;

  let textToCopy = '';
  const sel = window.getSelection ? window.getSelection() : null;
  const selText = sel ? sel.toString().trim() : '';

  if (!forceAll && selText && liveLogPanel.contains(sel.anchorNode)) {
    textToCopy = selText;
  } else {
    const entries = Array.from(liveLogPanel.querySelectorAll('.log-entry'));
    if (entries.length === 0) {
      if (btnCopyLogText) {
        btnCopyLogText.textContent = 'No Logs';
        setTimeout(() => {
          if (btnCopyLogText) btnCopyLogText.textContent = 'Copy Logs';
        }, 1500);
      }
      return;
    }
    textToCopy = entries.map(row => {
      const ts = row.querySelector('.log-ts')?.textContent?.trim() || '';
      const lvl = (row.querySelector('.log-level')?.textContent?.trim() || 'INFO').toUpperCase();
      const msg = row.querySelector('.log-message')?.textContent || '';
      return `[${ts}] [${lvl}] ${msg}`;
    }).join('\n');
  }

  const success = await copyTextToClipboard(textToCopy);
  if (success && btnCopyLog) {
    btnCopyLog.classList.add('copied');
    if (btnCopyLogText) btnCopyLogText.textContent = 'Copied! ✓';
    setTimeout(() => {
      btnCopyLog.classList.remove('copied');
      if (btnCopyLogText) btnCopyLogText.textContent = 'Copy Logs';
    }, 2000);
  }
}

if (btnCopyLog) {
  btnCopyLog.addEventListener('click', () => {
    copyLogContent(false);
  });
}

if (btnClearLog) {
  btnClearLog.addEventListener('click', () => {
    if (liveLogPanel) liveLogPanel.innerHTML = '';
    appendLiveLog({ level: 'info', message: 'Live log cleared.' });
  });
}

if (btnToggleLogSize) {
  btnToggleLogSize.addEventListener('click', () => {
    if (logShell.style.height === '8.5rem') {
      logShell.style.height = '14rem';
    } else {
      logShell.style.height = '8.5rem';
    }
  });
}

if (liveLogPanel) {
  liveLogPanel.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, 'log');
  });

  liveLogPanel.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      const sel = window.getSelection ? window.getSelection().toString().trim() : '';
      if (!sel) {
        copyLogContent(true);
      }
    }
  });
}

// --- IPC EVENT LISTENERS ---
if (window.snapkeeAPI) {
  window.snapkeeAPI.onProgress((data) => {
    const targetItem = activitiesList.find(i => i.id === data.id);
    if (targetItem) {
      targetItem.status = data.status;
      if (data.percentage !== undefined) targetItem.percentage = data.percentage;
      if (data.downloadedMB !== undefined) targetItem.downloadedMB = data.downloadedMB;
      if (data.speedMbps !== undefined) targetItem.speedMbps = data.speedMbps;
      if (data.filePath) targetItem.filePath = data.filePath;
      if (String(data.status || '').includes('Completed')) {
        targetItem.completed = true;
        targetItem.selected = false;
      }

      // Update card or row in place
      if (currentView === 'cards') {
        const card = mediaCardsGrid.querySelector(`div[data-id="${data.id}"]`);
        if (card) {
          const statusDiv = card.querySelector('.mt-3');
          if (statusDiv) {
            statusDiv.innerHTML = `
              <div class="flex items-center justify-between text-xs">
                ${getStatusBadgeHtml(targetItem)}
                ${targetItem.speedMbps && targetItem.speedMbps !== '0.00' ? `<span class="text-[10px] font-mono text-cyan-300 font-bold">${targetItem.speedMbps} Mbps</span>` : ''}
              </div>
              ${targetItem.percentage !== undefined && targetItem.percentage > 0 && targetItem.percentage < 100 ? `
                <div class="row-progress-bg">
                  <div class="row-progress-fill" style="width: ${targetItem.percentage}%"></div>
                </div>
              ` : ''}
            `;
          }
          if (isCompletedItem(targetItem)) {
            card.className = 'media-card p-3 flex flex-col justify-between card-completed';
            const cb = card.querySelector('.row-checkbox');
            if (cb) { cb.checked = false; cb.disabled = true; }
          }
        }
      } else {
        const tr = activitiesTableBody.querySelector(`tr[data-id="${data.id}"]`);
        if (tr) {
          const statusTd = tr.children[8];
          if (statusTd) {
            statusTd.innerHTML = `
              <div class="flex flex-col">
                <div class="flex items-center justify-between">
                  ${getStatusBadgeHtml(targetItem)}
                  ${targetItem.speedMbps && targetItem.speedMbps !== '0.00' ? `<span class="text-[10px] font-mono text-cyan-300">${targetItem.speedMbps} Mbps</span>` : ''}
                </div>
                ${targetItem.percentage !== undefined && targetItem.percentage > 0 && targetItem.percentage < 100 ? `
                  <div class="row-progress-bg">
                    <div class="row-progress-fill" style="width: ${targetItem.percentage}%"></div>
                  </div>
                ` : ''}
              </div>
            `;
          }
          if (isCompletedItem(targetItem)) {
            tr.className = 'transition completed-row';
            const cb = tr.querySelector('.row-checkbox');
            if (cb) { cb.checked = false; cb.disabled = true; }
          }
        }
      }

      updateDownloadCount();
    }
  });

  window.snapkeeAPI.onGlobalMetrics((data) => {
    const mbps = parseFloat(data.totalSpeedMbps || 0);
    const mBps = (mbps / 8).toFixed(2);
    speedDisplay.textContent = `${data.totalSpeedMbps || '0.00'} Mbps`;
    speedDisplay.title = `${mBps} MB/s (Wi-Fi QoS Bandwidth)`;
    if (data.total > 0) {
      summaryProgressText.textContent = `${data.completed} / ${data.total} Completed`;
      const poolDetail = (data.runningGlobal !== undefined && data.runningLocal !== undefined)
        ? ` (${data.running} active: ${data.runningGlobal} Global + ${data.runningLocal} Local, ${mBps} MB/s)`
        : ` (${data.running} active stream${data.running > 1 ? 's' : ''}, ${mBps} MB/s)`;
      setStatus(`Downloading: ${data.completed}/${data.total} completed${poolDetail}...`, 'blue');
    }
  });

  window.snapkeeAPI.onLog((data) => {
    appendLiveLog(data);
  });

  window.snapkeeAPI.onQueueCompleted((data) => {
    if (data.completed === 0 && data.total > 0) {
      setStatus(`All downloads failed (${data.completed}/${data.total})!`, 'red');
    } else if (data.completed < data.total) {
      setStatus(`Downloads finished with some errors (${data.completed}/${data.total}).`, 'amber');
    } else {
      setStatus(`All parallel downloads finished successfully (${data.completed}/${data.total})!`, 'emerald');
    }
    btnDownloadNow.disabled = false;
    btnDownloadNow.classList.remove('opacity-75');
    stopTimer();
    speedDisplay.textContent = '0.00 Mbps';
    updateDownloadCount();
  });

  window.snapkeeAPI.onScrapeProgress((data) => {
    setStatus(`Scraping target ${data.current}/${data.total}: ${data.url}`, 'amber');
  });
}

// --- CONTEXT MENU HANDLING ---
function showContextMenu(e, type, index) {
  activeContextTarget = { type, index };
  
  const menuSelect = document.getElementById('menuSelect');
  const menuUnselect = document.getElementById('menuUnselect');
  const menuDividerQueue = document.getElementById('menuDividerQueue');
  const menuPasteLinks = document.getElementById('menuPasteLinks');
  const menuOpenLink = document.getElementById('menuOpenLink');
  const menuDividerActivity = document.getElementById('menuDividerActivity');
  const menuFolder = document.getElementById('menuOpenFolder');
  const menuTimeRange = document.getElementById('menuSetTimeRange');
  const menuDelete = document.getElementById('menuDeleteSelected');

  const menuCopySelectedLog = document.getElementById('menuCopySelectedLog');
  const menuCopyAllLogs = document.getElementById('menuCopyAllLogs');
  const menuDividerLog = document.getElementById('menuDividerLog');
  const menuClearLogCtx = document.getElementById('menuClearLogCtx');

  if (type === 'log') {
    if (menuSelect) menuSelect.style.display = 'none';
    if (menuUnselect) menuUnselect.style.display = 'none';
    if (menuDividerQueue) menuDividerQueue.style.display = 'none';
    if (menuPasteLinks) menuPasteLinks.style.display = 'none';
    if (menuOpenLink) menuOpenLink.style.display = 'none';
    if (menuDividerActivity) menuDividerActivity.style.display = 'none';
    if (menuFolder) menuFolder.style.display = 'none';
    if (menuTimeRange) menuTimeRange.style.display = 'none';
    if (menuDelete) menuDelete.style.display = 'none';

    const sel = window.getSelection ? window.getSelection().toString().trim() : '';
    if (menuCopySelectedLog) menuCopySelectedLog.style.display = sel ? 'flex' : 'none';
    if (menuCopyAllLogs) menuCopyAllLogs.style.display = 'flex';
    if (menuDividerLog) menuDividerLog.style.display = 'block';
    if (menuClearLogCtx) menuClearLogCtx.style.display = 'flex';
  } else {
    if (menuCopySelectedLog) menuCopySelectedLog.style.display = 'none';
    if (menuCopyAllLogs) menuCopyAllLogs.style.display = 'none';
    if (menuDividerLog) menuDividerLog.style.display = 'none';
    if (menuClearLogCtx) menuClearLogCtx.style.display = 'none';

    if (type === 'queue') {
      if (menuSelect) menuSelect.style.display = 'none';
      if (menuUnselect) menuUnselect.style.display = 'none';
      if (menuDividerQueue) menuDividerQueue.style.display = 'block';
      if (menuPasteLinks) menuPasteLinks.style.display = 'flex';
      if (menuOpenLink) menuOpenLink.style.display = 'flex';
      if (menuDividerActivity) menuDividerActivity.style.display = 'none';
      if (menuFolder) menuFolder.style.display = 'none';
      if (menuTimeRange) menuTimeRange.style.display = 'none';
      if (menuDelete) menuDelete.style.display = 'flex';
    } else {
      if (menuSelect) menuSelect.style.display = 'flex';
      if (menuUnselect) menuUnselect.style.display = 'flex';
      if (menuDividerQueue) menuDividerQueue.style.display = 'block';
      if (menuPasteLinks) menuPasteLinks.style.display = 'flex';
      if (menuOpenLink) menuOpenLink.style.display = 'flex';
      if (menuDividerActivity) menuDividerActivity.style.display = 'block';
      const item = activitiesList[index];
      if (menuFolder) menuFolder.style.display = (item && item.filePath) ? 'flex' : 'none';
      if (menuTimeRange) menuTimeRange.style.display = 'flex';
      if (menuDelete) menuDelete.style.display = 'flex';
    }
  }

  contextMenu.style.display = 'block';
  
  let x = e.clientX;
  let y = e.clientY;
  if (x + 230 > window.innerWidth) x -= 230;
  if (y + 240 > window.innerHeight) y -= 240;
  
  contextMenu.style.left = `${Math.max(10, x)}px`;
  contextMenu.style.top = `${Math.max(10, y)}px`;
}

document.addEventListener('click', () => {
  contextMenu.style.display = 'none';
});

document.getElementById('menuSelect').addEventListener('click', () => {
  if (activeContextTarget.index !== null && activeContextTarget.type === 'activity') {
    if (!isCompletedItem(activitiesList[activeContextTarget.index])) {
      activitiesList[activeContextTarget.index].selected = true;
    }
    renderActivities();
  }
});

document.getElementById('menuUnselect').addEventListener('click', () => {
  if (activeContextTarget.index !== null && activeContextTarget.type === 'activity') {
    activitiesList[activeContextTarget.index].selected = false;
    renderActivities();
  }
});

document.getElementById('menuPasteLinks').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      if (activeContextTarget.type === 'queue' || !activeContextTarget.type) {
        text.split(/\r?\n/).forEach(line => {
          const l = line.trim();
          if (l && !queueList.includes(l)) queueList.push(l);
        });
        renderQueueList();
      } else {
        urlInput.value = text.trim();
      }
    }
  } catch {}
});

document.getElementById('menuOpenLink').addEventListener('click', () => {
  if (activeContextTarget.index !== null) {
    let url = null;
    if (activeContextTarget.type === 'queue') url = queueList[activeContextTarget.index];
    else url = activitiesList[activeContextTarget.index]?.url;
    if (url && window.snapkeeAPI) window.snapkeeAPI.openExternal(url);
  }
});

document.getElementById('menuDeleteSelected').addEventListener('click', () => {
  if (activeContextTarget.index !== null) {
    if (activeContextTarget.type === 'queue') {
      queueList.splice(activeContextTarget.index, 1);
      renderQueueList();
    } else if (activeContextTarget.type === 'activity') {
      activitiesList.splice(activeContextTarget.index, 1);
      renderActivities();
    }
  }
});

document.getElementById('menuOpenFolder').addEventListener('click', () => {
  if (activeContextTarget.index !== null && activeContextTarget.type === 'activity') {
    const item = activitiesList[activeContextTarget.index];
    if (item && item.filePath && window.snapkeeAPI) {
      window.snapkeeAPI.openInFolder(item.filePath);
    }
  }
});

document.getElementById('menuSetTimeRange')?.addEventListener('click', () => {
  if (activeContextTarget.index !== null && activeContextTarget.type === 'activity') {
    openTimeRangeModal([activeContextTarget.index]);
  }
});

document.getElementById('menuCopySelectedLog')?.addEventListener('click', () => {
  copyLogContent(false);
  contextMenu.style.display = 'none';
});

document.getElementById('menuCopyAllLogs')?.addEventListener('click', () => {
  copyLogContent(true);
  contextMenu.style.display = 'none';
});

document.getElementById('menuClearLogCtx')?.addEventListener('click', () => {
  if (liveLogPanel) liveLogPanel.innerHTML = '';
  appendLiveLog({ level: 'info', message: 'Live log cleared.' });
  contextMenu.style.display = 'none';
});

// --- TOP NAVIGATION TABS ---
function setActiveNavTab(btn) {
  [tabDownloader, tabQueue, tabSettings, tabLogs].forEach(tab => {
    if (tab) tab.classList.remove('active');
  });
  if (btn) btn.classList.add('active');
}

if (tabLogs) {
  tabLogs.addEventListener('click', () => {
    setActiveNavTab(tabLogs);
    if (logShell) {
      if (logShell.style.height === '8.5rem' || !logShell.style.height) {
        logShell.style.height = '16rem';
      }
      logShell.scrollIntoView({ behavior: 'smooth', block: 'end' });
      if (liveLogPanel) {
        liveLogPanel.scrollTop = liveLogPanel.scrollHeight;
      }
    }
  });
}

if (tabDownloader) {
  tabDownloader.addEventListener('click', () => {
    setActiveNavTab(tabDownloader);
    const hero = document.getElementById('urlInput');
    if (hero) hero.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

if (tabQueue) {
  tabQueue.addEventListener('click', () => {
    setActiveNavTab(tabQueue);
    const queueSidebar = document.getElementById('queueSidebar');
    if (queueSidebar) {
      queueSidebar.scrollIntoView({ behavior: 'smooth' });
    }
  });
}

if (tabSettings) {
  tabSettings.addEventListener('click', () => {
    setActiveNavTab(tabSettings);
    const workspaceDirInput = document.getElementById('workspaceDirInput');
    if (workspaceDirInput) {
      workspaceDirInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      workspaceDirInput.focus();
    }
  });
}

function handleOpenItemFolder(index) {
  const item = activitiesList[index];
  if (item && item.filePath && window.snapkeeAPI) {
    window.snapkeeAPI.openInFolder(item.filePath);
  } else {
    const targetDir = workspaceDirInput.value.trim();
    if (targetDir && window.snapkeeAPI) {
      window.snapkeeAPI.openInFolder(targetDir);
    }
  }
}

// --- HELPER FUNCTIONS ---
function setStatus(text, color = 'slate') {
  footerStatusText.textContent = text;
  
  footerStatusBadge.className = 'pulse-beacon';
  if (color === 'emerald') footerStatusBadge.classList.add('bg-emerald-400');
  else if (color === 'blue') footerStatusBadge.classList.add('bg-blue-400');
  else if (color === 'red') footerStatusBadge.classList.add('bg-red-400');
  else if (color === 'amber') footerStatusBadge.classList.add('bg-amber-400');
  else footerStatusBadge.classList.add('bg-slate-400');
}

function startTimer() {
  stopTimer();
  startTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const hrs = String(Math.floor(elapsedSec / 3600)).padStart(2, '0');
    const mins = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
    const secs = String(elapsedSec % 60).padStart(2, '0');
    timerDisplay.textContent = `${hrs}:${mins}:${secs}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

function detectPlatformName(url) {
  const u = String(url).toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
  if (u.includes('bilibili') || u.includes('b23.tv') || u.includes('bibili')) return 'BiliBili';
  if (u.includes('tiktok.com')) return 'TikTok';
  if (u.includes('douyin.com')) return 'Douyin';
  if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) return 'Facebook';
  if (u.includes('instagram.com')) return 'Instagram';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'Twitter/X';
  if (u.includes('threads.net')) return 'Threads';
  if (u.includes('reddit.com') || u.includes('redd.it')) return 'Reddit';
  if (u.includes('pinterest.com') || u.includes('pin.it')) return 'Pinterest';
  if (u.includes('twitch.tv')) return 'Twitch';
  if (u.includes('vimeo.com')) return 'Vimeo';
  if (u.includes('dramabox')) return 'DramaBox';
  if (u.includes('novelquickapp.com') || u.includes('hongguo') || u.includes('qznovel.com')) return 'NovelQuick';
  if (u.includes('donghuafun') || u.includes('donghua')) return 'DonghuaFun';
  if (u.includes('ganjingworld') || u.includes('ganjing')) return 'GanJingWorld';
  if (u.includes('kuaishou.com') || u.includes('kwai.com')) return 'Kuaishou';
  if (u.includes('xiaohongshu.com') || u.includes('xhslink.com')) return 'XiaoHongShu';
  if (u.includes('soundcloud.com')) return 'SoundCloud';
  if (u.includes('dailymotion.com')) return 'Dailymotion';
  if (u.includes('rumble.com')) return 'Rumble';
  if (u.includes('streamable.com')) return 'Streamable';
  if (u.includes('capcut.com')) return 'CapCut';
  if (u.includes('odysee.com') || u.includes('lbry.tv') || u.includes('lbry://')) return 'Odysee';
  return 'Direct Media';
}

function getCleanDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace('www.', '');
  } catch {
    return url;
  }
}

// =========================================================================
// TIME RANGE & STREAM CLIPPING CONTROLLER
// =========================================================================
let trModalTargetIndices = [];

const timeRangeModal = document.getElementById('timeRangeModal');
const btnCloseTimeRangeModal = document.getElementById('btnCloseTimeRangeModal');
const btnCancelTimeRange = document.getElementById('btnCancelTimeRange');
const btnSaveTimeRange = document.getElementById('btnSaveTimeRange');
const btnResetTimeRange = document.getElementById('btnResetTimeRange');
const btnApplyTimeRangeSelected = document.getElementById('btnApplyTimeRangeSelected');
const chkEnableTimeRange = document.getElementById('chkEnableTimeRange');
const trActiveStatusBadge = document.getElementById('trActiveStatusBadge');
const trControlsSection = document.getElementById('trControlsSection');
const trModalThumb = document.getElementById('trModalThumb');
const trModalDurationBadge = document.getElementById('trModalDurationBadge');
const trModalTitle = document.getElementById('trModalTitle');
const trModalPlatform = document.getElementById('trModalPlatform');
const trModalTotalDuration = document.getElementById('trModalTotalDuration');
const trInputStart = document.getElementById('trInputStart');
const trInputEnd = document.getElementById('trInputEnd');
const chkToEnd = document.getElementById('chkToEnd');
const btnStartZero = document.getElementById('btnStartZero');
const trSelectedDurationLabel = document.getElementById('trSelectedDurationLabel');
const trTimelineFill = document.getElementById('trTimelineFill');
const trTimelineStartLabel = document.getElementById('trTimelineStartLabel');
const trTimelineCutLabel = document.getElementById('trTimelineCutLabel');
const trTimelineEndLabel = document.getElementById('trTimelineEndLabel');
const trSavingsNote = document.getElementById('trSavingsNote');
const btnOpenBatchTimeRange = document.getElementById('btnOpenBatchTimeRange');

function parseTimeToSeconds(input, totalSec = 0) {
  if (input === null || input === undefined || input === '') return null;
  const str = String(input).trim().toLowerCase();
  if (str === 'inf' || str === 'end' || str === 'last' || str === 'infinity') return 'inf';

  const isNegative = str.startsWith('-');
  const cleanStr = isNegative ? str.slice(1) : str;

  let total = 0;
  if (cleanStr.includes(':')) {
    const parts = cleanStr.split(':').map(p => parseFloat(p) || 0);
    if (parts.length === 3) {
      total = parts[0] * 3600 + parts[1] * 60 + parts[2];
    } else if (parts.length === 2) {
      total = parts[0] * 60 + parts[1];
    }
  } else if (/[hms]/.test(cleanStr)) {
    const h = cleanStr.match(/(\d+(?:\.\d+)?)\s*h/);
    const m = cleanStr.match(/(\d+(?:\.\d+)?)\s*m/);
    const s = cleanStr.match(/(\d+(?:\.\d+)?)\s*s/);
    if (h) total += parseFloat(h[1]) * 3600;
    if (m) total += parseFloat(m[1]) * 60;
    if (s) total += parseFloat(s[1]);
  } else if (!isNaN(cleanStr)) {
    total = parseFloat(cleanStr);
  }

  if (isNegative) {
    return totalSec > 0 ? Math.max(0, totalSec - total) : -total;
  }
  return Math.max(0, Math.round(total));
}

function formatSecondsToTime(sec, forceHours = true) {
  if (sec === 'inf' || sec === Infinity || sec === null || sec === undefined) return 'inf';
  if (isNaN(sec)) return '00:00:00';
  const s = Math.max(0, Math.round(sec));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (forceHours || hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatDurationHuman(sec) {
  if (sec === 'inf' || sec === Infinity) return 'Until End';
  if (isNaN(sec) || sec <= 0) return '0s';
  const s = Math.round(sec);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const parts = [];
  if (hrs > 0) parts.push(`${hrs}h`);
  if (mins > 0) parts.push(`${mins}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

window.handleOpenItemTimeRange = function(index, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  openTimeRangeModal([index]);
};

function openTimeRangeModal(indices = []) {
  if (!timeRangeModal || indices.length === 0) return;
  trModalTargetIndices = indices;
  const firstIndex = indices[0];
  const item = activitiesList[firstIndex];
  if (!item) return;

  const totalSec = item.durationSeconds || parseTimeToSeconds(item.duration) || 36000;
  const formattedTotal = formatSecondsToTime(totalSec);

  if (trModalThumb) trModalThumb.src = item.thumbnail || getPlatformDefaultThumbnail(item.platform);
  if (trModalDurationBadge) trModalDurationBadge.textContent = item.duration || formattedTotal;
  if (trModalTitle) {
    trModalTitle.textContent = indices.length > 1 
      ? `${item.title} (+ ${indices.length - 1} other selected videos)`
      : item.title;
  }
  if (trModalPlatform) trModalPlatform.textContent = item.platform || 'Video';
  if (trModalTotalDuration) trModalTotalDuration.textContent = `Total: ${item.duration || formattedTotal} (${totalSec.toLocaleString()}s)`;

  if (trTimelineStartLabel) trTimelineStartLabel.textContent = '00:00:00';
  if (trTimelineEndLabel) trTimelineEndLabel.textContent = formattedTotal;

  // Show or hide "Apply to All Selected" depending on selection
  const selectedCount = activitiesList.filter(i => i.selected && !isCompletedItem(i)).length;
  if (btnApplyTimeRangeSelected) {
    btnApplyTimeRangeSelected.style.display = selectedCount > 1 ? 'inline-flex' : 'none';
  }

  // Populate from item or defaults
  const existingTr = item.timeRange;
  if (existingTr && existingTr.enabled) {
    if (chkEnableTimeRange) chkEnableTimeRange.checked = true;
    if (trInputStart) trInputStart.value = existingTr.start || '00:00:00';
    if (chkToEnd) chkToEnd.checked = Boolean(existingTr.toEnd || existingTr.end === 'inf');
    if (trInputEnd) trInputEnd.value = chkToEnd?.checked ? 'inf' : (existingTr.end || formattedTotal);
  } else {
    if (chkEnableTimeRange) chkEnableTimeRange.checked = false;
    if (totalSec >= 3600) {
      // Default to 9h-last for 10h video (or last 1 hour)
      const defaultStartSec = Math.max(0, totalSec - 3600);
      if (trInputStart) trInputStart.value = formatSecondsToTime(defaultStartSec);
    } else {
      if (trInputStart) trInputStart.value = '00:00:00';
    }
    if (chkToEnd) chkToEnd.checked = true;
    if (trInputEnd) trInputEnd.value = 'inf';
  }

  updateTimeRangeModalUI();
  timeRangeModal.classList.remove('hidden');
  timeRangeModal.classList.add('flex');
}

function closeTimeRangeModal() {
  if (!timeRangeModal) return;
  timeRangeModal.classList.add('hidden');
  timeRangeModal.classList.remove('flex');
}

function updateTimeRangeModalUI() {
  if (!trModalTargetIndices || trModalTargetIndices.length === 0) return;
  const firstIndex = trModalTargetIndices[0];
  const item = activitiesList[firstIndex];
  const totalSec = item ? (item.durationSeconds || parseTimeToSeconds(item.duration) || 36000) : 36000;

  const isEnabled = chkEnableTimeRange ? chkEnableTimeRange.checked : false;
  if (trActiveStatusBadge) {
    if (isEnabled) {
      trActiveStatusBadge.textContent = 'Active (Clipping)';
      trActiveStatusBadge.className = 'text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-cyan-950 border border-cyan-500/50 text-cyan-300 shadow-sm';
    } else {
      trActiveStatusBadge.textContent = 'Full Video (All)';
      trActiveStatusBadge.className = 'text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-slate-800 text-slate-400';
    }
  }

  if (trControlsSection) {
    trControlsSection.style.opacity = isEnabled ? '1' : '0.45';
  }

  if (chkToEnd && trInputEnd) {
    if (chkToEnd.checked) {
      trInputEnd.value = 'inf';
      trInputEnd.disabled = true;
      trInputEnd.classList.add('opacity-60');
    } else {
      if (trInputEnd.value === 'inf') {
        trInputEnd.value = formatSecondsToTime(totalSec);
      }
      trInputEnd.disabled = false;
      trInputEnd.classList.remove('opacity-60');
    }
  }

  // Parse start and end in seconds
  let startSec = parseTimeToSeconds(trInputStart ? trInputStart.value : '0', totalSec);
  if (startSec === null || isNaN(startSec)) startSec = 0;
  startSec = Math.max(0, Math.min(totalSec, startSec));

  let endSec = chkToEnd?.checked ? totalSec : parseTimeToSeconds(trInputEnd ? trInputEnd.value : 'inf', totalSec);
  if (endSec === 'inf' || endSec === null || isNaN(endSec)) endSec = totalSec;
  endSec = Math.max(startSec, Math.min(totalSec, endSec));

  const clipDurationSec = Math.max(1, endSec - startSec);
  const pct = Math.min(100, Math.max(0.5, ((clipDurationSec / totalSec) * 100))).toFixed(1);
  const leftPct = Math.min(100, Math.max(0, ((startSec / totalSec) * 100))).toFixed(1);

  if (trSelectedDurationLabel) {
    trSelectedDurationLabel.textContent = `Selected: ${formatDurationHuman(clipDurationSec)} (${pct}% of total)`;
  }

  if (trTimelineFill) {
    trTimelineFill.style.left = `${leftPct}%`;
    trTimelineFill.style.width = `${pct}%`;
  }

  const startFormatted = formatSecondsToTime(startSec);
  const endFormatted = chkToEnd?.checked ? 'End' : formatSecondsToTime(endSec);

  if (trTimelineCutLabel) {
    trTimelineCutLabel.textContent = `Clip: ${startFormatted} → ${endFormatted}`;
  }

  if (trSavingsNote) {
    const savedPct = Math.max(0, 100 - parseFloat(pct)).toFixed(0);
    if (savedPct > 0 && isEnabled) {
      trSavingsNote.textContent = `Smart Stream Clipping will save ~${savedPct}% download bandwidth & time by fetching only this section directly!`;
    } else {
      trSavingsNote.textContent = `Full video stream will be downloaded without clipping.`;
    }
  }
}

// Preset Buttons
document.querySelectorAll('.tr-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tr-preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (!trModalTargetIndices || trModalTargetIndices.length === 0) return;
    const firstIndex = trModalTargetIndices[0];
    const item = activitiesList[firstIndex];
    const totalSec = item ? (item.durationSeconds || parseTimeToSeconds(item.duration) || 36000) : 36000;
    const preset = btn.dataset.preset;

    if (preset === 'full') {
      if (chkEnableTimeRange) chkEnableTimeRange.checked = false;
      if (trInputStart) trInputStart.value = '00:00:00';
      if (chkToEnd) chkToEnd.checked = true;
      if (trInputEnd) trInputEnd.value = 'inf';
    } else {
      if (chkEnableTimeRange) chkEnableTimeRange.checked = true;
      if (preset === 'last1h') {
        const startSec = Math.max(0, totalSec - 3600);
        if (trInputStart) trInputStart.value = formatSecondsToTime(startSec);
        if (chkToEnd) chkToEnd.checked = true;
        if (trInputEnd) trInputEnd.value = 'inf';
      } else if (preset === 'last2h') {
        const startSec = Math.max(0, totalSec - 7200);
        if (trInputStart) trInputStart.value = formatSecondsToTime(startSec);
        if (chkToEnd) chkToEnd.checked = true;
        if (trInputEnd) trInputEnd.value = 'inf';
      } else if (preset === 'last30m') {
        const startSec = Math.max(0, totalSec - 1800);
        if (trInputStart) trInputStart.value = formatSecondsToTime(startSec);
        if (chkToEnd) chkToEnd.checked = true;
        if (trInputEnd) trInputEnd.value = 'inf';
      } else if (preset === 'first10m') {
        if (trInputStart) trInputStart.value = '00:00:00';
        if (chkToEnd) chkToEnd.checked = false;
        if (trInputEnd) trInputEnd.value = formatSecondsToTime(Math.min(totalSec, 600));
      } else if (preset === 'first30m') {
        if (trInputStart) trInputStart.value = '00:00:00';
        if (chkToEnd) chkToEnd.checked = false;
        if (trInputEnd) trInputEnd.value = formatSecondsToTime(Math.min(totalSec, 1800));
      } else if (preset === 'first1h') {
        if (trInputStart) trInputStart.value = '00:00:00';
        if (chkToEnd) chkToEnd.checked = false;
        if (trInputEnd) trInputEnd.value = formatSecondsToTime(Math.min(totalSec, 3600));
      }
    }
    updateTimeRangeModalUI();
  });
});

// Step delta buttons
document.querySelectorAll('.tr-step-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    const delta = parseInt(btn.dataset.delta, 10) || 0;
    if (!trModalTargetIndices || trModalTargetIndices.length === 0) return;
    const firstIndex = trModalTargetIndices[0];
    const item = activitiesList[firstIndex];
    const totalSec = item ? (item.durationSeconds || parseTimeToSeconds(item.duration) || 36000) : 36000;

    if (target === 'start') {
      let cur = parseTimeToSeconds(trInputStart ? trInputStart.value : '0', totalSec) || 0;
      cur = Math.max(0, Math.min(totalSec - 1, cur + delta));
      if (trInputStart) trInputStart.value = formatSecondsToTime(cur);
    } else if (target === 'end') {
      if (chkToEnd) chkToEnd.checked = false;
      let cur = parseTimeToSeconds(trInputEnd ? trInputEnd.value : 'inf', totalSec) || totalSec;
      cur = Math.max(1, Math.min(totalSec, cur + delta));
      if (trInputEnd) trInputEnd.value = formatSecondsToTime(cur);
    }
    if (chkEnableTimeRange) chkEnableTimeRange.checked = true;
    updateTimeRangeModalUI();
  });
});

// Input events
if (chkEnableTimeRange) chkEnableTimeRange.addEventListener('change', updateTimeRangeModalUI);
if (chkToEnd) chkToEnd.addEventListener('change', updateTimeRangeModalUI);
if (trInputStart) trInputStart.addEventListener('input', () => {
  if (chkEnableTimeRange) chkEnableTimeRange.checked = true;
  updateTimeRangeModalUI();
});
if (trInputEnd) trInputEnd.addEventListener('input', () => {
  if (chkEnableTimeRange) chkEnableTimeRange.checked = true;
  updateTimeRangeModalUI();
});
if (btnStartZero) btnStartZero.addEventListener('click', () => {
  if (trInputStart) trInputStart.value = '00:00:00';
  updateTimeRangeModalUI();
});

// Close & Cancel
if (btnCloseTimeRangeModal) btnCloseTimeRangeModal.addEventListener('click', closeTimeRangeModal);
if (btnCancelTimeRange) btnCancelTimeRange.addEventListener('click', closeTimeRangeModal);

// Save Range
if (btnSaveTimeRange) {
  btnSaveTimeRange.addEventListener('click', () => {
    if (!trModalTargetIndices || trModalTargetIndices.length === 0) return;
    const isEnabled = chkEnableTimeRange ? chkEnableTimeRange.checked : false;
    const firstIndex = trModalTargetIndices[0];
    const firstItem = activitiesList[firstIndex];
    const totalSec = firstItem ? (firstItem.durationSeconds || parseTimeToSeconds(firstItem.duration) || 36000) : 36000;

    const startSec = parseTimeToSeconds(trInputStart ? trInputStart.value : '0', totalSec) || 0;
    const toEnd = chkToEnd ? chkToEnd.checked : true;
    const endSec = toEnd ? 'inf' : (parseTimeToSeconds(trInputEnd ? trInputEnd.value : 'inf', totalSec) || totalSec);

    const startFormatted = formatSecondsToTime(startSec);
    const endFormatted = toEnd ? 'End' : (typeof endSec === 'number' ? formatSecondsToTime(endSec) : 'End');
    const label = `${startFormatted} → ${endFormatted}`;

    const timeRangeObj = {
      enabled: isEnabled,
      start: startFormatted,
      end: toEnd ? 'inf' : endFormatted,
      toEnd: toEnd,
      startSec: startSec,
      endSec: endSec,
      label: label
    };

    trModalTargetIndices.forEach(idx => {
      if (activitiesList[idx]) {
        activitiesList[idx].timeRange = isEnabled ? { ...timeRangeObj } : { enabled: false };
      }
    });

    renderActivities();
    closeTimeRangeModal();
    if (isEnabled) {
      setStatus(`Custom download range set: ${label} for ${trModalTargetIndices.length} item(s).`, 'cyan');
      appendLiveLog({ level: 'info', message: `Custom time range set [${label}] for ${trModalTargetIndices.length} media stream(s).` });
    } else {
      setStatus(`Reset to full video download.`, 'slate');
    }
  });
}

// Apply to All Selected
if (btnApplyTimeRangeSelected) {
  btnApplyTimeRangeSelected.addEventListener('click', () => {
    const selectedIndices = [];
    activitiesList.forEach((it, idx) => {
      if (it.selected && !isCompletedItem(it)) selectedIndices.push(idx);
    });
    if (selectedIndices.length === 0) {
      alert('No items currently selected.');
      return;
    }
    trModalTargetIndices = selectedIndices;
    if (btnSaveTimeRange) btnSaveTimeRange.click();
  });
}

// Reset (Full Video)
if (btnResetTimeRange) {
  btnResetTimeRange.addEventListener('click', () => {
    if (trModalTargetIndices && trModalTargetIndices.length > 0) {
      trModalTargetIndices.forEach(idx => {
        if (activitiesList[idx]) {
          activitiesList[idx].timeRange = { enabled: false };
        }
      });
      renderActivities();
    }
    closeTimeRangeModal();
    setStatus('Reset to full video download.', 'slate');
  });
}

// Toolbar Batch Button
if (btnOpenBatchTimeRange) {
  btnOpenBatchTimeRange.addEventListener('click', () => {
    const selectedIndices = [];
    activitiesList.forEach((item, idx) => {
      if (item.selected && !isCompletedItem(item)) {
        selectedIndices.push(idx);
      }
    });
    if (selectedIndices.length === 0) {
      if (activitiesList.length > 0) {
        openTimeRangeModal([0]);
      } else {
        alert('Please scrape or select at least one media item first.');
      }
      return;
    }
    openTimeRangeModal(selectedIndices);
  });
}

