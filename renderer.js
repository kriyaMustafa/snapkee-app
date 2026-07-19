// --- APP STATE ---
let queueList = [];

let activitiesList = [];
let activeContextTarget = { type: null, index: null };
let timerInterval = null;
let startTime = null;

// --- DOM ELEMENTS ---
const urlInput = document.getElementById('urlInput');
const btnAddQueue = document.getElementById('btnAddQueue');
const btnScrapeNow = document.getElementById('btnScrapeNow');
const queueTableBody = document.getElementById('queueTableBody');
const queueCountBadge = document.getElementById('queueCountBadge');

const activitiesTableBody = document.getElementById('activitiesTableBody');
const activitiesCountBadge = document.getElementById('activitiesCountBadge');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const btnClearAll = document.getElementById('btnClearAll');

const workspaceDirInput = document.getElementById('workspaceDirInput');
const btnBrowseDir = document.getElementById('btnBrowseDir');
const videosSubpathInput = document.getElementById('videosSubpathInput');
const photosSubpathInput = document.getElementById('photosSubpathInput');

const inputThreads = document.getElementById('inputThreads');
const inputCookies = document.getElementById('inputCookies');
const btnBrowseCookies = document.getElementById('btnBrowseCookies');

// Force safer defaults to avoid throttling
if (inputThreads) inputThreads.value = "6";
if (inputCookies && !inputCookies.value) {
  inputCookies.value = "D:/PROJECT/DOWNLOAD/snapkee-app/www.bilibili.com_cookies.txt";
}

const selectFileType = document.getElementById('selectFileType');
const selectFileFormat = document.getElementById('selectFileFormat');

const btnDownloadNow = document.getElementById('btnDownloadNow');
const btnCancel = document.getElementById('btnCancel');
const timerDisplay = document.getElementById('timerDisplay');
const speedDisplay = document.getElementById('speedDisplay');
const footerStatusText = document.getElementById('footerStatusText');
const footerStatusBadge = document.getElementById('footerStatusBadge');
const downloadSummaryBar = document.getElementById('downloadSummaryBar');
const summaryProgressText = document.getElementById('summaryProgressText');

const contextMenu = document.getElementById('contextMenu');

// --- INITIALIZE ---
window.addEventListener('DOMContentLoaded', () => {
  renderQueueTable();
});

// --- QUEUE MANAGEMENT ---
btnAddQueue.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!url) return;
  
  if (!queueList.includes(url)) {
    queueList.push(url);
    renderQueueTable();
    urlInput.value = '';
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

function renderQueueTable() {
  queueTableBody.innerHTML = '';
  queueCountBadge.textContent = queueList.length;

  queueList.forEach((url, index) => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/70 transition cursor-pointer';
    tr.dataset.type = 'queue';
    tr.dataset.index = index;

    tr.innerHTML = `
      <td class="text-center text-slate-400 font-mono text-xs">${index + 1}</td>
      <td class="text-slate-200 font-mono text-xs truncate max-w-[240px]" title="${url}">
        <span class="text-blue-400 font-bold mr-1.5">✓</span>${url}
      </td>
    `;

    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, 'queue', index);
    });

    queueTableBody.appendChild(tr);
  });
}

// --- SCRAPING LOGIC ---
btnScrapeNow.addEventListener('click', handleScrapeNow);

async function handleScrapeNow() {
  const inputVal = urlInput.value.trim();
  let targetUrls = [...queueList];
  
  // If user typed a URL that isn't in queue yet, include it
  if (inputVal && !targetUrls.includes(inputVal)) {
    targetUrls.push(inputVal);
    if (!queueList.includes(inputVal)) {
      queueList.push(inputVal);
      renderQueueTable();
    }
  }

  if (targetUrls.length === 0) {
    alert('Please enter or add at least one URL to scrape.');
    return;
  }

  startTimer();
  setStatus('Scraping target links...', 'amber');
  btnScrapeNow.disabled = true;
  btnScrapeNow.innerHTML = `<span class="animate-spin">⏳</span> Scraping...`;

  try {
    const response = await window.snapkeeAPI.scrapeQueue(targetUrls);
    if (response.success) {
      activitiesList = response.items;
      renderActivitiesTable();
      setStatus(`Scraping finished (${targetUrls.length}/${targetUrls.length})`, 'emerald');
    } else {
      setStatus(`Scrape failed: ${response.error}`, 'red');
    }
  } catch (error) {
    setStatus('Error connecting to scraper service', 'red');
  } finally {
    btnScrapeNow.disabled = false;
    btnScrapeNow.innerHTML = `<span>🔍</span> Scrape Now`;
    stopTimer();
  }
}

