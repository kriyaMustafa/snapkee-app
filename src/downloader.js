const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { EventEmitter } = require('events');

// Modern desktop web browser User-Agent pool for rotation
const USER_AGENTS_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0'
];

class DownloaderEngine extends EventEmitter {
  constructor() {
    super();
    this.activeQueue = [];
    this.runningCount = 0;
    this.completedCount = 0;
    this.totalCount = 0;
    this.concurrencyLimit = 2;
    this.isCancelled = false;
    this.activeControllers = new Map();
    this.speedMetrics = new Map(); // id -> bytes per second
    this.speedTimer = null;
  }

  getModernUserAgent(settings, item) {
    if (item.userAgent && typeof item.userAgent === 'string') return item.userAgent;
    if (settings && settings.userAgent && typeof settings.userAgent === 'string') return settings.userAgent;
    const idx = Math.abs((item.id || 1)) % USER_AGENTS_POOL.length;
    return USER_AGENTS_POOL[idx];
  }

  prepareCookieConfig(settings, item, targetDir) {
    const rawCookies = item.cookies || (settings && (settings.cookies || settings.cookieFile)) || '';
    if (!rawCookies || typeof rawCookies !== 'string') {
      return { cookieFile: null, cookieHeader: null };
    }
    const trimmed = rawCookies.trim();
    if (!trimmed) return { cookieFile: null, cookieHeader: null };

    // 1. Check if it's an absolute file path to an existing cookies.txt on disk
    if (fs.existsSync(trimmed)) {
      try {
        const content = fs.readFileSync(trimmed, 'utf8');
        const cookiePairs = [];
        content.split('\n').forEach(line => {
          const l = line.trim();
          if (!l || l.startsWith('#')) return;
          const parts = l.split('\t');
          if (parts.length >= 7) {
            cookiePairs.push(`${parts[5]}=${parts[6]}`);
          }
        });
        const headerStr = cookiePairs.length > 0 ? cookiePairs.join('; ') : null;
        return { cookieFile: trimmed, cookieHeader: headerStr };
      } catch (e) {
        return { cookieFile: trimmed, cookieHeader: null };
      }
    }

    // 2. Check if it is a Netscape format string pasted directly
    if (trimmed.includes('\t') && (trimmed.includes('TRUE') || trimmed.includes('FALSE') || trimmed.startsWith('# Netscape'))) {
      try {
        const tempPath = path.join(targetDir, `.temp_cookies_${item.id || Date.now()}.txt`);
        fs.writeFileSync(tempPath, trimmed, 'utf8');
        const cookiePairs = [];
        trimmed.split('\n').forEach(line => {
          const l = line.trim();
          if (!l || l.startsWith('#')) return;
          const parts = l.split('\t');
          if (parts.length >= 7) {
            cookiePairs.push(`${parts[5]}=${parts[6]}`);
          }
        });
        return { cookieFile: tempPath, cookieHeader: cookiePairs.join('; ') };
      } catch (e) {
        return { cookieFile: null, cookieHeader: null };
      }
    }

    // 3. Otherwise treat as a raw Cookie header string (e.g. "SESSDATA=abc; bili_jct=xyz;")
    const headerStr = trimmed.replace(/^Cookie:\s*/i, '');
    return { cookieFile: null, cookieHeader: headerStr };
  }

