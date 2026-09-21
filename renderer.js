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
const selectBilibiliMode = document.getElementById('selectBilibiliMode');
const inputThreads = document.getElementById('inputThreads');
const inputCookies = document.getElementById('inputCookies');
const btnBrowseCookies = document.getElementById('btnBrowseCookies');

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
const btnToggleLogSize = document.getElementById('btnToggleLogSize');
const logShell = document.getElementById('logShell');
const liveLogPanel = document.getElementById('liveLogPanel');

const timerDisplay = document.getElementById('timerDisplay');
const speedDisplay = document.getElementById('speedDisplay');
const footerStatusText = document.getElementById('footerStatusText');
const footerStatusBadge = document.getElementById('footerStatusBadge');
const downloadSummaryBar = document.getElementById('downloadSummaryBar');
const summaryProgressText = document.getElementById('summaryProgressText');

const contextMenu = document.getElementById('contextMenu');
const MAX_LOG_ROWS = 300;

const SNAPKEY_SETTINGS_STORAGE_KEY = 'snapkee_app_settings_v1';

function saveUserSettings() {
  try {
    const data = {
      workspaceDir: workspaceDirInput ? workspaceDirInput.value : '',
      videosSubpath: videosSubpathInput ? videosSubpathInput.value : '',
      photosSubpath: photosSubpathInput ? photosSubpathInput.value : '',
      fileType: selectFileType ? selectFileType.value : 'video',
      fileFormat: selectFileFormat ? selectFileFormat.value : 'mp4',
      bilibiliMode: selectBilibiliMode ? selectBilibiliMode.value : 'fast',
      threads: inputThreads ? inputThreads.value : '12',
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
      if (data.bilibiliMode && selectBilibiliMode) selectBilibiliMode.value = data.bilibiliMode;
      if (data.threads && inputThreads) inputThreads.value = data.threads;
      if (data.cookies && inputCookies) inputCookies.value = data.cookies;
      if (typeof data.chkEngCaption === 'boolean' && chkEngCaption) chkEngCaption.checked = data.chkEngCaption;
      if (typeof data.chkParaphrase === 'boolean' && chkParaphrase) chkParaphrase.checked = data.chkParaphrase;
      if (typeof data.chkEnableGpu === 'boolean' && chkEnableGpu) chkEnableGpu.checked = data.chkEnableGpu;
      if (typeof data.chkRemoveMention === 'boolean' && chkRemoveMention) chkRemoveMention.checked = data.chkRemoveMention;
      if (typeof data.chkDownloadThumbnail === 'boolean' && chkDownloadThumbnail) chkDownloadThumbnail.checked = data.chkDownloadThumbnail;
      if (data.selectSubtitleLang && selectSubtitleLang) selectSubtitleLang.value = data.selectSubtitleLang;
    }
  } catch (e) {}
}

// --- INITIALIZE APPLICATION ---
window.addEventListener('DOMContentLoaded', () => {
  loadUserSettings();
  renderQueueList();
  renderActivities();
  appendLiveLog({ level: 'info', message: 'SnapKee Studio Engine initialized with multi-threaded parallel downloader & persistent cookie auth.' });

  // Auto-save setting changes
  [
    workspaceDirInput, videosSubpathInput, photosSubpathInput,
    selectFileType, selectFileFormat, selectBilibiliMode,
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
            <div class="mt-1">
              ${subtitleBadgeHtml}
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
          <span class="text-[10px] text-blue-300 font-medium truncate">${item.profile || item.platform}</span>
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
        <button class="text-slate-400 hover:text-cyan-300 p-1 rounded" title="Open Folder" onclick="handleOpenItemFolder(${origIndex})">
          📂
        </button>
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
  if (p.includes('youtube')) return `<span class="platform-pill platform-youtube"><span>🔴</span> YouTube</span>`;
  if (p.includes('bilibili') || p.includes('bili')) return `<span class="platform-pill platform-bilibili"><span>🔵</span> BiliBili</span>`;
  if (p.includes('tiktok')) return `<span class="platform-pill platform-tiktok"><span>🎵</span> TikTok</span>`;
  if (p.includes('facebook')) return `<span class="platform-pill platform-facebook"><span>📘</span> Facebook</span>`;
  if (p.includes('instagram')) return `<span class="platform-pill platform-instagram"><span>📸</span> Instagram</span>`;
  if (p.includes('twitter') || p.includes('x')) return `<span class="platform-pill platform-twitter"><span>🐦</span> Twitter/X</span>`;
  if (p.includes('dramabox')) return `<span class="platform-pill platform-dramabox"><span>🎬</span> DramaBox</span>`;
  return `<span class="platform-pill platform-generic"><span>🌐</span> ${platform || 'Direct'}</span>`;
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

  const settings = {
    directory: workspaceDirInput.value.trim(),
    threads: Math.max(2, Math.min(16, parseInt(inputThreads.value) || 12)),
    itemConcurrency: Math.min(2, selectedItems.length),
    bilibiliMode: selectBilibiliMode ? selectBilibiliMode.value : 'fast',
    bilibiliThreads: selectBilibiliMode
      ? (selectBilibiliMode.value === 'fast' ? 16 : selectBilibiliMode.value === 'stable' ? 8 : 12)
      : 12,
    fileType: selectFileType.value,
    fileFormat: selectFileFormat.value,
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
  setStatus(`Launching parallel multi-threaded download (${selectedItems.length} streams)...`, 'blue');
  downloadSummaryBar.classList.remove('hidden');
  downloadSummaryBar.classList.add('flex');
  summaryProgressText.textContent = `0 / ${selectedItems.length} Completed`;

  btnDownloadNow.disabled = true;
  btnDownloadNow.classList.add('opacity-75');
  appendLiveLog({
    level: 'info',
    message: `Starting download for ${selectedItems.length} item(s)${settings.subtitleOnly ? ' (subtitle only)' : ' (video + best .srt)'}.`
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
    speedDisplay.textContent = `${data.totalSpeedMbps || '0.00'} Mbps`;
    if (data.total > 0) {
      summaryProgressText.textContent = `${data.completed} / ${data.total} Completed`;
      setStatus(`Downloading: ${data.completed}/${data.total} completed (${data.running} active threads)...`, 'blue');
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
  
  const menuFolder = document.getElementById('menuOpenFolder');
  if (type === 'queue') {
    menuFolder.style.display = 'none';
  } else {
    const item = activitiesList[index];
    menuFolder.style.display = (item && item.filePath) ? 'flex' : 'none';
  }

  contextMenu.style.display = 'block';
  
  let x = e.clientX;
  let y = e.clientY;
  if (x + 230 > window.innerWidth) x -= 230;
  if (y + 240 > window.innerHeight) y -= 240;
  
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
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
  if (u.includes('kuaishou.com') || u.includes('kwai.com')) return 'Kuaishou';
  if (u.includes('xiaohongshu.com') || u.includes('xhslink.com')) return 'XiaoHongShu';
  if (u.includes('soundcloud.com')) return 'SoundCloud';
  if (u.includes('dailymotion.com')) return 'Dailymotion';
  if (u.includes('rumble.com')) return 'Rumble';
  if (u.includes('streamable.com')) return 'Streamable';
  if (u.includes('capcut.com')) return 'CapCut';
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