// --- ACTIVITIES TABLE RENDERING ---
function renderActivitiesTable() {
  activitiesTableBody.innerHTML = '';
  activitiesCountBadge.textContent = `${activitiesList.length} items`;

  activitiesList.forEach((item, index) => {
    const tr = document.createElement('tr');
    tr.className = `transition ${item.selected ? 'bg-blue-950/20' : ''}`;
    tr.dataset.type = 'activity';
    tr.dataset.id = item.id;
    tr.dataset.index = index;

    const statusBadgeHtml = getStatusBadgeHtml(item);

    tr.innerHTML = `
      <td class="text-center">
        <input type="checkbox" class="custom-checkbox row-checkbox" data-index="${index}" ${item.selected ? 'checked' : ''}>
      </td>
      <td class="text-center text-slate-400 font-mono text-xs">${index + 1}</td>
      <td class="font-medium text-slate-200 truncate max-w-[220px]" title="${item.title}">
        ${item.title}
      </td>
      <td class="text-slate-400 font-mono text-xs truncate max-w-[180px]" title="${item.url}">
        ${item.url}
      </td>
      <td class="text-slate-300 font-mono text-xs">${item.folder}</td>
      <td class="text-slate-300 text-xs">${item.type}</td>
      <td class="text-slate-300 font-mono text-xs">${item.sizeMB}</td>
      <td class="text-blue-300 font-mono text-xs truncate max-w-[120px]">${item.profile}</td>
      <td class="text-slate-300 font-semibold text-xs">
        <span class="bg-blue-900/30 border border-blue-500/30 text-blue-300 px-1.5 py-0.5 rounded text-[10px]">${item.platform}</span>
      </td>
      <td class="min-w-[160px]">
        <div class="flex flex-col">
          <div class="flex items-center justify-between">
            ${statusBadgeHtml}
            ${item.speedMbps && item.speedMbps !== '0.00' ? `<span class="text-[10px] font-mono text-cyan-400">${item.speedMbps} Mbps</span>` : ''}
          </div>
          ${item.percentage !== undefined && item.percentage > 0 && item.percentage < 100 ? `
            <div class="row-progress-bg">
              <div class="row-progress-fill" style="width: ${item.percentage}%"></div>
            </div>
          ` : ''}
        </div>
      </td>
    `;

    // Checkbox toggle
    const checkbox = tr.querySelector('.row-checkbox');
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      activitiesList[index].selected = checkbox.checked;
      updateSelectAllHeaderState();
      tr.className = `transition ${checkbox.checked ? 'bg-blue-950/20' : ''}`;
    });

    // Right-click menu
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e, 'activity', index);
    });

    // Double click to open folder if finished
    tr.addEventListener('dblclick', () => {
      if (item.filePath && (item.status === 'Completed' || item.status.includes('100%'))) {
        window.snapkeeAPI.openInFolder(item.filePath);
      }
    });

    activitiesTableBody.appendChild(tr);
  });

  updateSelectAllHeaderState();
}

function getStatusBadgeHtml(item) {
  const st = item.status || 'Ready';
  if (st.includes('Completed')) {
    return `<span class="status-badge status-completed"><span>✓</span> Completed</span>`;
  }
  if (st.includes('Downloading')) {
    return `<span class="status-badge status-downloading"><span>⬇️</span> ${st}</span>`;
  }
  if (st.includes('Error')) {
    return `<span class="status-badge status-error"><span>❌</span> Error</span>`;
  }
  if (st.includes('Cancelled')) {
    return `<span class="status-badge status-error"><span>⏹️</span> Cancelled</span>`;
  }
  return `<span class="status-badge status-ready"><span>⏳</span> Ready</span>`;
}