  cleanMovieTitle(item) {
    let raw = (item.title || item.movieName || `Movie_Video_${item.id || Date.now()}`).trim();
    // Clean colons cleanly into dashes instead of underscores
    raw = raw.replace(/:\s*/g, ' - ');
    // Remove characters that are illegal in Windows / macOS filenames (< > : " / \ | ? *) while preserving spaces and international letters
    let clean = raw.replace(/[<>"/\\|?*\x00-\x1F]/g, '').trim();
    clean = clean.replace(/[\.\s]+$/, '');
    if (!clean) {
      clean = `Movie_Video_${item.id || Date.now()}`;
    }
    return clean.substring(0, 150);
  }

  getTargetDir(item, settings) {
    const baseDir = settings.directory || path.join(process.cwd(), 'Downloads');
    if (item && item.folder && typeof item.folder === 'string' && item.folder.trim()) {
      const sub = item.folder.trim();
      if (baseDir.replace(/\\/g, '/').toLowerCase().endsWith(`/${sub.toLowerCase()}`)) {
        return baseDir;
      }
      return path.join(baseDir, sub);
    }
    return baseDir;
  }

  startQueue(items, settings) {
    this.cancelAll(); // Clean up any previous runs
    this.isCancelled = false;
    // Allow up to 6 parallel items downloading at once, each using aggressive multi-threaded range chunks
    this.concurrencyLimit = Math.min(6, Math.max(1, parseInt(settings.itemConcurrency || 4, 10)));
    this.activeQueue = [...items];
    this.totalCount = items.length;
    this.completedCount = 0;
    this.runningCount = 0;
    this.speedMetrics.clear();

    // Start global speed broadcast interval
    this.speedTimer = setInterval(() => {
      this.broadcastGlobalStatus();
    }, 500);

    // Launch worker tasks up to item concurrency limit
    for (let i = 0; i < this.concurrencyLimit; i++) {
      this.processNextInQueue(settings);
    }
  }

  async downloadWithYtDlp(item, filePath, settings) {
    const { spawn } = require('child_process');
    const targetUrl = item.downloadUrl || item.url;
    const targetDir = path.dirname(filePath);
    const baseFilenameWithoutExt = this.cleanMovieTitle(item);

    const userAgent = this.getModernUserAgent(settings, item);
    const { cookieFile, cookieHeader } = this.prepareCookieConfig(settings, item, targetDir);

    return new Promise((resolve) => {
      let isDone = false;
      const targetUrlLower = targetUrl.toLowerCase();
      const isBilibili = targetUrlLower.includes('bilibili') || targetUrlLower.includes('b23.tv') || targetUrlLower.includes('bibili') || item.platform === 'BiliBili' || (item.profile && item.profile.toLowerCase().includes('bili'));

      const args = [
        '--newline',
        '--no-playlist',
        '--no-warnings',
        '--ignore-errors'
      ];

      // 1. ROTATE MODERN BROWSER USER-AGENT
      args.push('--user-agent', userAgent);

      // 2. COOKIE & AUTHENTICATION INJECTION
      if (cookieFile && fs.existsSync(cookieFile)) {
        args.push('--cookies', cookieFile);
      } else if (cookieHeader) {
        args.push('--add-header', `Cookie: ${cookieHeader}`);
      }

      // 3. REFERER HEADER & EXTRACTOR ARGS FOR BILIBILI
      if (isBilibili) {
        args.push('--add-header', 'Referer: https://www.bilibili.com/');
        args.push('--extractor-args', 'bilibili:player_client=android,web');
      } else {
        args.push('--add-header', `Referer: ${targetUrl}`);
      }

      // 4. MULTI-THREADED / CHUNKED SPEED OPTIMIZATION (-N & HTTP CHUNK SIZE)
      // HARD CAP at 6 threads to prevent Bilibili anti-bot triggering which drops speed to 0.5 Mbps
      const numThreads = Math.min(6, Math.max(2, parseInt(settings.threads || 4, 10)));
      args.push('-N', `${numThreads}`);
      args.push('--concurrent-fragments', `${numThreads}`);
      args.push('--http-chunk-size', '1M');
      args.push('--buffer-size', '64K');
      args.push('--file-access-retries', '10');
      args.push('--retries', '10');
      args.push('--fragment-retries', '10');

      // 5. MERGE SEPARATE VIDEO & AUDIO STREAMS (FFMPEG)
      if (item.type && item.type.includes('mp3')) {
        args.push('-x', '--audio-format', 'mp3');
      } else if (isBilibili) {
        args.push('-f', 'bv*+ba/b/best');
        args.push('--merge-output-format', 'mp4');
      } else {
        args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best/bestvideo/bestaudio');
        args.push('--merge-output-format', 'mp4');
        args.push('--remux-video', 'mp4');
      }

      const outputTemplate = path.join(targetDir, `${baseFilenameWithoutExt}.%(ext)s`);
      args.push('-o', outputTemplate);
      args.push(targetUrl);

      const proc = spawn('yt-dlp', args);

      // Capture exact stderr output for diagnosis
      let stderrLog = '';
      if (proc.stderr) {
        proc.stderr.on('data', (errData) => {
          if (this.isCancelled) return;
          stderrLog += errData.toString();
        });
      }

      this.activeControllers.set(item.id, {
        abort: () => {
          try { proc.kill('SIGTERM'); } catch (e) {}
        }
      });

      proc.stdout.on('data', (data) => {
        if (this.isCancelled) return;
        const lines = data.toString().split('\n');
        for (const line of lines) {
          const match = line.match(/\[download\]\s+([\d\.]+)%\s+of\s+~?([\d\.]+)([KMG]i?B)\s+(?:at\s+([\d\.]+)([KMG]i?B\/s))?/i);
          if (match) {
            const percentage = Math.min(99, Math.round(parseFloat(match[1])));
            let downloadedMB = item.sizeMB || '0.00';
            if (match[2] && match[3]) {
              const val = parseFloat(match[2]);
              const unit = match[3].toUpperCase();
              if (unit.includes('M')) downloadedMB = val.toFixed(2);
              else if (unit.includes('G')) downloadedMB = (val * 1024).toFixed(2);
              else if (unit.includes('K')) downloadedMB = (val / 1024).toFixed(2);
            }
            let speedMbps = '0.00';
            if (match[4] && match[5]) {
              const val = parseFloat(match[4]);
              const unit = match[5].toUpperCase();
              let bytesPerSec = val;
              if (unit.includes('M')) bytesPerSec = val * 1024 * 1024;
              else if (unit.includes('G')) bytesPerSec = val * 1024 * 1024 * 1024;
              else if (unit.includes('K')) bytesPerSec = val * 1024;
              this.speedMetrics.set(item.id, bytesPerSec);
              speedMbps = ((bytesPerSec * 8) / (1024 * 1024)).toFixed(2);
            }

            this.emit('item-progress', {
              id: item.id,
              status: `Downloading (${percentage}%)`,
              percentage,
              downloadedMB,
              speedMbps,
              filePath
            });
          }
        }
      });

      proc.on('error', async (err) => {
        if (!isDone) {
          this.activeControllers.delete(item.id);
          this.speedMetrics.delete(item.id);
          if (isBilibili && !this.isCancelled) {
            this.emit('item-progress', { id: item.id, status: 'Downloading Parallel Direct...', percentage: 1, downloadedMB: '0.10' });
            const directSuccess = await this.downloadBilibiliDirectly(item, filePath, settings);
            if (directSuccess && fs.existsSync(filePath)) {
              if (!isDone) {
                isDone = true;
                this.completedCount++;
                this.runningCount--;
                const stats = fs.statSync(filePath);
                item.filePath = filePath;
                this.emit('item-progress', {
                  id: item.id,
                  status: 'Completed',
                  percentage: 100,
                  downloadedMB: (stats.size / (1024 * 1024)).toFixed(2),
                  speedMbps: '0.00',
                  filePath
                });
                this.processNextInQueue(settings);
                resolve();
              }
              return;
            }
          }
          isDone = true;
          this.runningCount--;
          const errMsg = `Error: ${err.message || 'yt-dlp spawn failed'}`;
          console.error(`[yt-dlp Spawn Error - Item ${item.id}] URL: ${targetUrl}\nError:`, err);
          this.emit('item-progress', {
            id: item.id,
            status: errMsg.substring(0, 90),
            percentage: 0,
            downloadedMB: '0.00'
          });
          this.processNextInQueue(settings);
          resolve();
        }
      });

      proc.on('close', async (code) => {
        this.activeControllers.delete(item.id);
        this.speedMetrics.delete(item.id);
        if (this.isCancelled) {
          if (!isDone) {
            isDone = true;
            this.runningCount--;
            this.emit('item-progress', { id: item.id, status: 'Cancelled', percentage: 0, downloadedMB: '0.00' });
            resolve();
          }
          return;
        }

        let actualFilePath = null;
        const possibleExtensions = ['.mp4', '.flv', '.mkv', '.webm', '.m4a', '.mp3', '.mov', path.extname(filePath)];

        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
          actualFilePath = filePath;
        } else {
          for (const checkExt of possibleExtensions) {
            const checkPath = path.join(targetDir, `${baseFilenameWithoutExt}${checkExt}`);
            if (fs.existsSync(checkPath) && fs.statSync(checkPath).size > 0) {
              actualFilePath = checkPath;
              break;
            }
          }
        }

        if (!actualFilePath && fs.existsSync(targetDir)) {
          try {
            const files = fs.readdirSync(targetDir);
            const found = files.find(f => 
              f.startsWith(baseFilenameWithoutExt) && 
              !f.endsWith('.part') && 
              !f.endsWith('.ytdl') && 
              !f.endsWith('.temp') &&
              !f.includes('.temp_cookies_')
            );
            if (found) {
              const checkPath = path.join(targetDir, found);
              if (fs.statSync(checkPath).size > 0) {
                actualFilePath = checkPath;
              }
            }
          } catch (e) {}
        }

        if (actualFilePath) {
          if (!isDone) {
            isDone = true;
            this.completedCount++;
            this.runningCount--;
            const stats = fs.statSync(actualFilePath);
            const finalSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            item.filePath = actualFilePath;
            this.emit('item-progress', {
              id: item.id,
              status: 'Completed',
              percentage: 100,
              downloadedMB: finalSizeMB,
              speedMbps: '0.00',
              filePath: actualFilePath
            });
            this.processNextInQueue(settings);
            resolve();
          }
        } else {
          if (isBilibili && !this.isCancelled) {
            this.emit('item-progress', { id: item.id, status: 'Downloading Parallel Direct...', percentage: 1, downloadedMB: '0.10' });
            const directSuccess = await this.downloadBilibiliDirectly(item, filePath, settings);
            if (directSuccess && fs.existsSync(filePath)) {
              if (!isDone) {
                isDone = true;
                this.completedCount++;
                this.runningCount--;
                const stats = fs.statSync(filePath);
                item.filePath = filePath;
                this.emit('item-progress', {
                  id: item.id,
                  status: 'Completed',
                  percentage: 100,
                  downloadedMB: (stats.size / (1024 * 1024)).toFixed(2),
                  speedMbps: '0.00',
                  filePath
                });
                this.processNextInQueue(settings);
                resolve();
              }
              return;
            }
          }
          if (!isDone) {
            isDone = true;
            this.runningCount--;
            try {
              if (fs.existsSync(targetDir)) {
                const files = fs.readdirSync(targetDir);
                files.forEach(f => {
                  if (f.startsWith(baseFilenameWithoutExt) && (f.endsWith('.part') || f.endsWith('.ytdl') || f.endsWith('.temp'))) {
                    try { fs.unlinkSync(path.join(targetDir, f)); } catch (e) {}
                  }
                });
              }
            } catch (e) {}

            let statusMsg = `Error (yt-dlp exit ${code})`;
            if (stderrLog || code !== 0) {
              if (stderrLog) {
                const errorLines = stderrLog.split('\n')
                  .map(l => l.trim())
                  .filter(l => l && (l.includes('ERROR:') || l.includes('HTTP Error') || l.includes('403') || l.includes('Forbidden') || l.includes('ffmpeg') || l.includes('format not available') || l.includes('geo-blocked') || l.includes('login') || l.includes('cookie') || l.includes('Precondition') || l.includes('Requested format')))
                  .map(l => l.replace(/^ERROR:\s*/i, ''));
                
                if (errorLines.length > 0) {
                  statusMsg = `Error: ${errorLines[0].substring(0, 90)}`;
                } else {
                  const firstErr = stderrLog.split('\n').map(l => l.trim()).find(l => l && l.toLowerCase().includes('error'));
                  if (firstErr) {
                    statusMsg = `Error: ${firstErr.replace(/^ERROR:\s*/i, '').substring(0, 90)}`;
                  }
                }
              }
            }

            this.emit('item-progress', {
              id: item.id,
              status: statusMsg,
              percentage: 0,
              downloadedMB: '0.00'
            });
            this.processNextInQueue(settings);
            resolve();
          }
        }
      });
    });
  }

  async downloadBilibiliDirectly(item, filePath, settings) {
    try {
      const targetUrl = item.downloadUrl || item.url || '';
      let bvidMatch = targetUrl.match(/BV[0-9a-zA-Z]+/i);
      let aidMatch = targetUrl.match(/av([0-9]+)/i);
      if (!bvidMatch && !aidMatch) return false;

      const pageMatch = targetUrl.match(/[?&]p=([0-9]+)/i);
      const pageNum = pageMatch ? parseInt(pageMatch[1], 10) : 1;

      let cid = null;
      const userAgent = this.getModernUserAgent(settings, item);
      const targetDir = path.dirname(filePath);
      const { cookieHeader } = this.prepareCookieConfig(settings, item, targetDir);

      const headers = {
        'User-Agent': userAgent,
        'Referer': 'https://www.bilibili.com/'
      };
      if (cookieHeader) {
        headers['Cookie'] = cookieHeader;
      }

      const pagelistUrl = bvidMatch 
        ? `https://api.bilibili.com/x/player/pagelist?bvid=${bvidMatch[0]}`
        : `https://api.bilibili.com/x/player/pagelist?aid=${aidMatch[1]}`;

      const listRes = await axios.get(pagelistUrl, { headers, timeout: 15000 });
      if (listRes.data && listRes.data.code === 0 && Array.isArray(listRes.data.data) && listRes.data.data.length > 0) {
        const pageEntry = listRes.data.data.find(e => e.page === pageNum) || listRes.data.data[0];
        cid = pageEntry.cid;
      }

      if (!cid) return false;

      const playUrl = bvidMatch
        ? `https://api.bilibili.com/x/player/playurl?bvid=${bvidMatch[0]}&cid=${cid}&qn=80`
        : `https://api.bilibili.com/x/player/playurl?aid=${aidMatch[1]}&cid=${cid}&qn=80`;

      const playRes = await axios.get(playUrl, { headers, timeout: 15000 });
      if (!playRes.data || playRes.data.code !== 0 || !playRes.data.data) return false;

      let streamUrl = null;
      if (playRes.data.data.durl && Array.isArray(playRes.data.data.durl) && playRes.data.data.durl.length > 0) {
        streamUrl = playRes.data.data.durl[0].url;
      }

      if (!streamUrl) return false;

      // Use our new parallel multi-threaded chunk downloader
      return await this.downloadWithParallelChunks(streamUrl, filePath, item, settings, headers);
    } catch (e) {
      this.activeControllers.delete(item.id);
      this.speedMetrics.delete(item.id);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (err) {}
      }
      return false;
    }
  }

  // CORE ENGINE: Multi-Threaded Chunk Requests (HTTP Range Headers)
  async downloadWithParallelChunks(downloadUrl, filePath, item, settings, headers) {
    const numThreads = Math.min(6, Math.max(2, parseInt(settings.threads || 4, 10)));
    const controller = new AbortController();
    this.activeControllers.set(item.id, controller);

    // 1. Inspect Content-Length and check server Range support via HEAD
    let totalBytes = parseFloat(item.sizeMB || 0) * 1024 * 1024;
    let supportsRange = false;
    try {
      const headRes = await axios({
        method: 'HEAD',
        url: downloadUrl,
        timeout: 15000,
        headers: headers,
        signal: controller.signal
      });
      if (headRes.headers['content-length']) {
        totalBytes = parseInt(headRes.headers['content-length'], 10);
      }
      if (headRes.headers['accept-ranges'] && headRes.headers['accept-ranges'].toLowerCase().includes('bytes')) {
        supportsRange = true;
      } else {
        // Test 1-byte range if accept-ranges header wasn't explicit
        const testRes = await axios({
          method: 'GET',
          url: downloadUrl,
          headers: { ...headers, 'Range': 'bytes=0-0' },
          timeout: 10000,
          responseType: 'arraybuffer',
          signal: controller.signal
        }).catch(() => null);
        if (testRes && (testRes.status === 206 || (testRes.headers['content-range'] && testRes.headers['content-range'].includes('bytes')))) {
          supportsRange = true;
        }
      }
    } catch (e) {}

    // Fall back to single stream if server does not accept Range headers or file is small (< 2MB)
    if (!supportsRange || totalBytes < 2 * 1024 * 1024 || numThreads <= 1) {
      return await this.downloadSingleStreamAxios(downloadUrl, filePath, item, settings, headers, totalBytes, controller);
    }

    // 2. Pre-allocate file on disk and hold ONE shared open descriptor to prevent disk I/O thrashing
    let sharedFd = null;
    try {
      sharedFd = fs.openSync(filePath, 'w+');
      if (totalBytes > 0) {
        fs.ftruncateSync(sharedFd, totalBytes);
      }
    } catch (err) {
      if (sharedFd !== null) { try { fs.closeSync(sharedFd); } catch(e) {} }
      return await this.downloadSingleStreamAxios(downloadUrl, filePath, item, settings, headers, totalBytes, controller);
    }

    // 3. Divide byte range evenly across numThreads worker streams
    const chunks = [];
    const chunkSize = Math.ceil(totalBytes / numThreads);
    for (let i = 0; i < numThreads; i++) {
      const startByte = i * chunkSize;
      if (startByte >= totalBytes) break;
      const endByte = Math.min((i + 1) * chunkSize - 1, totalBytes - 1);
      chunks.push({ index: i, startByte, endByte, downloaded: 0 });
    }

    let lastTime = Date.now();
    let lastTotalDownloaded = 0;

    const updateProgress = () => {
      if (this.isCancelled) return;
      let currentTotal = 0;
      for (const ch of chunks) currentTotal += ch.downloaded;
      
      const now = Date.now();
      const timeDiff = (now - lastTime) / 1000;
      if (timeDiff >= 0.25 || currentTotal >= totalBytes) {
        const bytesDiff = currentTotal - lastTotalDownloaded;
        const bytesPerSec = timeDiff > 0 ? (bytesDiff / timeDiff) : (bytesDiff * 4);
        this.speedMetrics.set(item.id, bytesPerSec);

        lastTime = now;
        lastTotalDownloaded = currentTotal;

        const percentage = Math.min(99, Math.round((currentTotal / totalBytes) * 100));
        const downloadedMB = (currentTotal / (1024 * 1024)).toFixed(2);
        const speedMbps = ((bytesPerSec * 8) / (1024 * 1024)).toFixed(2);

        this.emit('item-progress', {
          id: item.id,
          status: `Downloading Parallel (${chunks.length} Threads - ${percentage}%)`,
          percentage,
          downloadedMB,
          speedMbps,
          filePath
        });
      }
    };

    // 4. Execute parallel worker streams concurrently using shared file descriptor
    const workerPromises = chunks.map(async (chunk) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (this.isCancelled) break;
        try {
          const currentStart = chunk.startByte + chunk.downloaded;
          if (currentStart > chunk.endByte) break; // Chunk completed

          const chunkHeaders = {
            ...headers,
            'Range': `bytes=${currentStart}-${chunk.endByte}`
          };

          const response = await axios({
            method: 'GET',
            url: downloadUrl,
            responseType: 'stream',
            signal: controller.signal,
            timeout: 30000,
            headers: chunkHeaders
          });

          if (response.status === 200 && chunk.startByte > 0) {
            throw new Error('Server returned 200 OK instead of 206 Partial Content during range query');
          }

          await new Promise((resolveChunk, rejectChunk) => {
            const stream = response.data;
            stream.on('data', (buffer) => {
              if (this.isCancelled) {
                stream.destroy();
                return;
              }
              try {
                const writeOffset = chunk.startByte + chunk.downloaded;
                fs.writeSync(sharedFd, buffer, 0, buffer.length, writeOffset);

                chunk.downloaded += buffer.length;
                updateProgress();
              } catch (writeErr) {
                stream.destroy();
                rejectChunk(writeErr);
              }
            });

            stream.on('end', resolveChunk);
            stream.on('error', rejectChunk);
          });

          break; // Worker stream finished successfully
        } catch (err) {
          if (axios.isCancel(err) || this.isCancelled) break;
          if (attempt === 3) throw err;
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        }
      }
    });

    try {
      await Promise.all(workerPromises);
      if (sharedFd !== null) { try { fs.closeSync(sharedFd); sharedFd = null; } catch(e) {} }
      this.activeControllers.delete(item.id);
      this.speedMetrics.delete(item.id);

      if (this.isCancelled) {
        if (fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (e) {}
        }
        return false;
      }
      return fs.existsSync(filePath) && fs.statSync(filePath).size > 1024;
    } catch (err) {
      if (sharedFd !== null) { try { fs.closeSync(sharedFd); sharedFd = null; } catch(e) {} }
      this.activeControllers.delete(item.id);
      this.speedMetrics.delete(item.id);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
      return false;
    } finally {
      if (sharedFd !== null) { try { fs.closeSync(sharedFd); } catch(e) {} }
    }
  }

  async downloadSingleStreamAxios(downloadUrl, filePath, item, settings, headers, totalBytes, controller) {
    let downloadSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (this.isCancelled) break;
      try {
        if (attempt === 1) {
          this.emit('item-progress', { id: item.id, status: 'Downloading Stream...', percentage: 1, downloadedMB: '0.10', speedMbps: '0.00' });
        } else {
          this.emit('item-progress', { id: item.id, status: `Retrying (${attempt}/3)...`, percentage: 1, downloadedMB: '0.10', speedMbps: '0.00' });
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        }

        const response = await axios({
          method: 'GET',
          url: downloadUrl,
          responseType: 'stream',
          signal: controller.signal,
          timeout: 30000,
          headers: headers
        });

        const actualBytes = parseInt(response.headers['content-length'], 10) || totalBytes || (parseFloat(item.sizeMB || 10) * 1024 * 1024);
        let downloadedBytes = 0;
        let lastTime = Date.now();
        let lastBytes = 0;

        const writer = fs.createWriteStream(filePath, { highWaterMark: 256 * 1024 });
        response.data.on('data', (chunk) => {
          if (this.isCancelled) return;
          downloadedBytes += chunk.length;

          const now = Date.now();
          const timeDiff = (now - lastTime) / 1000;
          if (timeDiff >= 0.3) {
            const bytesDiff = downloadedBytes - lastBytes;
            const bytesPerSec = bytesDiff / timeDiff;
            this.speedMetrics.set(item.id, bytesPerSec);

            lastTime = now;
            lastBytes = downloadedBytes;

            const percentage = Math.min(99, Math.round((downloadedBytes / actualBytes) * 100));
            const downloadedMB = (downloadedBytes / (1024 * 1024)).toFixed(2);
            const speedMbps = ((bytesPerSec * 8) / (1024 * 1024)).toFixed(2);

            this.emit('item-progress', {
              id: item.id,
              status: `Downloading (${percentage}%)`,
              percentage,
              downloadedMB,
              speedMbps,
              filePath
            });
          }
        });

        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
          response.data.pipe(writer);
          response.data.on('error', reject);
        });

        if (!this.isCancelled) {
          downloadSuccess = true;
          this.activeControllers.delete(item.id);
          this.speedMetrics.delete(item.id);
          return fs.existsSync(filePath) && fs.statSync(filePath).size > 1024;
        }
      } catch (error) {
        if (axios.isCancel(error) || this.isCancelled) break;
        if (attempt === 3) throw error;
      }
    }
    this.activeControllers.delete(item.id);
    this.speedMetrics.delete(item.id);
    return downloadSuccess;
  }

  async processNextInQueue(settings) {
    if (this.isCancelled || this.activeQueue.length === 0) {
      if (this.runningCount === 0 && this.speedTimer) {
        clearInterval(this.speedTimer);
        this.speedTimer = null;
        this.broadcastGlobalStatus();
        this.emit('queue-completed', { completed: this.completedCount, total: this.totalCount });
      }
      return;
    }

    const item = this.activeQueue.shift();
    this.runningCount++;
    const targetDir = this.getTargetDir(item, settings);

    // Ensure target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const baseFilenameWithoutExt = this.cleanMovieTitle(item);
    const ext = item.type && item.type.includes('mp3') ? '.mp3' : '.mp4';
    const filename = `${baseFilenameWithoutExt}${ext}`;
    const filePath = path.join(targetDir, filename);

    const targetUrlLower = (item.downloadUrl || item.url || '').toLowerCase();
    if (item.useYtDlp || item.platform === 'YouTube' || item.platform === 'TikTok' || item.platform === 'DramaBox' || item.platform === 'BiliBili' || targetUrlLower.includes('bilibili') || targetUrlLower.includes('b23.tv') || targetUrlLower.includes('bibili') || targetUrlLower.includes('dramabox') || targetUrlLower.includes('youtube') || targetUrlLower.includes('youtu.be') || targetUrlLower.includes('tiktok')) {
      await this.downloadWithYtDlp(item, filePath, settings);
      return;
    }

    const downloadUrl = item.downloadUrl || item.url;
    const userAgent = this.getModernUserAgent(settings, item);
    const { cookieHeader } = this.prepareCookieConfig(settings, item, targetDir);

    const headers = {
      'User-Agent': userAgent,
      'Accept': '*/*'
    };
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    // Execute Multi-Threaded Chunk Range download engine
    const success = await this.downloadWithParallelChunks(downloadUrl, filePath, item, settings, headers);

    this.runningCount--;
    if (success && fs.existsSync(filePath)) {
      this.completedCount++;
      const stats = fs.statSync(filePath);
      const totalBytes = stats.size;
      this.emit('item-progress', {
        id: item.id,
        status: 'Completed',
        percentage: 100,
        downloadedMB: (totalBytes / (1024 * 1024)).toFixed(2),
        speedMbps: '0.00',
        filePath
      });
    } else if (!this.isCancelled) {
      this.emit('item-progress', {
        id: item.id,
        status: 'Error: Parallel download failed after retries',
        percentage: 0,
        downloadedMB: '0.00'
      });
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
    }

    // Process next item right away
    this.processNextInQueue(settings);
  }

  cancelAll() {
    this.isCancelled = true;
    if (this.speedTimer) {
      clearInterval(this.speedTimer);
      this.speedTimer = null;
    }
    for (const [id, controller] of this.activeControllers.entries()) {
      try {
        if (typeof controller.abort === 'function') controller.abort();
      } catch (e) {}
    }
    this.activeControllers.clear();
    this.speedMetrics.clear();
    this.activeQueue = [];
    this.runningCount = 0;
    this.emit('global-metrics', { totalSpeedMbps: '0.00', running: 0, completed: this.completedCount });
  }

  broadcastGlobalStatus() {
    let totalBytesPerSec = 0;
    for (const speed of this.speedMetrics.values()) {
      totalBytesPerSec += speed;
    }
    const totalMbps = ((totalBytesPerSec * 8) / (1024 * 1024)).toFixed(2);
    this.emit('global-metrics', {
      totalSpeedMbps: totalMbps,
      running: this.runningCount,
      completed: this.completedCount,
      total: this.totalCount
    });
  }
}

module.exports = DownloaderEngine;