selectAllCheckbox.addEventListener('change', () => {
  const isChecked = selectAllCheckbox.checked;
  activitiesList.forEach(item => item.selected = isChecked);
  renderActivitiesTable();
});

function updateSelectAllHeaderState() {
  if (activitiesList.length === 0) {
    selectAllCheckbox.checked = false;
    return;
  }
  const allChecked = activitiesList.every(i => i.selected);
  selectAllCheckbox.checked = allChecked;
}

btnClearAll.addEventListener('click', () => {
  activitiesList = [];
  renderActivitiesTable();
  setStatus('Activities Table cleared', 'slate');
});

// --- DIRECTORY SELECTION ---
btnBrowseDir.addEventListener('click', async () => {
  const selectedPath = await window.snapkeeAPI.selectFolder();
  if (selectedPath) {
    workspaceDirInput.value = selectedPath.replace(/\\/g, '/');
    videosSubpathInput.value = `${workspaceDirInput.value}/video`;
    photosSubpathInput.value = `${workspaceDirInput.value}/photo`;
    setStatus(`Workspace set to: ${workspaceDirInput.value}`, 'emerald');
  }
});

workspaceDirInput.addEventListener('input', () => {
  const val = workspaceDirInput.value.trim().replace(/\\/g, '/');
  videosSubpathInput.value = `${val}/video`;
  photosSubpathInput.value = `${val}/photo`;
});

if (btnBrowseCookies) {
  btnBrowseCookies.addEventListener('click', async () => {
    if (window.snapkeeAPI && window.snapkeeAPI.selectFile) {
      const selectedFile = await window.snapkeeAPI.selectFile();
      if (selectedFile) {
        if (inputCookies) inputCookies.value = selectedFile.replace(/\\/g, '/');
        setStatus(`Cookies set to: ${selectedFile.replace(/\\/g, '/')}`, 'emerald');
      }
    }
  });
}

// --- DOWNLOADING EXECUTION ---
btnDownloadNow.addEventListener('click', async () => {
  const selectedItems = activitiesList.filter(i => i.selected);
  if (selectedItems.length === 0) {
    alert('Please select at least one item from the Activities Table to download.');
    return;
  }

  const settings = {
    directory: workspaceDirInput.value.trim(),
    threads: parseInt(inputThreads.value) || 16,
    itemConcurrency: 4,
    fileType: selectFileType.value,
    fileFormat: selectFileFormat.value,
    cookies: inputCookies ? inputCookies.value.trim() : ''
  };

  startTimer();
  setStatus(`Launching parallel multi-threaded download (${selectedItems.length} items)...`, 'blue');
  downloadSummaryBar.classList.remove('hidden');
  downloadSummaryBar.classList.add('flex');
  summaryProgressText.textContent = `0 / ${selectedItems.length} Completed`;

  btnDownloadNow.disabled = true;
  btnDownloadNow.classList.add('opacity-75');

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
  setStatus('All downloads cancelled by user.', 'red');
  btnDownloadNow.disabled = false;
  btnDownloadNow.classList.remove('opacity-75');
  stopTimer();
  speedDisplay.textContent = '0.00 Mbps';
});

// --- IPC EVENT RECEIVERS ---
if (window.snapkeeAPI) {
  window.snapkeeAPI.onProgress((data) => {
    const targetItem = activitiesList.find(i => i.id === data.id);
    if (targetItem) {
      targetItem.status = data.status;
      if (data.percentage !== undefined) targetItem.percentage = data.percentage;
      if (data.downloadedMB !== undefined) targetItem.downloadedMB = data.downloadedMB;
      if (data.speedMbps !== undefined) targetItem.speedMbps = data.speedMbps;
      if (data.filePath) targetItem.filePath = data.filePath;

      // Update row in place without full table re-render for maximum speed/smoothness
      const tr = activitiesTableBody.querySelector(`tr[data-id="${data.id}"]`);
      if (tr) {
        const statusTd = tr.children[9];
        statusTd.innerHTML = `
          <div class="flex flex-col">
            <div class="flex items-center justify-between">
              ${getStatusBadgeHtml(targetItem)}
              ${targetItem.speedMbps && targetItem.speedMbps !== '0.00' ? `<span class="text-[10px] font-mono text-cyan-400">${targetItem.speedMbps} Mbps</span>` : ''}
            </div>
            ${targetItem.percentage !== undefined && targetItem.percentage > 0 && targetItem.percentage < 100 ? `
              <div class="row-progress-bg">
                <div class="row-progress-fill" style="width: ${targetItem.percentage}%"></div>
              </div>
            ` : ''}
          </div>
        `;
      }
    }
  });

  window.snapkeeAPI.onGlobalMetrics((data) => {
    speedDisplay.textContent = `${data.totalSpeedMbps || '0.00'} Mbps`;
    if (data.total > 0) {
      summaryProgressText.textContent = `${data.completed} / ${data.total} Completed`;
      setStatus(`Parallel downloading: ${data.completed}/${data.total} finished (${data.running} active threads)...`, 'blue');
    }
  });

  window.snapkeeAPI.onQueueCompleted((data) => {
    setStatus(`All parallel downloads completed successfully (${data.completed}/${data.total})!`, 'emerald');
    btnDownloadNow.disabled = false;
    btnDownloadNow.classList.remove('opacity-75');
    stopTimer();
    speedDisplay.textContent = '0.00 Mbps';
  });

  window.snapkeeAPI.onScrapeProgress((data) => {
    setStatus(`Scraping target ${data.current}/${data.total}: ${data.url}`, 'amber');
  });
}

// --- CONTEXT MENU HANDLING ---
function showContextMenu(e, type, index) {
  activeContextTarget = { type, index };
  
  // Adjust menu items visibility based on target table
  const menuDelete = document.getElementById('menuDeleteSelected');
  const menuFolder = document.getElementById('menuOpenFolder');
  
  if (type === 'queue') {
    menuFolder.style.display = 'none';
  } else {
    const item = activitiesList[index];
    menuFolder.style.display = (item && item.filePath) ? 'flex' : 'none';
  }

  contextMenu.style.display = 'block';
  
  // Position window boundary checks
  let x = e.clientX;
  let y = e.clientY;
  if (x + 220 > window.innerWidth) x -= 220;
  if (y + 240 > window.innerHeight) y -= 240;
  
  contextMenu.style.left = `${x}px`;
  contextMenu.style.top = `${y}px`;
}

document.addEventListener('click', () => {
  contextMenu.style.display = 'none';
});

document.getElementById('menuSelect').addEventListener('click', () => {
  if (activeContextTarget.index !== null && activeContextTarget.type === 'activity') {
    activitiesList[activeContextTarget.index].selected = true;
    renderActivitiesTable();
  }
});

document.getElementById('menuUnselect').addEventListener('click', () => {
  if (activeContextTarget.index !== null && activeContextTarget.type === 'activity') {
    activitiesList[activeContextTarget.index].selected = false;
    renderActivitiesTable();
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
        renderQueueTable();
      } else {
        urlInput.value = text.trim();
      }
    }
  } catch (e) {
    alert('Clipboard access error. Please paste directly into the top input.');
  }
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
      renderQueueTable();
    } else if (activeContextTarget.type === 'activity') {
      activitiesList.splice(activeContextTarget.index, 1);
      renderActivitiesTable();
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

// --- HELPER FUNCTIONS ---
function setStatus(text, color = 'slate') {
  footerStatusText.textContent = text;
  
  footerStatusBadge.className = 'w-2.5 h-2.5 rounded-full animate-pulse';
  if (color === 'emerald') footerStatusBadge.classList.add('bg-emerald-500');
  else if (color === 'blue') footerStatusBadge.classList.add('bg-blue-500');
  else if (color === 'red') footerStatusBadge.classList.add('bg-red-500');
  else if (color === 'amber') footerStatusBadge.classList.add('bg-amber-500');
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
