const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const axios = require('axios');
const { EventEmitter } = require('events');

// High-performance persistent connection pooling to eliminate TLS handshake latency
const HTTP_AGENT = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 128,
  maxFreeSockets: 64,
  timeout: 60000
});

const HTTPS_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60000,
  maxSockets: 128,
  maxFreeSockets: 64,
  timeout: 60000
});

// Modern desktop web browser User-Agent pool for rotation
const USER_AGENTS_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0'
];

// High-performance Cookie cache to eliminate file I/O latency on repeated chunk/stream operations
const COOKIE_PARSER_CACHE = new Map();

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

  emitLog(level, message, extra = {}) {
    this.emit('log', {
      ts: Date.now(),
      level,
      message: String(message || ''),
      ...extra
    });
  }

  getModernUserAgent(settings, item) {
    if (item.userAgent && typeof item.userAgent === 'string') return item.userAgent;
    if (settings && settings.userAgent && typeof settings.userAgent === 'string') return settings.userAgent;
    const idx = Math.abs((item.id || 1)) % USER_AGENTS_POOL.length;
    return USER_AGENTS_POOL[idx];
  }

  getBilibiliReferer(item) {
    const rawUrl = (item && (item.url || item.downloadUrl)) || '';
    try {
      const parsed = new URL(rawUrl);
      const bvidMatch = rawUrl.match(/BV[0-9a-zA-Z]+/i);
      const aidMatch = rawUrl.match(/av([0-9]+)/i);
      const pageMatch = rawUrl.match(/[?&]p=([0-9]+)/i);
      const pageNum = pageMatch ? pageMatch[1] : null;
      if (bvidMatch) {
        return `https://www.bilibili.com/video/${bvidMatch[0]}` + (pageNum && pageNum !== '1' ? `?p=${pageNum}` : '');
      }
      if (aidMatch) {
        return `https://www.bilibili.com/video/av${aidMatch[1]}` + (pageNum && pageNum !== '1' ? `?p=${pageNum}` : '');
      }
      parsed.searchParams.delete('spm_id_from');
      parsed.searchParams.delete('vd_source');
      parsed.searchParams.delete('from_spm');
      parsed.searchParams.delete('seid');
      return parsed.toString();
    } catch {
      return 'https://www.bilibili.com/';
    }
  }

  getBilibiliDashTuning(totalBytes, streamType, settings = {}) {
    const mode = String(settings.bilibiliMode || 'fast').toLowerCase();

    // Conservative connection limits to prevent Bilibili CDN IP throttling or connection drops on long (2-3h+) videos
    const isLongVideo = totalBytes > 300 * 1024 * 1024;
    const presets = {
      stable: {
        videoWorkers: isLongVideo ? 3 : 4,
        audioWorkers: 1,
        minVideoChunkMB: 4,
        maxVideoChunkMB: 16,
        minAudioChunkMB: 2,
        maxAudioChunkMB: 8,
        staggerMs: 40,
        flushIntervalMs: 50,
        flushThresholdKB: 512,
        maxBufferedKB: 2048,
        retryBackoffMs: 800,
        maxChunkRetries: 25
      },
      balanced: {
        videoWorkers: isLongVideo ? 4 : 6,
        audioWorkers: 2,
        minVideoChunkMB: 4,
        maxVideoChunkMB: 20,
        minAudioChunkMB: 2,
        maxAudioChunkMB: 10,
        staggerMs: 25,
        flushIntervalMs: 40,
        flushThresholdKB: 1024,
        maxBufferedKB: 4096,
        retryBackoffMs: 600,
        maxChunkRetries: 25
      },
      fast: {
        videoWorkers: isLongVideo ? 4 : 6,
        audioWorkers: 2,
        minVideoChunkMB: 4,
        maxVideoChunkMB: 24,
        minAudioChunkMB: 2,
        maxAudioChunkMB: 12,
        staggerMs: 15,
        flushIntervalMs: 30,
        flushThresholdKB: 1024,
        maxBufferedKB: 4096,
        retryBackoffMs: 500,
        maxChunkRetries: 25
      }
    };
    const preset = presets[mode] || presets.fast;
    const workerCap = streamType === 'audio' ? preset.audioWorkers : preset.videoWorkers;
    const requested = Math.max(
      1,
      parseInt(settings.bilibiliThreads || settings.threads || preset.videoWorkers, 10)
    );
    const workerCount = Math.min(workerCap, requested);

    const minChunkBytes = (streamType === 'audio' ? preset.minAudioChunkMB : preset.minVideoChunkMB) * 1024 * 1024;
    const maxChunkBytes = (streamType === 'audio' ? preset.maxAudioChunkMB : preset.maxVideoChunkMB) * 1024 * 1024;
    let chunkBytes = totalBytes > 0
      ? Math.ceil(totalBytes / Math.max(workerCount * 4, 12))
      : minChunkBytes;
    if (chunkBytes < minChunkBytes) chunkBytes = minChunkBytes;
    if (chunkBytes > maxChunkBytes) chunkBytes = maxChunkBytes;

    return {
      workerCount,
      chunkBytes,
      initialStaggerMs: streamType === 'audio' ? 0 : preset.staggerMs,
      flushIntervalMs: preset.flushIntervalMs,
      flushThresholdBytes: preset.flushThresholdKB * 1024,
      maxBufferedBytes: preset.maxBufferedKB * 1024,
      retryBackoffMs: preset.retryBackoffMs,
      maxChunkRetries: preset.maxChunkRetries
    };
  }

  formatSrtTimestamp(seconds) {
    const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
    const hours = String(Math.floor(totalMs / 3600000)).padStart(2, '0');
    const minutes = String(Math.floor((totalMs % 3600000) / 60000)).padStart(2, '0');
    const secs = String(Math.floor((totalMs % 60000) / 1000)).padStart(2, '0');
    const ms = String(totalMs % 1000).padStart(3, '0');
    return `${hours}:${minutes}:${secs},${ms}`;
  }

  safeSubtitleName(label, fallback = 'subtitle') {
    const cleaned = String(label || fallback)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return (cleaned || fallback).substring(0, 80);
  }

  subtitleJsonToSrt(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return '';
    return entries.map((entry, index) => {
      const start = this.formatSrtTimestamp(entry.from);
      const end = this.formatSrtTimestamp(entry.to);
      const content = String(entry.content || '').replace(/\r?\n/g, ' ').trim();
      return `${index + 1}\n${start} --> ${end}\n${content}`;
    }).join('\n\n') + '\n';
  }

  extractBilibiliSubtitleTracks(payload) {
    const sources = [
      payload?.data?.subtitle?.subtitles,
      payload?.data?.subtitle?.list,
      payload?.data?.subtitle?.tracks,
      payload?.data?.subtitle_list,
      payload?.data?.subtitleList,
      payload?.data?.subtitles,
      payload?.data?.subtitle
    ];

    for (const source of sources) {
      if (Array.isArray(source) && source.length > 0) return source;
      if (source && Array.isArray(source.subtitles) && source.subtitles.length > 0) return source.subtitles;
      if (source && Array.isArray(source.list) && source.list.length > 0) return source.list;
      if (source && Array.isArray(source.tracks) && source.tracks.length > 0) return source.tracks;
    }

    return [];
  }

  isBilibiliAiSubtitleTrack(track) {
    if (!track || typeof track !== 'object') return false;
    const lan = String(track.lan || '').toLowerCase();
    const lanDoc = String(track.lan_doc || '').toLowerCase();
    return track.is_machine === 1 || lan === 'ai-zh' || lanDoc === 'ai-zh' || lanDoc.includes('自动生成');
  }

  getBilibiliSubtitleTracksLabel(tracks) {
    const subtitles = Array.isArray(tracks) ? tracks : [];
    if (subtitles.length === 0) return null;

    const hasAi = subtitles.some(track => this.isBilibiliAiSubtitleTrack(track));
    return hasAi ? 'video/mp4 (+ Subtitle [AI-ZH])' : 'video/mp4 (+ Subtitle)';
  }

  getBilibiliSubtitleTrackFilename(track, index) {
    if (this.isBilibiliAiSubtitleTrack(track)) return 'ai-zh';

    const lanDoc = String(track?.lan_doc || '').trim();
    const lan = String(track?.lan || '').trim();
    const fallback = `sub${index + 1}`;
    return this.safeSubtitleName(lanDoc || lan || fallback, fallback);
  }

  async fetchBilibiliSubtitleTracks(headers, cid, bvidMatch, aidMatch, pageNum = 1) {
    if (!cid && (bvidMatch || aidMatch)) {
      try {
        const pagelistUrl = bvidMatch 
          ? `https://api.bilibili.com/x/player/pagelist?bvid=${bvidMatch[0]}`
          : `https://api.bilibili.com/x/player/pagelist?aid=${aidMatch[1]}`;
        const listRes = await axios.get(pagelistUrl, { headers, timeout: 10000 });
        if (listRes.data && listRes.data.code === 0 && Array.isArray(listRes.data.data) && listRes.data.data.length > 0) {
          const targetEntry = pageNum ? (listRes.data.data.find(e => e.page === pageNum) || listRes.data.data[0]) : listRes.data.data[0];
          cid = targetEntry.cid;
        }
      } catch (e) {}
    }

    const endpoints = [];
    if (bvidMatch) {
      if (cid) {
        endpoints.push(`https://api.bilibili.com/x/v2/dm/view?bvid=${bvidMatch[0]}&cid=${cid}&oid=${cid}&type=1`);
        endpoints.push(`https://api.bilibili.com/x/player/v2?bvid=${bvidMatch[0]}&cid=${cid}`);
        endpoints.push(`https://api.bilibili.com/x/player/wbi/v2?bvid=${bvidMatch[0]}&cid=${cid}`);
      }
      endpoints.push(`https://api.bilibili.com/x/web-interface/view?bvid=${bvidMatch[0]}`);
    } else if (aidMatch) {
      if (cid) {
        endpoints.push(`https://api.bilibili.com/x/v2/dm/view?aid=${aidMatch[1]}&cid=${cid}&oid=${cid}&type=1`);
        endpoints.push(`https://api.bilibili.com/x/player/v2?aid=${aidMatch[1]}&cid=${cid}`);
        endpoints.push(`https://api.bilibili.com/x/player/wbi/v2?aid=${aidMatch[1]}&cid=${cid}`);
      }
      endpoints.push(`https://api.bilibili.com/x/web-interface/view?aid=${aidMatch[1]}`);
    }

    const mergedTracks = [];
    const seenByLan = new Map();

    for (const subtitleApi of endpoints) {
      try {
        const res = await axios.get(subtitleApi, { headers, timeout: 15000 });
        const tracks = this.extractBilibiliSubtitleTracks(res?.data);
        for (const track of tracks) {
          if (!track || typeof track !== 'object') continue;
          const subUrl = track.subtitle_url || track.url || '';
          const lan = String(track.lan || '').toLowerCase();
          const lanDoc = String(track.lan_doc || '');
          const isMachine = track.is_machine || (lan.includes('ai') || lanDoc.includes('自动') ? 1 : 0);
          const trackKey = `${lan}_${isMachine}`;

          if (seenByLan.has(trackKey)) {
            const existing = seenByLan.get(trackKey);
            if ((!existing.subtitle_url && !existing.url) && subUrl) {
              const idx = mergedTracks.indexOf(existing);
              if (idx !== -1) mergedTracks[idx] = track;
              seenByLan.set(trackKey, track);
            }
            continue;
          }

          seenByLan.set(trackKey, track);
          mergedTracks.push(track);
        }
      } catch (e) {
        // Try next endpoint
      }
    }

    return mergedTracks;
  }

  normalizeBilibiliSubtitleUrl(subtitleUrl) {
    if (!subtitleUrl || typeof subtitleUrl !== 'string') return null;
    if (subtitleUrl.startsWith('//')) return `https:${subtitleUrl}`;
    if (subtitleUrl.startsWith('/')) return `https://www.bilibili.com${subtitleUrl}`;
    return subtitleUrl;
  }

  async downloadBilibiliSubtitles(item, headers, cid, outputPath, bvidMatch, aidMatch, pageNum, settings = {}) {
    try {
      const targetDir = path.dirname(outputPath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const targetUrl = (item && (item.downloadUrl || item.url)) || '';
      if (!bvidMatch) bvidMatch = targetUrl.match(/BV[0-9a-zA-Z]+/i);
      if (!aidMatch) aidMatch = targetUrl.match(/av([0-9]+)/i);

      if (!pageNum) {
        const pageMatch = targetUrl.match(/[?&]p=([0-9]+)/i);
        if (pageMatch) {
          pageNum = parseInt(pageMatch[1], 10);
        } else if (item && item.page) {
          pageNum = item.page;
        } else {
          pageNum = 1;
        }
      }

      if (!cid && item && item.cid) {
        cid = item.cid;
      }

      const subtitleList = await this.fetchBilibiliSubtitleTracks(headers, cid, bvidMatch, aidMatch, pageNum);
      if (!Array.isArray(subtitleList) || subtitleList.length === 0) return [];

      const baseName = path.parse(outputPath).name;
      const defaultSrtFile = outputPath.toLowerCase().endsWith('.srt')
        ? outputPath
        : path.join(targetDir, `${baseName}.srt`);

      const priorityPref = String(settings?.subtitlePriority || settings?.subtitleLanguagePref || 'zh-en').toLowerCase();
      const scoreBiliTrack = (track) => {
        if (!track || typeof track !== 'object') return 9999;
        const lan = String(track.lan || '').toLowerCase();
        const lanDoc = String(track.lan_doc || '').toLowerCase();
        const isAi = this.isBilibiliAiSubtitleTrack(track);

        const isZh = /zh|chinese|chi|hans|hant|cmn|中文|简体|繁体|普通话|国语|ai-zh/.test(lan) ||
                     /zh|chinese|chi|hans|hant|cmn|中文|简体|繁体|普通话|国语|自动生成/.test(lanDoc);
        const isEn = (/en|english|eng|英文|英语/.test(lan) || /en|english|eng|英文|英语/.test(lanDoc)) && !isZh;

        if (priorityPref === 'en') {
          if (isEn && !isAi) return 10;
          if (isZh && !isAi) return 20;
          if (isEn && isAi) return 30;
          if (isZh && isAi) return 40;
          return 1000;
        } else if (priorityPref === 'zh-only') {
          if (isZh && !isAi) return 10;
          if (isZh && isAi) return 30;
          return 99999;
        } else if (priorityPref === 'en-only') {
          if (isEn && !isAi) return 10;
          if (isEn && isAi) return 30;
          return 99999;
        }
        // Default: 'zh-en' or 'zh' (Chinese or English, Chinese first)
        if (isZh && !isAi) return 10;
        if (isEn && !isAi) return 20;
        if (isZh && isAi) return 30;
        if (isEn && isAi) return 40;
        return 1000;
      };

      // Sort to prioritize selected language and manual subtitles over AI
      const sortedTracks = [...subtitleList].sort((a, b) => scoreBiliTrack(a) - scoreBiliTrack(b));

      // Filter by score, but if no tracks match strict filter, fallback to best available tracks
      let tracksToTry = sortedTracks.filter(track => scoreBiliTrack(track) < 90000);
      if (tracksToTry.length === 0 && sortedTracks.length > 0) {
        tracksToTry = sortedTracks;
      }

      for (let i = 0; i < tracksToTry.length; i++) {
        const track = tracksToTry[i];
        const subtitleUrl = this.normalizeBilibiliSubtitleUrl(track.subtitle_url || track.url);
        if (!subtitleUrl) continue;

        try {
          const subtitleRes = await axios.get(subtitleUrl, {
            headers: {
              'User-Agent': (headers && headers['User-Agent']) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
              'Referer': this.getBilibiliReferer(item)
            },
            timeout: 15000
          });

          let body = subtitleRes?.data?.body || subtitleRes?.data?.data?.body || subtitleRes?.data?.events || [];
          if (typeof subtitleRes.data === 'string') {
            try {
              const parsed = JSON.parse(subtitleRes.data);
              body = parsed.body || parsed.data?.body || parsed.events || [];
            } catch (e) {}
          }

          const srt = this.subtitleJsonToSrt(Array.isArray(body) ? body : []);
          if (srt && srt.trim().length > 0) {
            fs.writeFileSync(defaultSrtFile, srt, 'utf8');
            this.emitLog('info', `Saved 1 best Bilibili subtitle (${track.lan_doc || track.lan || 'zh'}): ${path.basename(defaultSrtFile)}`, {
              itemId: item.id,
              filePath: defaultSrtFile
            });
            return [defaultSrtFile]; // ONLY save 1 best subtitle file!
          }
        } catch (e) {
          this.emitLog('warn', `Failed to download Bilibili subtitle track: ${e.message}`, { itemId: item.id });
        }
      }

      return [];
    } catch (e) {
      this.emitLog('warn', `Bilibili subtitle download error: ${e.message}`, { itemId: item.id });
      return [];
    }
  }

  getBinPath(exeName) {
    const candidates = [
      process.resourcesPath ? path.join(process.resourcesPath, 'bin', exeName) : null,
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', exeName) : null,
      process.execPath ? path.join(path.dirname(process.execPath), 'resources', 'bin', exeName) : null,
      process.execPath ? path.join(path.dirname(process.execPath), 'bin', exeName) : null,
      path.join(__dirname, '..', 'bin', exeName),
      path.join(__dirname, 'bin', exeName),
      path.join(process.cwd(), 'bin', exeName),
      path.join(process.cwd(), exeName)
    ].filter(Boolean);
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return candidates[0] || exeName;
  }

  prepareCookieConfig(settings, item, targetDir) {
    const targetUrl = (item && (item.downloadUrl || item.url)) || '';
    const targetUrlLower = targetUrl.toLowerCase();
    const isYouTube = targetUrlLower.includes('youtube.com') || targetUrlLower.includes('youtu.be') || (item && item.platform === 'YouTube');
    const isBilibili = targetUrlLower.includes('bilibili') || targetUrlLower.includes('b23.tv') || targetUrlLower.includes('bibili') || (item && item.platform === 'BiliBili');
    const platformKey = isBilibili ? 'bilibili' : (isYouTube ? 'youtube' : 'generic');

    let rawCookies = (item && item.cookies) || (settings && (settings.cookies || settings.cookieFile)) || '';

    // If cookies were provided but belong to another platform, perform intelligent domain mapping
    if (typeof rawCookies === 'string' && rawCookies.trim()) {
      const rawLower = rawCookies.toLowerCase();
      if (isYouTube && (rawLower.includes('bilibili') || rawLower.includes('b23'))) {
        const possibleYtCookies = [
          path.join(process.cwd(), 'www.youtube.com_cookies.txt'),
          path.join(__dirname, '..', 'www.youtube.com_cookies.txt')
        ];
        const found = possibleYtCookies.find(p => fs.existsSync(p));
        rawCookies = found || '';
      } else if (isBilibili && rawLower.includes('youtube')) {
        const possibleBiliCookies = [
          path.join(process.cwd(), 'www.bilibili.com_cookies.txt'),
          path.join(__dirname, '..', 'www.bilibili.com_cookies.txt')
        ];
        const found = possibleBiliCookies.find(p => fs.existsSync(p));
        rawCookies = found || '';
      } else if (!isBilibili && !isYouTube && (rawLower.includes('bilibili') || rawLower.includes('youtube') || rawLower.includes('b23') || rawLower.includes('google'))) {
        rawCookies = '';
      }
    } else {
      if (isBilibili) {
        const possibleBiliCookies = [
          path.join(process.cwd(), 'www.bilibili.com_cookies.txt'),
          path.join(__dirname, '..', 'www.bilibili.com_cookies.txt')
        ];
        const found = possibleBiliCookies.find(p => fs.existsSync(p));
        if (found) rawCookies = found;
      } else if (isYouTube) {
        const possibleYtCookies = [
          path.join(process.cwd(), 'www.youtube.com_cookies.txt'),
          path.join(__dirname, '..', 'www.youtube.com_cookies.txt')
        ];
        const found = possibleYtCookies.find(p => fs.existsSync(p));
        if (found) rawCookies = found;
      }
    }

    if (!rawCookies || typeof rawCookies !== 'string') {
      return { cookieFile: null, cookieHeader: null };
    }
    const trimmed = rawCookies.trim();
    if (!trimmed) return { cookieFile: null, cookieHeader: null };

    // 1. Check if it's a file path to an existing cookies file on disk
    let resolvedPath = trimmed;
    if (!fs.existsSync(resolvedPath)) {
      const altPath = path.resolve(process.cwd(), trimmed);
      if (fs.existsSync(altPath)) resolvedPath = altPath;
      else {
        const altPath2 = path.resolve(__dirname, '..', trimmed);
        if (fs.existsSync(altPath2)) resolvedPath = altPath2;
      }
    }

    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      try {
        const stats = fs.statSync(resolvedPath);
        const cacheKey = `${resolvedPath}:${stats.mtimeMs}:${platformKey}`;
        if (COOKIE_PARSER_CACHE.has(cacheKey)) {
          return COOKIE_PARSER_CACHE.get(cacheKey);
        }

        const content = fs.readFileSync(resolvedPath, 'utf8');
        const cookiePairs = [];
        content.split('\n').forEach(line => {
          const l = line.trim();
          if (!l || l.startsWith('#')) return;
          const parts = l.split('\t');
          if (parts.length >= 7) {
            const domain = (parts[0] || '').toLowerCase();
            if (isBilibili && !domain.includes('bilibili.com')) return;
            if (isYouTube && !domain.includes('youtube.com') && !domain.includes('google.com')) return;
            cookiePairs.push(`${parts[5]}=${parts[6]}`);
          }
        });
        const headerStr = cookiePairs.length > 0 ? cookiePairs.join('; ') : null;
        const result = { cookieFile: resolvedPath, cookieHeader: headerStr };
        COOKIE_PARSER_CACHE.set(cacheKey, result);
        return result;
      } catch (e) {
        return { cookieFile: resolvedPath, cookieHeader: null };
      }
    }

    // 2. Check if it is a Netscape format string pasted directly
    if (trimmed.includes('\t') && (trimmed.includes('TRUE') || trimmed.includes('FALSE') || trimmed.startsWith('# Netscape'))) {
      try {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        const tempPath = path.join(targetDir, `.temp_cookies_${item.id || Date.now()}.txt`);
        fs.writeFileSync(tempPath, trimmed, 'utf8');
        const cookiePairs = [];
        trimmed.split('\n').forEach(line => {
          const l = line.trim();
          if (!l || l.startsWith('#')) return;
          const parts = l.split('\t');
          if (parts.length >= 7) {
            const domain = (parts[0] || '').toLowerCase();
            if (isBilibili && !domain.includes('bilibili.com')) return;
            if (isYouTube && !domain.includes('youtube.com') && !domain.includes('google.com')) return;
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

  sanitizeFilename(name, fallbackId = 'video') {
    if (!name) return fallbackId;
    // Preserve Unicode (including Chinese and other Asian scripts). Only
    // remove characters that Windows actually rejects in a filename.
    let cleaned = String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim();
    // Windows also rejects trailing spaces and dots.
    cleaned = cleaned.replace(/[. ]+$/, '');
    return cleaned.length > 0 ? cleaned : fallbackId;
  }

  getVideoFilenameFallback(item) {
    const source = String(item?.downloadUrl || item?.url || '');
    const bvid = source.match(/\bBV[0-9A-Za-z]+\b/i);
    if (bvid) return bvid[0];

    try {
      const parsed = new URL(source);
      const youtubeId = parsed.searchParams.get('v');
      if (youtubeId) return youtubeId;
      const lastSegment = parsed.pathname.split('/').filter(Boolean).pop();
      if (lastSegment && !/^(watch|video|shorts|embed)$/i.test(lastSegment)) {
        return this.sanitizeFilename(decodeURIComponent(lastSegment), 'video');
      }
    } catch (error) {}

    return String(item?.id || 'video');
  }

  cleanMovieTitle(item) {
    const fallbackId = this.getVideoFilenameFallback(item);
    let raw = (item?.title || item?.movieName || '').trim();
    if (!raw || raw.toLowerCase().startsWith('media stream') || raw.toLowerCase() === 'video') {
      raw = `${item?.platform || 'Video'}_${fallbackId}`;
    }
    return this.sanitizeFilename(raw, fallbackId).substring(0, 150);
  }

  getJsRuntimeArg() {
    const exeName = 'node.exe';
    const candidates = [
      process.resourcesPath ? path.join(process.resourcesPath, 'bin', exeName) : null,
      process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', exeName) : null,
      process.execPath ? path.join(path.dirname(process.execPath), 'resources', 'bin', exeName) : null,
      process.execPath ? path.join(path.dirname(process.execPath), 'bin', exeName) : null,
      path.join(__dirname, '..', 'bin', exeName),
      path.join(__dirname, 'bin', exeName),
      path.join(process.cwd(), 'bin', exeName),
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe'
    ].filter(Boolean);

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return ['--js-runtimes', `node:${c}`];
      }
    }
    return ['--js-runtimes', 'node'];
  }

  getPreferredSubtitleLanguages(settings = {}, item = {}) {
    const configured = [
      item.subtitleLanguage,
      item.subtitleLang,
      item.preferredSubtitleLanguage,
      settings.subtitleLanguage,
      settings.subtitleLang,
      settings.preferredSubtitleLanguage,
      settings.subtitle?.language,
      settings.languagePreference
    ].find(value => typeof value === 'string' && value.trim());

    if (configured) {
      const cleanList = configured
        .split(/[\s,;|]+/)
        .map(lang => lang.trim().replace(/\.\*/g, ''))
        .filter(Boolean);
      return [...new Set(cleanList)].join(',');
    }

    const pref = String(settings.subtitlePriority || settings.subtitleLanguagePref || 'zh-en').toLowerCase();
    if (pref === 'en' || pref === 'en-first') {
      return 'en,en-US,en-GB,en-orig,en-en,zh-Hans,zh-Hant,zh-CN,zh-TW,zh-HK,zh,cmn,ai-zh';
    }
    if (pref === 'zh-only') {
      return 'zh-Hans,zh-Hant,zh-CN,zh-TW,zh-HK,zh,cmn,zh-Hans-zh-Hans,zh-Hant-zh-Hant,ai-zh';
    }
    if (pref === 'en-only') {
      return 'en,en-US,en-GB,en-orig,en-en';
    }
    if (pref === 'all') {
      return 'zh-Hans,zh-Hant,zh,en,en-US,en-orig,ja,ko,es,fr,de,ru,vi,th,id,ar,ai-zh';
    }
    // Default: 'zh-en' (Chinese or English, prioritizing Chinese then English)
    return 'zh-Hans,zh-Hant,zh-CN,zh-TW,zh-HK,zh,cmn,zh-Hans-zh-Hans,zh-Hant-zh-Hant,ai-zh,en,en-US,en-GB,en-orig,en-en';
  }

  convertVttToSrt(vttContent) {
    if (!vttContent || typeof vttContent !== 'string') return '';
    const lines = vttContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let srtEntries = [];
    let counter = 1;
    let currentCueLines = [];
    let currentTiming = '';

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line || line.startsWith('WEBVTT') || line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) {
        continue;
      }
      const timestampMatch = line.match(/^(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{1,2}:)?(\d{2}):(\d{2})\.(\d{3})/);
      if (timestampMatch) {
        if (currentTiming && currentCueLines.length > 0) {
          srtEntries.push(`${counter++}\n${currentTiming}\n${currentCueLines.join('\n')}`);
          currentCueLines = [];
        }
        let parts = line.split('-->').map(p => p.trim());
        let start = parts[0].split(' ')[0];
        let end = parts[1].split(' ')[0];
        const formatTime = (t) => {
          let [main, ms] = t.split('.');
          let segments = main.split(':');
          if (segments.length === 2) segments.unshift('00');
          if (segments[0].length === 1) segments[0] = '0' + segments[0];
          return `${segments.join(':')},${ms || '000'}`;
        };
        currentTiming = `${formatTime(start)} --> ${formatTime(end)}`;
      } else if (currentTiming) {
        const cleanLine = line.replace(/<\/?[^>]+(>|$)/g, '').trim();
        if (cleanLine) {
          currentCueLines.push(cleanLine);
        }
      }
    }
    if (currentTiming && currentCueLines.length > 0) {
      srtEntries.push(`${counter++}\n${currentTiming}\n${currentCueLines.join('\n')}`);
    }
    return srtEntries.length > 0 ? srtEntries.join('\n\n') + '\n' : '';
  }

  normalizeYtDlpSubtitleOutput(targetDir, baseFilenameWithoutExt, preferredLanguages, settings = {}, tempSubDir = null) {
    const subtitleExtensions = new Set(['.srt', '.vtt', '.ass', '.lrc', '.ttml', '.srv1', '.srv2', '.srv3']);

    // Normalize string for fuzzy matching (strip punctuation, colons, emojis, spaces)
    const normalizeString = (s) => String(s || '').toLowerCase()
      .replace(/[：:_\-\s\u2011\u2013\u2014#]+/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '');

    const targetNorm = normalizeString(baseFilenameWithoutExt);

    // Collect all candidate subtitle files from tempSubDir and/or targetDir
    const candidateFiles = [];
    const scanDir = (dirPath, isTemp) => {
      if (!dirPath || !fs.existsSync(dirPath)) return;
      try {
        const files = fs.readdirSync(dirPath);
        for (const filename of files) {
          const ext = path.extname(filename).toLowerCase();
          if (!subtitleExtensions.has(ext)) continue;

          let isMatch = false;
          if (filename.startsWith(baseFilenameWithoutExt)) {
            isMatch = true;
          } else {
            const nameWithoutExt = path.parse(filename).name;
            const fileNorm = normalizeString(nameWithoutExt);
            if (targetNorm && fileNorm.includes(targetNorm)) isMatch = true;
            else if (targetNorm && targetNorm.includes(fileNorm) && fileNorm.length > 5) isMatch = true;
          }

          if (isMatch) {
            candidateFiles.push({
              fullPath: path.join(dirPath, filename),
              filename,
              isTemp,
              dirPath
            });
          }
        }
      } catch (e) {}
    };

    if (tempSubDir) scanDir(tempSubDir, true);
    scanDir(targetDir, false);

    const defaultSrtPath = path.join(targetDir, `${baseFilenameWithoutExt}.srt`);

    if (candidateFiles.length === 0) {
      if (tempSubDir && fs.existsSync(tempSubDir)) {
        try { fs.rmSync(tempSubDir, { recursive: true, force: true }); } catch (e) {}
      }
      return fs.existsSync(defaultSrtPath) ? defaultSrtPath : null;
    }

    const pref = String(settings.subtitlePriority || settings.subtitleLanguagePref || 'zh-en').toLowerCase();

    // Helper: identify the actual target language of a subtitle code
    const detectTrackLanguage = (filename) => {
      const nameWithoutExt = path.parse(filename).name;
      let langTag = '';
      if (nameWithoutExt.startsWith(baseFilenameWithoutExt)) {
        langTag = nameWithoutExt.substring(baseFilenameWithoutExt.length).replace(/^[._\-]+/, '').trim().toLowerCase();
      } else {
        const m = nameWithoutExt.match(/[._\-]([a-zA-Z0-9_\-]+)$/);
        if (m) langTag = m[1].toLowerCase();
      }

      if (!langTag) return 'zh-en';

      // Check if it's an auto-translated code like zh-Hans-ar or en-vi (format: source-target)
      const parts = langTag.split('-');
      let targetLang = langTag;
      if (parts.length >= 2) {
        const lastPart = parts[parts.length - 1];
        if (['ar', 'vi', 'ja', 'ko', 'fil', 'ms', 'es', 'fr', 'de', 'ru', 'th', 'id', 'bn', 'pt', 'it', 'hi', 'tr'].includes(lastPart)) {
          targetLang = lastPart;
        } else if (['hans', 'hant', 'cn', 'tw', 'hk', 'zh'].includes(lastPart)) {
          targetLang = 'zh';
        } else if (['en', 'us', 'gb', 'orig'].includes(lastPart)) {
          targetLang = 'en';
        }
      }

      if (/^(zh|chinese|chi|zho|cmn|hans|hant|中文|简体|繁体)/i.test(targetLang)) return 'zh';
      if (/^(en|english|eng|英文|英语)/i.test(targetLang)) return 'en';
      return targetLang || 'other';
    };

    const isAutoTrack = (filename) => {
      const lower = filename.toLowerCase();
      if (/(?:auto|automatic|generated|orig)/i.test(lower)) return true;
      const nameWithoutExt = path.parse(filename).name;
      let langTag = '';
      if (nameWithoutExt.startsWith(baseFilenameWithoutExt)) {
        langTag = nameWithoutExt.substring(baseFilenameWithoutExt.length).replace(/^[._\-]+/, '').trim().toLowerCase();
      }
      const parts = langTag.split('-');
      if (parts.length >= 2 && !['hans', 'hant', 'cn', 'tw', 'hk', 'us', 'gb'].includes(parts[parts.length - 1])) {
        return true;
      }
      return false;
    };

    const score = (cand) => {
      const filename = cand.filename;
      const ext = path.extname(filename).toLowerCase();
      const isSrt = ext === '.srt';
      const lang = detectTrackLanguage(filename);
      const isAuto = isAutoTrack(filename);

      let s = 1000;
      if (pref === 'zh-only') {
        if (lang !== 'zh') return 99999;
        s = isAuto ? 30 : 0;
      } else if (pref === 'en-only') {
        if (lang !== 'en') return 99999;
        s = isAuto ? 30 : 0;
      } else if (pref === 'en' || pref === 'en-first') {
        if (lang === 'en' && !isAuto) s = 0;
        else if (lang === 'zh' && !isAuto) s = 10;
        else if (lang === 'en' && isAuto) s = 20;
        else if (lang === 'zh' && isAuto) s = 30;
        else s = 500;
      } else {
        // Default: zh-en (Chinese preferred, then English)
        if (lang === 'zh' && !isAuto) s = 0;
        else if (lang === 'en' && !isAuto) s = 10;
        else if (lang === 'zh' && isAuto) s = 20;
        else if (lang === 'en' && isAuto) s = 30;
        else s = 500;
      }

      // Minor tie-breakers: .srt preferred over .vtt
      if (!isSrt) s += 2;
      // Pure target code (e.g. .zh.srt) preferred over translation tracks
      if (filename.includes('-')) s += 1;
      return s;
    };

    candidateFiles.sort((a, b) => score(a) - score(b));
    const winner = candidateFiles[0];

    try {
      if (score(winner) < 90000) {
        if (path.extname(winner.fullPath).toLowerCase() === '.vtt') {
          const vttContent = fs.readFileSync(winner.fullPath, 'utf8');
          const srtContent = this.convertVttToSrt(vttContent);
          if (srtContent && srtContent.trim()) {
            fs.writeFileSync(defaultSrtPath, srtContent, 'utf8');
          } else {
            fs.copyFileSync(winner.fullPath, defaultSrtPath);
          }
        } else if (winner.fullPath !== defaultSrtPath) {
          if (fs.existsSync(defaultSrtPath)) {
            try { fs.unlinkSync(defaultSrtPath); } catch (e) {}
          }
          fs.copyFileSync(winner.fullPath, defaultSrtPath);
        }
      }

      // Clean up ALL auxiliary subtitle files so that ONLY 1 best subtitle file exists for this video
      for (const cand of candidateFiles) {
        if (cand.fullPath !== defaultSrtPath && fs.existsSync(cand.fullPath)) {
          try { fs.unlinkSync(cand.fullPath); } catch (e) {}
        }
      }

      // Also clean up any other auxiliary subtitles in targetDir starting with baseFilenameWithoutExt
      if (fs.existsSync(targetDir)) {
        const remainingFiles = fs.readdirSync(targetDir);
        remainingFiles.forEach(f => {
          const fExt = path.extname(f).toLowerCase();
          if (subtitleExtensions.has(fExt)) {
            const fPath = path.join(targetDir, f);
            if (fPath !== defaultSrtPath && f.startsWith(baseFilenameWithoutExt)) {
              try { fs.unlinkSync(fPath); } catch (e) {}
            }
          }
        });
      }

      // Remove temp directory if created
      if (tempSubDir && fs.existsSync(tempSubDir)) {
        try { fs.rmSync(tempSubDir, { recursive: true, force: true }); } catch (e) {}
      }

      return fs.existsSync(defaultSrtPath) ? defaultSrtPath : null;
    } catch (error) {
      if (tempSubDir && fs.existsSync(tempSubDir)) {
        try { fs.rmSync(tempSubDir, { recursive: true, force: true }); } catch (e) {}
      }
      this.emitLog('warn', `Could not normalize subtitle output: ${error.message}`, { targetDir, baseFilenameWithoutExt });
      return fs.existsSync(defaultSrtPath) ? defaultSrtPath : (winner ? winner.fullPath : null);
    }
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

  isIntermediateDownloadFile(filename) {
    if (!filename) return false;
    return filename.endsWith('.part') || filename.endsWith('.ytdl') || filename.endsWith('.temp') ||
      /\.f\d+(\.|$)/i.test(filename) || filename.includes('.temp_cookies_');
  }

  resolveExistingOutputPath(targetDir, baseFilenameWithoutExt, preferredFilePath = null, capturedFilePath = null) {
    const possibleExtensions = ['.mp4', '.flv', '.mkv', '.webm', '.m4a', '.mp3', '.mov'];
    if (preferredFilePath) {
      possibleExtensions.push(path.extname(preferredFilePath));
    }
    if (capturedFilePath) {
      possibleExtensions.push(path.extname(capturedFilePath));
    }

    const checkCandidate = (candidatePath) => {
      try {
        if (candidatePath && fs.existsSync(candidatePath) && !this.isIntermediateDownloadFile(path.basename(candidatePath))) {
          const stats = fs.statSync(candidatePath);
          if (stats.size > 200 * 1024) {
            return candidatePath;
          }
        }
      } catch (e) {}
      return null;
    };

    if (capturedFilePath) {
      const hit = checkCandidate(capturedFilePath);
      if (hit) return hit;
    }

    const directHit = checkCandidate(preferredFilePath);
    if (directHit) return directHit;

    for (const ext of possibleExtensions) {
      if (!ext) continue;
      const candidatePath = path.join(targetDir, `${baseFilenameWithoutExt}${ext}`);
      const hit = checkCandidate(candidatePath);
      if (hit) return hit;
    }

    try {
      if (fs.existsSync(targetDir)) {
        const files = fs.readdirSync(targetDir);
        const found = files.find(f =>
          f.startsWith(baseFilenameWithoutExt) &&
          !this.isIntermediateDownloadFile(f) &&
          possibleExtensions.some(ext => ext && f.toLowerCase().endsWith(ext.toLowerCase()))
        );
        if (found) {
          const candidatePath = path.join(targetDir, found);
          return checkCandidate(candidatePath);
        }
      }
    } catch (e) {}

    return null;
  }

  async validateMediaFile(filePath, minBytes = 100 * 1024) {
    if (!filePath || !fs.existsSync(filePath)) return false;
    try {
      const stats = fs.statSync(filePath);
      if (stats.size < minBytes) return false;

      const ffmpegExe = this.getBinPath('ffmpeg.exe');
      if (!fs.existsSync(ffmpegExe)) {
        return stats.size > 500 * 1024;
      }

      const { spawn } = require('child_process');
      return await new Promise((resolve) => {
        // Fast trailer & packet integrity verification using FFmpeg
        const proc = spawn(ffmpegExe, [
          '-v', 'error',
          '-xerror',
          '-sseof', '-10',
          '-i', filePath,
          '-f', 'null',
          '-'
        ]);

        let stderr = '';
        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch (e) {}
          resolve(stats.size > 500 * 1024);
        }, 8000);

        proc.stderr?.on('data', (d) => {
          stderr += d.toString();
        });

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0 && !stderr.trim()) {
            resolve(true);
          } else {
            const isCorrupt = /(?:Invalid data found|moov atom not found|corrupt|Invalid OBU|EBADF|Header missing|Truncated|contradictionary)/i.test(stderr);
            if (isCorrupt) {
              resolve(false);
            } else {
              // Quick probe check for duration and streams (handles very short files <10s)
              const probeProc = spawn(ffmpegExe, ['-i', filePath]);
              let probeErr = '';
              const probeTimer = setTimeout(() => {
                try { probeProc.kill('SIGKILL'); } catch (e) {}
                resolve(stats.size > 500 * 1024);
              }, 5000);
              probeProc.stderr?.on('data', (pd) => probeErr += pd.toString());
              probeProc.on('close', () => {
                clearTimeout(probeTimer);
                const hasDuration = /Duration:\s*(\d+):(\d+):(\d+)/i.test(probeErr);
                const hasStream = /Stream #.*(?:Video|Audio):/i.test(probeErr);
                const hasFatalAtom = /(?:moov atom not found|Invalid data found)/i.test(probeErr);
                resolve(hasDuration && hasStream && !hasFatalAtom);
              });
              probeProc.on('error', () => {
                clearTimeout(probeTimer);
                resolve(stats.size > 500 * 1024);
              });
            }
          }
        });

        proc.on('error', () => {
          clearTimeout(timer);
          resolve(stats.size > 500 * 1024);
        });
      });
    } catch (e) {
      return false;
    }
  }

  buildDownloadPaths(item, settings) {
    const targetDir = this.getTargetDir(item, settings);
    const baseFilenameWithoutExt = this.cleanMovieTitle(item);
    const ext = item.type && item.type.includes('mp3') ? '.mp3' : '.mp4';
    const filePath = path.join(targetDir, `${baseFilenameWithoutExt}${ext}`);
    return { targetDir, baseFilenameWithoutExt, filePath, ext };
  }

  async convertImageToJpg(srcPath, destPath) {
    return new Promise((resolve) => {
      const ffmpegExe = this.getBinPath('ffmpeg.exe');
      if (!fs.existsSync(ffmpegExe)) return resolve(false);
      const { spawn } = require('child_process');
      const proc = spawn(ffmpegExe, ['-y', '-i', srcPath, '-q:v', '2', destPath]);
      proc.on('close', (code) => {
        resolve(code === 0 && fs.existsSync(destPath) && fs.statSync(destPath).size > 500);
      });
      proc.on('error', () => resolve(false));
    });
  }

  async downloadThumbnail(item, targetDir, baseFilenameWithoutExt, settings = {}) {
    if (settings.downloadThumbnails === false) return null;

    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      const expectedJpg = path.join(targetDir, `${baseFilenameWithoutExt}.jpg`);
      const expectedPng = path.join(targetDir, `${baseFilenameWithoutExt}.png`);
      const expectedWebp = path.join(targetDir, `${baseFilenameWithoutExt}.webp`);

      // 1. Direct match check
      if (fs.existsSync(expectedJpg) && fs.statSync(expectedJpg).size > 500) {
        this.emitLog('info', `Thumbnail verified: ${path.basename(expectedJpg)}`, { itemId: item.id });
        return expectedJpg;
      }
      if (fs.existsSync(expectedWebp) && fs.statSync(expectedWebp).size > 500) {
        const converted = await this.convertImageToJpg(expectedWebp, expectedJpg);
        if (converted) {
          try { fs.unlinkSync(expectedWebp); } catch (e) {}
          this.emitLog('info', `Converted thumbnail to JPG: ${path.basename(expectedJpg)}`, { itemId: item.id });
          return expectedJpg;
        }
        return expectedWebp;
      }
      if (fs.existsSync(expectedPng) && fs.statSync(expectedPng).size > 500) {
        return expectedPng;
      }

      // 2. Fuzzy match any image file written by yt-dlp in targetDir
      if (fs.existsSync(targetDir)) {
        const files = fs.readdirSync(targetDir);
        const imgExts = ['.jpg', '.jpeg', '.png', '.webp'];
        const found = files.find(f => {
          const ext = path.extname(f).toLowerCase();
          return imgExts.includes(ext) && (f.startsWith(baseFilenameWithoutExt) || f.includes(baseFilenameWithoutExt));
        });
        if (found) {
          const fullPath = path.join(targetDir, found);
          if (fs.statSync(fullPath).size > 500) {
            const ext = path.extname(found).toLowerCase();
            if (ext === '.webp') {
              const converted = await this.convertImageToJpg(fullPath, expectedJpg);
              if (converted) {
                try { fs.unlinkSync(fullPath); } catch (e) {}
                this.emitLog('info', `Normalized thumbnail: ${path.basename(expectedJpg)}`, { itemId: item.id });
                return expectedJpg;
              }
            }
            if (fullPath !== expectedJpg) {
              fs.copyFileSync(fullPath, expectedJpg);
            }
            this.emitLog('info', `Found existing thumbnail: ${path.basename(expectedJpg)}`, { itemId: item.id });
            return expectedJpg;
          }
        }
      }

      // 3. Obtain thumbnail URL from item or scrape metadata
      let thumbUrl = item.thumbnail || item.pic || item.cover || '';
      const targetUrl = item.downloadUrl || item.url || '';
      const targetUrlLower = targetUrl.toLowerCase();
      const isBili = item.platform === 'BiliBili' || targetUrlLower.includes('bilibili') || targetUrlLower.includes('b23.tv');
      const isYt = item.platform === 'YouTube' || targetUrlLower.includes('youtube.com') || targetUrlLower.includes('youtu.be');

      if (!thumbUrl && isYt) {
        const yId = (targetUrl.match(/(?:watch\?v=|embed\/|shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/i) || [])[1];
        if (yId) thumbUrl = `https://img.youtube.com/vi/${yId}/maxresdefault.jpg`;
      }

      if (!thumbUrl && isBili) {
        const bvidMatch = targetUrl.match(/BV[0-9a-zA-Z]+/i);
        const aidMatch = targetUrl.match(/av([0-9]+)/i);
        if (bvidMatch || aidMatch) {
          try {
            const apiUrl = bvidMatch 
              ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvidMatch[0]}`
              : `https://api.bilibili.com/x/web-interface/view?aid=${aidMatch[1]}`;
            const apiRes = await axios.get(apiUrl, {
              headers: {
                'User-Agent': this.getModernUserAgent(settings, item),
                'Referer': this.getBilibiliReferer(item)
              },
              timeout: 8000
            });
            if (apiRes?.data?.data?.pic) {
              thumbUrl = apiRes.data.data.pic;
            }
          } catch (e) {}
        }
      }

      if (!thumbUrl) return null;

      if (thumbUrl.startsWith('//')) {
        thumbUrl = `https:${thumbUrl}`;
      }

      const headers = {
        'User-Agent': this.getModernUserAgent(settings, item),
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      };
      if (isBili) {
        headers['Referer'] = this.getBilibiliReferer(item);
      } else if (isYt) {
        headers['Referer'] = 'https://www.youtube.com/';
      }

      // Download thumbnail with YouTube maxres -> hq fallback
      let imgRes = null;
      try {
        imgRes = await axios.get(thumbUrl, {
          responseType: 'arraybuffer',
          headers,
          timeout: 15000
        });
      } catch (err) {
        if (isYt && thumbUrl.includes('maxresdefault.jpg')) {
          const fallbackUrl = thumbUrl.replace('maxresdefault.jpg', 'hqdefault.jpg');
          try {
            imgRes = await axios.get(fallbackUrl, {
              responseType: 'arraybuffer',
              headers,
              timeout: 15000
            });
          } catch (e) {}
        }
      }

      if (imgRes && imgRes.data && imgRes.data.length > 500) {
        const contentType = String(imgRes.headers['content-type'] || '').toLowerCase();
        const isWebp = contentType.includes('webp') || thumbUrl.toLowerCase().includes('.webp') ||
                       (imgRes.data.length > 12 && imgRes.data.toString('utf8', 8, 12) === 'WEBP');

        if (isWebp) {
          fs.writeFileSync(expectedWebp, Buffer.from(imgRes.data));
          const converted = await this.convertImageToJpg(expectedWebp, expectedJpg);
          if (converted) {
            try { fs.unlinkSync(expectedWebp); } catch (e) {}
            this.emitLog('info', `Downloaded & converted thumbnail: ${path.basename(expectedJpg)}`, { itemId: item.id });
            return expectedJpg;
          }
          return expectedWebp;
        }

        fs.writeFileSync(expectedJpg, Buffer.from(imgRes.data));
        this.emitLog('info', `Downloaded thumbnail: ${path.basename(expectedJpg)}`, { itemId: item.id });
        return expectedJpg;
      }
    } catch (err) {
      this.emitLog('warn', `Failed to download thumbnail for item ${item.id}: ${err.message}`, { itemId: item.id });
    }
    return null;
  }

  async finalizeCompletedItem(item, filePath, settings, status = 'Completed') {
    this.completedCount++;
    this.runningCount--;
    this.activeControllers.delete(item.id);
    this.speedMetrics.delete(item.id);
    item.filePath = filePath;

    if (settings && settings.downloadThumbnails !== false) {
      try {
        const targetDir = path.dirname(filePath);
        const baseFilenameWithoutExt = path.parse(filePath).name;
        const thumbPath = await this.downloadThumbnail(item, targetDir, baseFilenameWithoutExt, settings);
        if (thumbPath) {
          item.thumbnailFile = thumbPath;
        }
      } catch (e) {
        this.emitLog('warn', `Thumbnail capture error: ${e.message}`, { itemId: item.id });
      }
    }

    // Final integrity check: ensure ONLY 1 subtitle file exists for this video (video1 + thumbnail1 + subtital1)
    if (settings && settings.downloadSubtitles !== false && fs.existsSync(filePath)) {
      try {
        const targetDir = path.dirname(filePath);
        const baseFilenameWithoutExt = path.parse(filePath).name;
        const defaultSrt = path.join(targetDir, `${baseFilenameWithoutExt}.srt`);
        const subtitleExtensions = new Set(['.srt', '.vtt', '.ass', '.lrc', '.ttml', '.srv1', '.srv2', '.srv3']);
        const dirFiles = fs.readdirSync(targetDir);
        dirFiles.forEach(f => {
          const ext = path.extname(f).toLowerCase();
          if (subtitleExtensions.has(ext) && f.startsWith(baseFilenameWithoutExt) && path.join(targetDir, f) !== defaultSrt) {
            try { fs.unlinkSync(path.join(targetDir, f)); } catch (e) {}
          }
        });
      } catch (e) {}
    }

    this.emitLog('info', `Completed item ${item.id}: ${path.basename(filePath)}`, {
      itemId: item.id,
      filePath,
      status
    });
    this.emit('item-progress', {
      id: item.id,
      status,
      percentage: 100,
      downloadedMB: fs.existsSync(filePath) ? (fs.statSync(filePath).size / (1024 * 1024)).toFixed(2) : '0.00',
      speedMbps: '0.00',
      filePath,
      thumbnailPath: item.thumbnailFile || null
    });
    this.processNextInQueue(settings);
  }

  async ensureSubtitlesDownloaded(item, targetDir, baseFilenameWithoutExt, settings) {
    if (settings.downloadSubtitles === false) return null;

    const defaultSrtPath = path.join(targetDir, `${baseFilenameWithoutExt}.srt`);
    if (fs.existsSync(defaultSrtPath) && fs.statSync(defaultSrtPath).size > 100) {
      item.subtitleFiles = [defaultSrtPath];
      this.emitLog('info', `Subtitle already present: ${path.basename(defaultSrtPath)}`, {
        itemId: item.id,
        filePath: defaultSrtPath
      });
      return defaultSrtPath;
    }

    this.emit('item-progress', {
      id: item.id,
      status: 'Downloading Subtitle...',
      percentage: 1,
      downloadedMB: '0.00',
      speedMbps: '0.00'
    });
    this.emitLog('info', `Downloading subtitle first for item ${item.id}: ${baseFilenameWithoutExt}`, {
      itemId: item.id
    });

    try {
      const subPath = await this.downloadSubtitleOnly(item, settings);
      if (subPath && fs.existsSync(subPath) && fs.statSync(subPath).size > 0) {
        item.subtitleFiles = [subPath];
        this.emitLog('info', `Saved 1 primary subtitle first: ${path.basename(subPath)}`, {
          itemId: item.id,
          filePath: subPath
        });
        return subPath;
      }
    } catch (e) {
      this.emitLog('warn', `Subtitle pre-download error for item ${item.id}: ${e.message}`, { itemId: item.id });
    }
    return null;
  }

  async downloadSubtitleOnly(item, settings) {
    const targetDir = this.getTargetDir(item, settings);
    const baseFilenameWithoutExt = this.cleanMovieTitle(item);
    const subtitlePath = path.join(targetDir, `${baseFilenameWithoutExt}.srt`);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const targetUrl = item.downloadUrl || item.url || '';
    const lowerUrl = targetUrl.toLowerCase();
    const isBilibili = lowerUrl.includes('bilibili') || lowerUrl.includes('b23.tv') || lowerUrl.includes('bibili') || item.platform === 'BiliBili';

    if (isBilibili) {
      const bvidMatch = targetUrl.match(/BV[0-9a-zA-Z]+/i);
      const aidMatch = targetUrl.match(/av([0-9]+)/i);
      const pageMatch = targetUrl.match(/[?&]p=([0-9]+)/i);
      const pageNum = pageMatch ? parseInt(pageMatch[1], 10) : (item && item.page ? item.page : 1);
      const cid = item && item.cid ? item.cid : null;
      const { cookieHeader } = this.prepareCookieConfig(settings, item, targetDir);
      const files = await this.downloadBilibiliSubtitles(item, {
        'User-Agent': this.getModernUserAgent(settings, item),
        'Referer': this.getBilibiliReferer(item),
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {})
      }, cid, subtitlePath, bvidMatch, aidMatch, pageNum, settings);
      return files && files.length > 0 ? files[0] : null;
    }

    const { spawn } = require('child_process');
    const preferred = this.getPreferredSubtitleLanguages(settings, item);
    const { cookieFile } = this.prepareCookieConfig(settings, item, targetDir);
    const tempSubDir = path.join(targetDir, `.temp_subs_${item.id || 'sub'}_${Date.now()}`);
    try {
      if (!fs.existsSync(tempSubDir)) fs.mkdirSync(tempSubDir, { recursive: true });
    } catch (e) {}

    const args = [
      '--newline',
      '--no-playlist',
      '--no-warnings',
      '--ignore-errors',
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-format', 'srt/vtt/best',
      '--sub-langs', preferred,
      '--convert-subs', 'srt',
      '--windows-filenames',
      '-P', `subtitle:${tempSubDir}`,
      '-o', path.join(tempSubDir, `${baseFilenameWithoutExt}.%(ext)s`)
    ];
    if (cookieFile && fs.existsSync(cookieFile)) args.push('--cookies', cookieFile);
    args.push(targetUrl);

    return new Promise((resolve) => {
      const proc = spawn(this.getBinPath('yt-dlp.exe'), args);
      let output = '';
      proc.stdout?.on('data', data => { output += data.toString(); });
      proc.stderr?.on('data', data => { output += data.toString(); });
      proc.on('error', error => {
        if (tempSubDir && fs.existsSync(tempSubDir)) {
          try { fs.rmSync(tempSubDir, { recursive: true, force: true }); } catch (e) {}
        }
        this.emitLog('error', `Subtitle-only download failed: ${error.message}`, { itemId: item.id });
        resolve(null);
      });
      proc.on('close', code => {
        const normalized = this.normalizeYtDlpSubtitleOutput(targetDir, baseFilenameWithoutExt, preferred, settings, tempSubDir);
        if (normalized && fs.existsSync(normalized)) {
          this.emitLog('info', `Saved 1 subtitle-only file: ${path.basename(normalized)}`, { itemId: item.id, filePath: normalized });
          resolve(normalized);
        } else {
          this.emitLog('error', `Subtitle-only download produced no subtitle (yt-dlp exit ${code})`, { itemId: item.id, output: output.slice(-1000) });
          resolve(null);
        }
      });
    });
  }

  startQueue(items, settings) {
    this.cancelAll(); // Clean up any previous runs
    this.isCancelled = false;
    // Keep item concurrency conservative to avoid throttling and server-side rejection.
    this.concurrencyLimit = Math.min(4, Math.max(1, parseInt(settings.itemConcurrency || 2, 10)));
    this.activeQueue = [...items];
    this.totalCount = items.length;
    this.completedCount = 0;
    this.runningCount = 0;
    this.speedMetrics.clear();
    this.emitLog(
      'info',
      `Queue started: ${items.length} item(s), concurrency ${this.concurrencyLimit}, mode ${String(settings?.bilibiliMode || 'balanced')}`,
      { totalItems: items.length, concurrency: this.concurrencyLimit, mode: settings?.bilibiliMode || 'balanced' }
    );

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
      const isYouTube = targetUrlLower.includes('youtube.com') || targetUrlLower.includes('youtu.be') || item.platform === 'YouTube';
      const isDashOrHls = isYouTube || isBilibili || /\.(?:mpd|m3u8)(?:[?#]|$)/i.test(targetUrlLower) || /(?:dash|hls)/i.test(String(item.format || item.protocol || ''));
      const preferredSubtitleLanguages = this.getPreferredSubtitleLanguages(settings, item);

      let capturedFilePath = null;
      const args = [
        '--newline',
        '--no-playlist',
        '--no-warnings',
        '--abort-on-unavailable-fragment',
        '--no-check-certificates',
        '--windows-filenames',
        '--socket-timeout', '30',
        '--throttled-rate', '100K',
        ...this.getJsRuntimeArg()
      ];

      // Subtitle options: prioritize Chinese or English with temporary staging (guaranteeing 1 subtitle file)
      const shouldDownloadSubs = settings.downloadSubtitles !== false;
      const tempSubDir = path.join(targetDir, `.temp_subs_${item.id || 'dl'}_${Date.now()}`);
      if (shouldDownloadSubs) {
        const subLangs = this.getPreferredSubtitleLanguages(settings, item);
        try {
          if (!fs.existsSync(tempSubDir)) fs.mkdirSync(tempSubDir, { recursive: true });
        } catch (e) {}

        args.push(
          '--write-subs',
          '--write-auto-subs',
          '--sub-format', 'srt/vtt/best',
          '--sub-langs', subLangs,
          '--convert-subs', 'srt',
          '-P', `subtitle:${tempSubDir}`
        );
      }

      // Thumbnail options: download thumbnail image alongside video
      if (settings.downloadThumbnails !== false) {
        args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
      }

      // 1. ROTATE USER-AGENT / IMPERSONATION
      // DO NOT override user-agent for TikTok, YouTube, Instagram, Twitter, etc.
      // Overriding user agent breaks curl_cffi TLS impersonation, triggering immediate anti-bot blocks!
      if (isBilibili) {
        args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36');
      } else {
        args.push('--impersonate', 'chrome');
      }

      // 2. COOKIE & AUTHENTICATION INJECTION (Domain-Safe)
      if (isBilibili && cookieFile && fs.existsSync(cookieFile)) {
        args.push('--cookies', cookieFile);
      } else if (isYouTube && cookieFile && fs.existsSync(cookieFile)) {
        args.push('--cookies', cookieFile);
      } else if (cookieFile && fs.existsSync(cookieFile)) {
        const cfLower = cookieFile.toLowerCase();
        if (!cfLower.includes('bilibili') && !cfLower.includes('youtube')) {
          args.push('--cookies', cookieFile);
        }
      } else if (cookieHeader && isBilibili) {
        args.push('--add-header', `Cookie: ${cookieHeader}`);
      }

      // 3. REFERER HEADER & EXTRACTOR ARGS
      let usesExternalDownloader = false;
      if (isBilibili) {
        args.push('--add-header', `Referer: ${this.getBilibiliReferer(item)}`);
        args.push('--extractor-args', 'bilibili:player_client=tv,app,web');
      }

      const ytDlpExe = this.getBinPath('yt-dlp.exe');
      const ffmpegExe = this.getBinPath('ffmpeg.exe');
      const aria2cExe = this.getBinPath('aria2c.exe');

      if (isBilibili) {
        const biliMode = String(settings.bilibiliMode || 'balanced').toLowerCase();
        // High-reliability native yt-dlp downloader for Bilibili streams (never use aria2c on Bilibili DASH)
        const fallbackProfiles = {
          stable: { fragments: '3', buffer: '4M', retries: '25' },
          balanced: { fragments: '4', buffer: '4M', retries: '25' },
          fast: { fragments: '6', buffer: '8M', retries: '20' }
        };
        const fallback = fallbackProfiles[biliMode] || fallbackProfiles.balanced;
        this.emitLog('info', `yt-dlp Bilibili fallback configured: mode=${biliMode}`, {
          itemId: item.id,
          mode: biliMode,
          fragments: fallback.fragments
        });
        args.push('--downloader', 'dash,m3u8:native');
        args.push('--concurrent-fragments', fallback.fragments);
        args.push('--buffer-size', fallback.buffer);
        args.push('--file-access-retries', fallback.retries);
        args.push('--retries', fallback.retries);
        args.push('--fragment-retries', fallback.retries);
      } else if (isYouTube) {
        // Resilient native yt-dlp downloader with tuned fragments and no forced chunking (prevents throttling & corruption)
        const numFrags = String(Math.min(8, Math.max(2, parseInt(settings.threads || 6, 10))));
        args.push('--downloader', 'dash,m3u8:native');
        args.push('--concurrent-fragments', numFrags);
        args.push('--buffer-size', '16M');
        args.push('--file-access-retries', '25');
        args.push('--retries', '25');
        args.push('--fragment-retries', '25');
        args.push('--extractor-args', 'youtube:player_client=android,web,default');
        this.emitLog('info', `Using resilient native yt-dlp downloader (${numFrags} fragments, 16M buffer) for YouTube item ${item.id}`, { itemId: item.id });
      } else if (isDashOrHls) {
        // High-speed fragments for generic DASH / HLS streams
        const numFrags = String(Math.min(8, Math.max(2, parseInt(settings.threads || 8, 10))));
        args.push('--downloader', 'dash,m3u8:native');
        args.push('--concurrent-fragments', numFrags);
        args.push('--buffer-size', '8M');
        args.push('--file-access-retries', '25');
        args.push('--retries', '25');
        args.push('--fragment-retries', '25');
        this.emitLog('info', `Using accelerated native yt-dlp downloader (${numFrags} fragments) for DASH/HLS item ${item.id}`, { itemId: item.id });
      } else {
        // Tuned 8–16 connections and 2M min-split for direct static HTTP files via aria2c
        const numThreads = Math.min(16, Math.max(4, parseInt(settings.threads || 10, 10)));
        args.push('--downloader', aria2cExe);
        args.push('--downloader-args', `aria2c:-c -x ${numThreads} -s ${numThreads} -j 4 -k 2M --min-split-size=2M --max-connection-per-server=${numThreads} --timeout=30 --retry-wait=2`);
        usesExternalDownloader = true;
        args.push('--concurrent-fragments', String(numThreads));
        args.push('--buffer-size', '8M');
        args.push('--file-access-retries', '20');
        args.push('--retries', '20');
        args.push('--fragment-retries', '20');
        this.emitLog('info', `Using aria2c accelerator (${numThreads} connections, 2M split) for item ${item.id}`, { itemId: item.id });
      }

      // 5. MERGE SEPARATE VIDEO & AUDIO STREAMS (FFMPEG)
      const isMp3 = (item.type && item.type.toLowerCase().includes('mp3')) ||
                    String(settings.fileType || '').toLowerCase().includes('mp3') ||
                    String(settings.fileFormat || '').toLowerCase().includes('mp3');

      if (isMp3) {
        args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
      } else {
        const mergeFormat = String(settings.fileFormat || 'mp4').toLowerCase() === 'mkv' ? 'mkv' : 'mp4';
        const qualitySetting = String(settings.fileType || settings.videoQuality || '').toLowerCase();
        
        let formatFilter = '';
        if (qualitySetting.includes('1080') || qualitySetting === '1080p') {
          formatFilter = isBilibili 
            ? 'bv*[height<=1080][vcodec^=avc]+ba/bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b/best'
            : 'bestvideo[height<=1080][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
        } else if (qualitySetting.includes('720') || qualitySetting === '720p') {
          formatFilter = isBilibili
            ? 'bv*[height<=720][vcodec^=avc]+ba/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b/best'
            : 'bestvideo[height<=720][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best';
        } else if (qualitySetting.includes('480') || qualitySetting === '480p') {
          formatFilter = isBilibili
            ? 'bv*[height<=480][vcodec^=avc]+ba/bv*[height<=480]+ba/b[height<=480]/bv*+ba/b/best'
            : 'bestvideo[height<=480][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best';
        } else if (qualitySetting.includes('1440') || qualitySetting === '1440p' || qualitySetting.includes('2k')) {
          formatFilter = isBilibili
            ? 'bv*[height<=1440][vcodec^=avc]+ba/bv*[height<=1440]+ba/b[height<=1440]/bv*+ba/b/best'
            : 'bestvideo[height<=1440][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height<=1440][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1440]+bestaudio/best';
        } else if (qualitySetting.includes('2160') || qualitySetting.includes('4k')) {
          formatFilter = isBilibili
            ? 'bv*[height<=2160][vcodec^=avc]+ba/bv*[height<=2160]+ba/b[height<=2160]/bv*+ba/b/best'
            : 'bestvideo[height<=2160][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best';
        } else {
          // Highest Available (Original / 4K / 1080p / 8K)
          formatFilter = isBilibili
            ? 'bv*[vcodec^=avc]+ba/bv*+ba/b/best'
            : 'bestvideo[vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/b/best';
        }

        args.push('-f', formatFilter);
        args.push('--merge-output-format', mergeFormat);
        const muxingPostArgs = mergeFormat === 'mp4'
          ? 'Merger:-movflags +faststart -max_muxing_queue_size 9999 -avoid_negative_ts make_zero -fflags +genpts'
          : 'Merger:-max_muxing_queue_size 9999 -avoid_negative_ts make_zero -fflags +genpts';
        args.push('--postprocessor-args', muxingPostArgs);
      }

      const outputTemplate = path.join(targetDir, `${baseFilenameWithoutExt}.%(ext)s`);
      args.push('-o', outputTemplate);
      args.push(targetUrl);

      args.push('--ffmpeg-location', ffmpegExe);

      const proc = spawn(ytDlpExe, args);
      this.emitLog('info', `yt-dlp launched for item ${item.id}`, {
        itemId: item.id,
        filePath,
        isBilibili
      });

      // Capture exact stderr output for diagnosis
      let stderrLog = '';
      if (proc.stderr) {
        proc.stderr.on('data', (errData) => {
          if (this.isCancelled) return;
          const text = errData.toString();
          stderrLog += text;
          for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
            this.emitLog('warn', `[yt-dlp] ${line}`, { itemId: item.id, stream: 'stderr' });
          }
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
          const destMatch = line.match(/\[download\] Destination:\s+(.+)$/i) ||
                            line.match(/\[Merger\] Merging formats into "(.+)"/i) ||
                            line.match(/\[download\]\s+(.+?)\s+has already been downloaded/i);
          if (destMatch && destMatch[1]) {
            const potential = destMatch[1].trim();
            if (!potential.endsWith('.part') && !potential.endsWith('.ytdl')) {
              capturedFilePath = potential;
            }
          }

          if (line.includes('[Merger]') || line.includes('Merging formats into')) {
            this.emit('item-progress', {
              id: item.id,
              status: 'Merging Video & Audio (FFmpeg)...',
              percentage: 99,
              downloadedMB: item.sizeMB || '0.00',
              speedMbps: '0.00',
              filePath
            });
            continue;
          }

          const fragMatch = line.match(/\(frag\s+(\d+)\/(\d+)\)/i);
          const ytMatch = line.match(/\[download\]\s+([\d\.]+)%\s+of\s+~?([\d\.]+)([KMG]i?B)\s+(?:at\s+([\d\.]+)([KMG]i?B\/s))?/i);
          const ariaMatch = line.match(/\[#\w+\s+([\d\.]+)[KMG]i?B\/([\d\.]+)([KMG]i?B)\(([\d\.]+)%\).*?DL:([\d\.]+)([KMG]i?B)/i);

          if (fragMatch || ytMatch || ariaMatch) {
            let percentage, downloadedMB, val, unit;

            if (fragMatch) {
              const curFrag = parseInt(fragMatch[1], 10);
              const totFrag = parseInt(fragMatch[2], 10);
              percentage = totFrag > 0 ? Math.min(99, Math.round((curFrag / totFrag) * 100)) : 0;
              const totalEstMB = parseFloat(item.sizeMB || '0') || 100;
              downloadedMB = ((percentage / 100) * totalEstMB).toFixed(2);
              if (ytMatch) {
                val = ytMatch[4];
                unit = ytMatch[5] ? ytMatch[5].toUpperCase() : null;
              }
            } else if (ytMatch) {
              const matchedPct = parseFloat(ytMatch[1]);
              const sizeVal = parseFloat(ytMatch[2]);
              const sizeUnit = ytMatch[3] ? ytMatch[3].toUpperCase() : '';

              // Skip reporting 100% on small subtitle files as main video progress
              if (sizeUnit.includes('K') && sizeVal < 500 && matchedPct >= 99) {
                continue;
              }

              percentage = Math.min(99, Math.round(matchedPct));
              let totalEstMB = parseFloat(item.sizeMB || '0');
              if (ytMatch[2] && ytMatch[3]) {
                if (sizeUnit.includes('M')) totalEstMB = sizeVal;
                else if (sizeUnit.includes('G')) totalEstMB = sizeVal * 1024;
                else if (sizeUnit.includes('K')) totalEstMB = sizeVal / 1024;
              }
              downloadedMB = ((percentage / 100) * (totalEstMB || 100)).toFixed(2);
              val = ytMatch[4];
              unit = ytMatch[5] ? ytMatch[5].toUpperCase() : null;
            } else {
              percentage = Math.min(99, Math.round(parseFloat(ariaMatch[4])));
              downloadedMB = ariaMatch[1];
              val = ariaMatch[5];
              unit = ariaMatch[6] ? ariaMatch[6].toUpperCase() + '/S' : null;
            }

            if (item.status !== 'downloading' && percentage === 100) return;
            item.status = 'downloading';

            let speedMbps = '0.00';
            if (val && unit) {
              const speedVal = parseFloat(val);
              let bytesPerSec = speedVal;
              if (unit.includes('M')) bytesPerSec = speedVal * 1024 * 1024;
              else if (unit.includes('G')) bytesPerSec = speedVal * 1024 * 1024 * 1024;
              else if (unit.includes('K')) bytesPerSec = speedVal * 1024;
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
            this.emitLog('warn', `yt-dlp spawn error, trying direct Bilibili path for item ${item.id}`, {
              itemId: item.id,
              error: err.message
            });
            this.emit('item-progress', { id: item.id, status: 'Downloading Parallel Direct...', percentage: 1, downloadedMB: '0.10' });
            const directSuccess = await this.downloadBilibiliDirectly(item, filePath, settings);
            if (directSuccess && fs.existsSync(filePath)) {
              if (!isDone) {
                isDone = true;
                await this.finalizeCompletedItem(item, filePath, settings);
                resolve();
              }
              return;
            }
          }
          isDone = true;
          this.runningCount--;
          const errMsg = `Error: ${err.message || 'yt-dlp spawn failed'}`;
          this.emitLog('error', `yt-dlp spawn failed for item ${item.id}`, {
            itemId: item.id,
            error: err.message || 'yt-dlp spawn failed'
          });
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
          if (tempSubDir && fs.existsSync(tempSubDir)) {
            try { fs.rmSync(tempSubDir, { recursive: true, force: true }); } catch (e) {}
          }
          try {
            if (fs.existsSync(targetDir)) {
              const files = fs.readdirSync(targetDir);
              files.forEach(f => {
                if (f.startsWith(baseFilenameWithoutExt) && this.isIntermediateDownloadFile(f)) {
                  try { fs.unlinkSync(path.join(targetDir, f)); } catch (e) {}
                }
              });
            }
          } catch (e) {}
          if (!isDone) {
            isDone = true;
            this.runningCount--;
            this.emit('item-progress', { id: item.id, status: 'Cancelled', percentage: 0, downloadedMB: '0.00' });
            this.emitLog('warn', `yt-dlp cancelled for item ${item.id}`, { itemId: item.id, exitCode: code });
            resolve();
          }
          return;
        }

        // An explicitly configured external downloader is optional. If it
        // exits non-zero (most notably aria2c returning 403/"No output"),
        // retry the same yt-dlp job with the native downloader before
        // reporting failure.
        if (usesExternalDownloader && code !== 0 && !this.resolveExistingOutputPath(targetDir, baseFilenameWithoutExt, filePath)) {
          this.emitLog('warn', `External downloader exited ${code}; retrying item ${item.id} with native yt-dlp`, {
            itemId: item.id,
            exitCode: code
          });
          const nativeArgs = [];
          for (let i = 0; i < args.length; i++) {
            if (args[i] === '--downloader' || args[i] === '--downloader-args') {
              i++;
              continue;
            }
            if (args[i] === '--concurrent-fragments') {
              nativeArgs.push(args[i], '4');
              i++;
              continue;
            }
            nativeArgs.push(args[i]);
          }
          const downloaderIndex = nativeArgs.indexOf('--downloader');
          if (downloaderIndex === -1) nativeArgs.splice(nativeArgs.indexOf('--ffmpeg-location'), 0, '--downloader', 'dash,m3u8:native');
          await new Promise((retryResolve) => {
            const retryProc = spawn(ytDlpExe, nativeArgs);
            retryProc.stderr?.on('data', (d) => {
              const text = d.toString();
              stderrLog += text;
              for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
                this.emitLog('warn', `[yt-dlp native retry] ${line}`, { itemId: item.id, stream: 'stderr' });
              }
            });
            retryProc.on('error', () => retryResolve());
            retryProc.on('close', (retryCode) => {
              this.emitLog(retryCode === 0 ? 'info' : 'warn', `Native yt-dlp retry exited ${retryCode}`, { itemId: item.id, exitCode: retryCode });
              retryResolve();
            });
          });
        }

        // YouTube playback URLs are bound to the request context. A stale
        // browser cookie export can make an otherwise valid public URL return
        // 403, so retry once without cookies while forcing IPv4. Keep the
        // first cookie-backed attempt for private/authenticated videos.
        if (isYouTube && code !== 0 && /(?:403|forbidden)/i.test(stderrLog)) {
          const recoveryArgs = [];
          for (let i = 0; i < args.length; i++) {
            if (args[i] === '--cookies') {
              i++;
              continue;
            }
            if (args[i] === '--add-header' && /^cookie\s*:/i.test(String(args[i + 1] || ''))) {
              i++;
              continue;
            }
            recoveryArgs.push(args[i]);
          }
          if (!recoveryArgs.includes('--force-ipv4')) recoveryArgs.push('--force-ipv4');
          this.emitLog('warn', `YouTube returned 403; retrying item ${item.id} without cookies over IPv4`, { itemId: item.id });
          await new Promise((retryResolve) => {
            const recoveryProc = spawn(ytDlpExe, recoveryArgs);
            recoveryProc.stderr?.on('data', (d) => {
              const text = d.toString();
              stderrLog += text;
              for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
                this.emitLog('warn', `[yt-dlp YouTube recovery] ${line}`, { itemId: item.id, stream: 'stderr' });
              }
            });
            recoveryProc.on('error', () => retryResolve());
            recoveryProc.on('close', (recoveryCode) => {
              this.emitLog(recoveryCode === 0 ? 'info' : 'warn', `YouTube recovery exited ${recoveryCode}`, { itemId: item.id, exitCode: recoveryCode });
              retryResolve();
            });
          });
        }

        let actualFilePath = this.resolveExistingOutputPath(targetDir, baseFilenameWithoutExt, filePath, capturedFilePath);

        // If actual file is present, clean up any leftover .part or intermediate fragments
        if (actualFilePath && fs.existsSync(actualFilePath)) {
          try {
            if (fs.existsSync(targetDir)) {
              const files = fs.readdirSync(targetDir);
              files.forEach(f => {
                if (f.startsWith(baseFilenameWithoutExt) && this.isIntermediateDownloadFile(f)) {
                  try { fs.unlinkSync(path.join(targetDir, f)); } catch (e) {}
                }
              });
            }
          } catch (e) {}
        } else if (fs.existsSync(targetDir)) {
          // If actual file is not yet found, wait briefly in case ffmpeg muxing is finalizing
          let attempts = 0;
          while (attempts < 6) {
            await new Promise(r => setTimeout(r, 1000));
            actualFilePath = this.resolveExistingOutputPath(targetDir, baseFilenameWithoutExt, filePath, capturedFilePath);
            if (actualFilePath) {
              try {
                const files = fs.readdirSync(targetDir);
                files.forEach(f => {
                  if (f.startsWith(baseFilenameWithoutExt) && this.isIntermediateDownloadFile(f)) {
                    try { fs.unlinkSync(path.join(targetDir, f)); } catch (e) {}
                  }
                });
              } catch (e) {}
              break;
            }
            attempts++;
          }
        }

        let isFileValid = false;
        if (actualFilePath) {
          isFileValid = await this.validateMediaFile(actualFilePath);
        }

        // If code !== 0 or file is corrupt/incomplete, DO NOT finalize as completed!
        if (actualFilePath && (!isFileValid || code !== 0)) {
          this.emitLog('warn', `yt-dlp produced an invalid or incomplete video file (${path.basename(actualFilePath)}, exitCode=${code}, valid=${isFileValid}). Removing broken file to protect user playback.`, {
            itemId: item.id,
            exitCode: code,
            filePath: actualFilePath
          });
          try { fs.unlinkSync(actualFilePath); } catch (e) {}
          actualFilePath = null;
        }

        if (actualFilePath && isFileValid && code === 0) {
          if (!isDone) {
            isDone = true;
            this.emitLog('info', `yt-dlp completed and verified for item ${item.id}`, {
              itemId: item.id,
              exitCode: code,
              filePath: actualFilePath
            });
            // Normalize subtitles for all downloaded items (GUARANTEE: ONLY 1 best subtitle file!)
            if (shouldDownloadSubs) {
              const subtitlePath = this.normalizeYtDlpSubtitleOutput(targetDir, baseFilenameWithoutExt, preferredSubtitleLanguages, settings, tempSubDir);
              if (subtitlePath) {
                this.emitLog('info', `Saved 1 primary subtitle: ${path.basename(subtitlePath)}`, {
                  itemId: item.id,
                  filePath: subtitlePath
                });
              }
            } else if (tempSubDir && fs.existsSync(tempSubDir)) {
              try { fs.rmSync(tempSubDir, { recursive: true, force: true }); } catch (e) {}
            }

            // If Bilibili, also attempt direct subtitle fetch to capture AI subtitles
            if (isBilibili && settings.downloadSubtitles !== false) {
              try {
                const targetUrl = item.downloadUrl || item.url || '';
                const bvidMatch = targetUrl.match(/BV[0-9a-zA-Z]+/i);
                const aidMatch = targetUrl.match(/av([0-9]+)/i);
                const pageMatch = targetUrl.match(/[?&]p=([0-9]+)/i);
                const pageNum = pageMatch ? parseInt(pageMatch[1], 10) : (item && item.page ? item.page : 1);
                const cid = item && item.cid ? item.cid : null;
                const subFiles = await this.downloadBilibiliSubtitles(item, {
                  'User-Agent': userAgent,
                  'Referer': this.getBilibiliReferer(item)
                }, cid, actualFilePath, bvidMatch, aidMatch, pageNum, settings);
                if (subFiles && subFiles.length > 0) {
                  item.subtitleFiles = subFiles;
                }
              } catch (e) {}
            }
            await this.finalizeCompletedItem(item, actualFilePath, settings);
            resolve();
          }
        } else {
          if (tempSubDir && fs.existsSync(tempSubDir)) {
            try { fs.rmSync(tempSubDir, { recursive: true, force: true }); } catch (e) {}
          }
          if (isBilibili && !this.isCancelled) {
            this.emitLog('warn', `yt-dlp close path falling back to direct Bilibili download for item ${item.id}`, {
              itemId: item.id,
              exitCode: code
            });
            this.emit('item-progress', { id: item.id, status: 'Downloading Parallel Direct...', percentage: 1, downloadedMB: '0.10' });
            const directSuccess = await this.downloadBilibiliDirectly(item, filePath, settings);
            if (directSuccess && fs.existsSync(filePath)) {
              if (!isDone) {
                isDone = true;
                await this.finalizeCompletedItem(item, filePath, settings);
                resolve();
              }
              return;
            }
          }
          if (!isDone) {
            isDone = true;
            this.runningCount--;
            this.emitLog('error', `yt-dlp finished without output for item ${item.id}`, {
              itemId: item.id,
              exitCode: code
            });
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

  async downloadBilibiliDASH(item, filePath, settings, options = {}) {
    const finalize = options.finalize !== false;
    const targetUrl = item.downloadUrl || item.url || '';
    const targetDir = path.dirname(filePath);
    const { cookieHeader } = this.prepareCookieConfig(settings, item, targetDir);
    const userAgent = this.getModernUserAgent(settings, item);
    const itemClock = Date.now();
    const logPhase = (level, message, extra = {}) => {
      this.emitLog(level, message, {
        itemId: item.id,
        elapsedMs: Date.now() - itemClock,
        ...extra
      });
    };

    const headers = {
      'User-Agent': userAgent,
      'Referer': this.getBilibiliReferer(item),
      'Origin': 'https://www.bilibili.com',
      'Accept-Encoding': 'identity',
      'Connection': 'keep-alive'
    };
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    const controller = new AbortController();
    this.activeControllers.set(item.id, controller);

    try {
      logPhase('info', `Starting Bilibili DASH download: ${path.basename(filePath)}`);
      this.emit('item-progress', { id: item.id, status: 'Fetching DASH manifest...', percentage: 1, downloadedMB: '0.00', speedMbps: '0.00' });

      let bvidMatch = targetUrl.match(/BV[0-9a-zA-Z]+/i);
      let aidMatch = targetUrl.match(/av([0-9]+)/i);
      const pageMatch = targetUrl.match(/[?&]p=([0-9]+)/i);
      const pageNum = pageMatch ? parseInt(pageMatch[1], 10) : 1;

      if (!bvidMatch && !aidMatch) throw new Error("Invalid Bilibili URL");

      const pagelistUrl = bvidMatch 
        ? `https://api.bilibili.com/x/player/pagelist?bvid=${bvidMatch[0]}`
        : `https://api.bilibili.com/x/player/pagelist?aid=${aidMatch[1]}`;

      const pagelistStart = Date.now();
      const listRes = await axios.get(pagelistUrl, { headers, timeout: 15000 });
      if (!listRes.data || listRes.data.code !== 0 || !listRes.data.data) {
        throw new Error("Failed to get pagelist: " + (listRes.data ? listRes.data.message : ''));
      }
      const pageEntry = listRes.data.data.find(e => e.page === pageNum) || listRes.data.data[0];
      const cid = pageEntry.cid;
      logPhase('info', `Pagelist ready in ${Date.now() - pagelistStart}ms (cid=${cid}, page=${pageNum})`);

      let cachedDash = null;
      let dashFetchPromise = null;
      let lastDashFetchTime = 0;
      const getDashUrls = async (forceRefresh = false) => {
        if (dashFetchPromise) return dashFetchPromise;
        const now = Date.now();
        if (cachedDash && (!forceRefresh || (now - lastDashFetchTime < 25000))) {
          return cachedDash;
        }

        dashFetchPromise = (async () => {
          try {
            const playUrl = bvidMatch
              ? `https://api.bilibili.com/x/player/playurl?bvid=${bvidMatch[0]}&cid=${cid}&qn=127&fnval=4048&fourk=1`
              : `https://api.bilibili.com/x/player/playurl?aid=${aidMatch[1]}&cid=${cid}&qn=127&fnval=4048&fourk=1`;
            const dashStart = Date.now();
            const playRes = await axios.get(playUrl, {
              headers,
              timeout: 15000,
              httpAgent: HTTP_AGENT,
              httpsAgent: HTTPS_AGENT
            });
            if (!playRes.data || playRes.data.code !== 0 || !playRes.data.data || !playRes.data.data.dash) {
              throw new Error("Failed to get DASH manifest: " + (playRes.data ? playRes.data.message : ''));
            }
            cachedDash = playRes.data.data.dash;
            lastDashFetchTime = Date.now();
            logPhase('info', `DASH manifest loaded in ${Date.now() - dashStart}ms`);
            return cachedDash;
          } finally {
            dashFetchPromise = null;
          }
        })();
        return dashFetchPromise;
      };

      const getBestVideoTrack = (dash) => {
        if (!dash || !Array.isArray(dash.video) || dash.video.length === 0) return null;
        const sorted = [...dash.video].sort((a, b) => (b.id || 0) - (a.id || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
        // Prioritize AVC / H.264 (avc1) first: 100% universal compatibility for playback, video editors, and YouTube upload
        return sorted.find(v => v.codecs && v.codecs.startsWith('avc'))
            || sorted.find(v => v.codecs && (v.codecs.startsWith('hvc') || v.codecs.startsWith('hev')))
            || sorted.find(v => v.codecs && v.codecs.startsWith('av01'))
            || sorted[0];
      };

      const getBestAudioTrack = (dash) => {
        if (!dash || !Array.isArray(dash.audio) || dash.audio.length === 0) return null;
        const sorted = [...dash.audio].sort((a, b) => (b.id || 0) - (a.id || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
        return sorted[0];
      };

      const dashInfo = await getDashUrls(true);
      const videoInfo = getBestVideoTrack(dashInfo);
      const audioInfo = getBestAudioTrack(dashInfo);

      // Lock selected track ID and codecs to guarantee stream consistency across URL/token renewals on long videos
      const lockedVideoId = videoInfo ? videoInfo.id : null;
      const lockedVideoCodecs = videoInfo ? videoInfo.codecs : null;
      const lockedAudioId = audioInfo ? audioInfo.id : null;

      const videoTemp = filePath + '.video.m4s';
      const audioTemp = filePath + '.audio.m4s';

      let totalBytes = 0;
      let downloadedBytes = 0;

      const downloadStream = async (type, getUrlFn, tempPath) => {
        const streamStartedAt = Date.now();
        let currentUrl = await getUrlFn(false, 0);
        let streamTotalBytes = 0;
        logPhase('info', `${type} stream URL resolved`);

        try {
          const headRes = await axios({
            method: 'HEAD',
            url: currentUrl,
            timeout: 15000,
            headers,
            signal: controller.signal,
            httpAgent: HTTP_AGENT,
            httpsAgent: HTTPS_AGENT
          });
          streamTotalBytes = parseInt(headRes.headers['content-length'], 10) || 0;
        } catch (e) {
          try {
            const probeRes = await axios({
              method: 'GET',
              url: currentUrl,
              timeout: 15000,
              headers: { ...headers, Range: 'bytes=0-0' },
              responseType: 'stream',
              signal: controller.signal,
              validateStatus: (status) => status === 200 || status === 206,
              httpAgent: HTTP_AGENT,
              httpsAgent: HTTPS_AGENT
            });
            const rangeHeader = probeRes.headers['content-range'];
            if (rangeHeader) {
              const match = rangeHeader.match(/\/(\d+)$/);
              if (match) streamTotalBytes = parseInt(match[1], 10) || 0;
            }
            if (!streamTotalBytes) {
              streamTotalBytes = parseInt(probeRes.headers['content-length'], 10) || 0;
            }
            if (probeRes.data && typeof probeRes.data.destroy === 'function') {
              probeRes.data.destroy();
            }
          } catch (probeErr) {
            throw new Error(`Failed to get stream info for ${type}`);
          }
        }
        
        totalBytes += streamTotalBytes;
        logPhase('info', `${type} stream size detected: ${(streamTotalBytes / (1024 * 1024)).toFixed(2)} MB`);

        let chunks = [];
        const stateFile = tempPath + '.state.json';
        if (fs.existsSync(stateFile) && fs.existsSync(tempPath)) {
          try {
            const savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            if (savedState.streamTotalBytes === streamTotalBytes && Array.isArray(savedState.chunks)) {
              chunks = savedState.chunks;
            }
          } catch(e) {}
        }

        let sharedFd = null;
        try {
          if (chunks.length > 0) {
            sharedFd = fs.openSync(tempPath, 'r+');
            const preDownloaded = chunks.reduce((acc, c) => acc + c.downloaded, 0);
            downloadedBytes += preDownloaded;
            logPhase('info', `Resuming ${type} stream from ${preDownloaded} bytes`);
          } else {
            sharedFd = fs.openSync(tempPath, 'w+');
            if (streamTotalBytes > 0) fs.ftruncateSync(sharedFd, streamTotalBytes);
          }
        } catch (e) {
          if (sharedFd !== null) fs.closeSync(sharedFd);
          throw e;
        }

        const tuning = this.getBilibiliDashTuning(streamTotalBytes, type, settings);
        if (chunks.length === 0) {
          logPhase('info', `${type} stream tuned for ${tuning.workerCount} worker(s), chunk ${(tuning.chunkBytes / (1024 * 1024)).toFixed(2)} MB`);
          const chunkSize = tuning.chunkBytes;
          for (let i = 0, startByte = 0; startByte < streamTotalBytes; i++, startByte += chunkSize) {
            if (startByte >= streamTotalBytes) break;
            const endByte = Math.min((i + 1) * chunkSize - 1, streamTotalBytes - 1);
            chunks.push({ startByte, endByte, downloaded: 0, inProgress: false });
          }
        }

        const stateInterval = setInterval(() => {
          if (!this.isCancelled && chunks.length > 0) {
             try { fs.writeFileSync(stateFile, JSON.stringify({ streamTotalBytes, chunks: chunks.map(c => ({ startByte: c.startByte, endByte: c.endByte, downloaded: c.downloaded })) }), 'utf8'); } catch(e){}
          }
        }, 2000);

        const poolSize = Math.max(1, Math.min(tuning.workerCount, chunks.length));
        const workerPromises = Array.from({ length: poolSize }).map(async (_, workerIndex) => {
          if (tuning.initialStaggerMs > 0) {
            await new Promise(r => setTimeout(r, workerIndex * tuning.initialStaggerMs));
          }

          while (true) {
            if (this.isCancelled) break;
            
            // Find next chunk that is pending
            const chunk = chunks.find(c => (c.startByte + c.downloaded) <= c.endByte && !c.inProgress);
            if (!chunk) {
              const hasUnfinished = chunks.some(c => (c.startByte + c.downloaded) <= c.endByte);
              if (hasUnfinished) {
                await new Promise(r => setTimeout(r, 500));
                continue;
              }
              break;
            }
            chunk.inProgress = true;

            let workerUrl = currentUrl;
            let failureCount = 0;

            while (true) {
              if (this.isCancelled) break;
              const currentStart = chunk.startByte + chunk.downloaded;
              if (currentStart > chunk.endByte) break;

              try {
                const chunkHeaders = { ...headers, 'Range': `bytes=${currentStart}-${chunk.endByte}` };
                const response = await axios({
                  method: 'GET',
                  url: workerUrl,
                  responseType: 'stream',
                  signal: controller.signal,
                  timeout: 15000,
                  headers: chunkHeaders,
                  httpAgent: HTTP_AGENT,
                  httpsAgent: HTTPS_AGENT
                });

                if (response.status === 200 && (currentStart > 0 || chunk.endByte < streamTotalBytes - 1)) {
                  throw new Error('Server returned full stream (200 OK) instead of partial range (206)');
                }

                await new Promise((resolveChunk, rejectChunk) => {
                  const stream = response.data;
                  let pendingBuffers = [];
                  let pendingBytes = 0;
                  let lastFlush = Date.now();
                  let stallTimer = null;

                  const resetStallTimer = () => {
                    if (stallTimer) clearTimeout(stallTimer);
                    stallTimer = setTimeout(() => {
                      if (stream && typeof stream.destroy === 'function') {
                        stream.destroy(new Error('Connection data stall (15s inactivity)'));
                      }
                    }, 15000);
                  };
                  resetStallTimer();

                  const flushPending = () => {
                    if (pendingBytes <= 0) return;
                    const writeOffset = chunk.startByte + chunk.downloaded;
                    const outBuffer = pendingBuffers.length === 1
                      ? pendingBuffers[0]
                      : Buffer.concat(pendingBuffers, pendingBytes);
                    fs.writeSync(sharedFd, outBuffer, 0, outBuffer.length, writeOffset);
                    chunk.downloaded += outBuffer.length;
                    downloadedBytes += outBuffer.length;
                    pendingBuffers = [];
                    pendingBytes = 0;
                    lastFlush = Date.now();
                  };

                  stream.on('data', (buffer) => {
                    resetStallTimer();
                    if (this.isCancelled) { stream.destroy(); return; }
                    try {
                      pendingBuffers.push(buffer);
                      pendingBytes += buffer.length;

                      const flushAge = Date.now() - lastFlush;
                      if (pendingBytes >= tuning.flushThresholdBytes || flushAge >= tuning.flushIntervalMs) {
                        flushPending();
                      } else if (pendingBytes >= tuning.maxBufferedBytes) {
                        stream.pause();
                        flushPending();
                        stream.resume();
                      }
                    } catch (e) {
                      if (stallTimer) clearTimeout(stallTimer);
                      stream.destroy();
                      rejectChunk(e);
                    }
                  });

                  stream.on('end', () => {
                    if (stallTimer) clearTimeout(stallTimer);
                    try {
                      flushPending();
                      const expectedTotal = chunk.endByte - chunk.startByte + 1;
                      if (chunk.downloaded < expectedTotal) {
                        rejectChunk(new Error(`Stream ended prematurely: ${chunk.downloaded}/${expectedTotal} bytes`));
                      } else {
                        resolveChunk();
                      }
                    } catch (e) {
                      rejectChunk(e);
                    }
                  });

                  stream.on('error', (err) => {
                    if (stallTimer) clearTimeout(stallTimer);
                    rejectChunk(err);
                  });
                });
                break; // Chunk succeeded!
              } catch (err) {
                if (axios.isCancel(err) || this.isCancelled) break;
                failureCount++;
                logPhase('warn', `${type} worker chunk [${chunk.startByte}-${chunk.endByte}] retry ${failureCount}/${tuning.maxChunkRetries}: ${err.message}`, {
                  workerIndex,
                  failureCount,
                  error: err.message
                });

                // Rotate mirror URL on any error
                try {
                  workerUrl = await getUrlFn(failureCount > 2, failureCount);
                } catch (e) {}

                if (failureCount > tuning.maxChunkRetries) {
                  logPhase('error', `${type} worker exceeded retry limit on chunk [${chunk.startByte}-${chunk.endByte}]`, {
                    workerIndex,
                    failureCount,
                    error: err.message
                  });
                  chunk.inProgress = false;
                  throw err;
                }

                const backoffMs = Math.min(6000, tuning.retryBackoffMs * Math.pow(1.4, Math.max(0, failureCount - 1)));
                const jitterMs = Math.floor(Math.random() * 200);
                await new Promise(r => setTimeout(r, backoffMs + jitterMs));
              }
            }
            chunk.inProgress = false;
          }
        });

        await Promise.all(workerPromises);
        clearInterval(stateInterval);
        
        if (!this.isCancelled) {
          try { fs.writeFileSync(stateFile, JSON.stringify({ streamTotalBytes, chunks: chunks.map(c => ({ startByte: c.startByte, endByte: c.endByte, downloaded: c.downloaded })) }), 'utf8'); } catch(e){}
          if (sharedFd !== null) { try { fs.closeSync(sharedFd); } catch(e){} }
          
          const totalExpected = chunks.reduce((acc, c) => acc + (c.endByte - c.startByte + 1), 0);
          const totalGot = chunks.reduce((acc, c) => acc + c.downloaded, 0);
          if (totalExpected === totalGot && fs.existsSync(stateFile)) {
             try { fs.unlinkSync(stateFile); } catch(e){}
          }
          if (streamTotalBytes > 0 && totalGot < totalExpected) {
            throw new Error(`${type} stream incomplete: received ${totalGot} of ${totalExpected} bytes`);
          }
        } else {
          if (sharedFd !== null) { try { fs.closeSync(sharedFd); } catch(e){} }
        }
        logPhase('info', `${type} stream finished in ${Date.now() - streamStartedAt}ms`);
      };

      let lastTime = Date.now();
      let lastDownloaded = 0;
      const progressTimer = setInterval(() => {
        if (this.isCancelled || totalBytes === 0) return;
        const now = Date.now();
        const timeDiff = (now - lastTime) / 1000;
        if (timeDiff >= 0.25) {
          const bytesDiff = downloadedBytes - lastDownloaded;
          const bytesPerSec = timeDiff > 0 ? (bytesDiff / timeDiff) : 0;
          this.speedMetrics.set(item.id, bytesPerSec);
          lastTime = now;
          lastDownloaded = downloadedBytes;

          const percentage = Math.min(99, Math.round((downloadedBytes / totalBytes) * 100));
          const mb = (downloadedBytes / (1024 * 1024)).toFixed(2);
          const speed = ((bytesPerSec * 8) / (1024 * 1024)).toFixed(2);
          
          this.emit('item-progress', {
            id: item.id, status: `Downloading DASH (${percentage}%)`, percentage, downloadedMB: mb, speedMbps: speed, filePath
          });
        }
      }, 250);

      const getVidUrl = async (force = false, mirrorIdx = 0) => { 
        await getDashUrls(force); 
        let vTrack = null;
        if (cachedDash && Array.isArray(cachedDash.video)) {
          if (lockedVideoId && lockedVideoCodecs) {
            vTrack = cachedDash.video.find(v => v.id === lockedVideoId && v.codecs === lockedVideoCodecs)
                  || cachedDash.video.find(v => v.id === lockedVideoId);
          }
          if (!vTrack) vTrack = getBestVideoTrack(cachedDash);
        }
        if (!vTrack) throw new Error("No video tracks found in manifest");
        const urls = [vTrack.baseUrl, ...(vTrack.backupUrl || []), ...(vTrack.backup_url || [])].filter(Boolean);
        return urls[mirrorIdx % urls.length] || vTrack.baseUrl; 
      };
      const getAudUrl = async (force = false, mirrorIdx = 0) => { 
        await getDashUrls(force); 
        let aTrack = null;
        if (cachedDash && Array.isArray(cachedDash.audio)) {
          if (lockedAudioId) {
            aTrack = cachedDash.audio.find(a => a.id === lockedAudioId);
          }
          if (!aTrack) aTrack = getBestAudioTrack(cachedDash);
        }
        if (!aTrack) return null;
        const urls = [aTrack.baseUrl, ...(aTrack.backupUrl || []), ...(aTrack.backup_url || [])].filter(Boolean);
        return urls[mirrorIdx % urls.length] || aTrack.baseUrl; 
      };

      logPhase('info', `Launching DASH workers${audioInfo ? ' for video and audio' : ' for video only'}`);
      const promises = [downloadStream('video', getVidUrl, videoTemp)];
      if (audioInfo) promises.push(downloadStream('audio', getAudUrl, audioTemp));
      
      await Promise.all(promises);
      clearInterval(progressTimer);

      if (this.isCancelled) {
        logPhase('warn', 'Bilibili DASH cancelled by user');
        return false;
      }

      if (!fs.existsSync(videoTemp) || fs.statSync(videoTemp).size < 1024) {
        throw new Error('Video stream file missing or invalid before merge');
      }
      if (audioInfo && (!fs.existsSync(audioTemp) || fs.statSync(audioTemp).size < 1024)) {
        throw new Error('Audio stream file missing or invalid before merge');
      }

      logPhase('info', 'Merging DASH streams with FFmpeg');
      this.emit('item-progress', { id: item.id, status: 'Merging Video & Audio (FFmpeg)...', percentage: 99, downloadedMB: (totalBytes / (1024 * 1024)).toFixed(2), speedMbps: '0.00' });
      
      await this.muxBilibiliDash(videoTemp, audioInfo ? audioTemp : null, filePath);
      logPhase('info', 'FFmpeg merge finished');

      const isMuxValid = await this.validateMediaFile(filePath);
      if (!isMuxValid) {
        throw new Error('Merged video file failed integrity verification (corrupted container or incomplete streams)');
      }

      if (settings.downloadSubtitles !== false) {
        logPhase('info', 'Fetching subtitles');
        const subtitleFiles = await this.downloadBilibiliSubtitles(item, headers, cid, filePath, bvidMatch, aidMatch, pageNum, settings);
        if (subtitleFiles.length > 0) {
          item.subtitleFiles = subtitleFiles;
          logPhase('info', `Saved ${subtitleFiles.length} subtitle file(s)`);
        }
      }
      
      if (finalize) {
        await this.finalizeCompletedItem(item, filePath, settings);
      } else {
        this.activeControllers.delete(item.id);
        this.speedMetrics.delete(item.id);
        item.filePath = filePath;
        return isMuxValid;
      }
      return true;

    } catch (err) {
      if (this.isCancelled) return;
      this.activeControllers.delete(item.id);
      this.speedMetrics.delete(item.id);
      logPhase('error', `Bilibili DASH failed: ${err.message}`, { error: err.message });
      if (fs.existsSync(videoTemp)) { try { fs.unlinkSync(videoTemp); } catch(e){} }
      if (fs.existsSync(audioTemp)) { try { fs.unlinkSync(audioTemp); } catch(e){} }
      if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch(e){} }
      if (finalize) {
        this.runningCount--;
        this.emit('item-progress', { id: item.id, status: `Error: ${err.message}`, percentage: 0, downloadedMB: '0.00' });
        this.processNextInQueue(settings);
      }
      return false;
    }
  }

  async downloadBilibiliDirectly(item, filePath, settings) {
    return await this.downloadBilibiliDASH(item, filePath, settings, { finalize: false });
  }

  async muxBilibiliDash(videoTemp, audioTemp, outputPath) {
    const { spawn } = require('child_process');
    const ffmpegExe = this.getBinPath('ffmpeg.exe');

    return new Promise((resolve, reject) => {
      let args = [
        '-y',
        '-fflags', '+genpts',
        '-i', videoTemp
      ];
      if (audioTemp) {
        args.push('-i', audioTemp);
      }
      args.push('-map', '0:v:0');
      if (audioTemp) args.push('-map', '1:a:0');
      args.push('-c:v', 'copy');
      if (audioTemp) args.push('-c:a', 'copy');
      args.push('-max_muxing_queue_size', '9999');
      args.push('-max_interleave_delta', '0');
      args.push('-avoid_negative_ts', 'make_zero');
      args.push('-movflags', '+faststart');
      args.push(outputPath);

      let proc = spawn(ffmpegExe, args);
      let stderrLog = '';
      proc.stderr.on('data', (d) => stderrLog += d.toString());
      
      proc.on('close', (code) => {
        if (code === 0) {
          if (fs.existsSync(videoTemp)) { try { fs.unlinkSync(videoTemp); } catch(e){} }
          if (audioTemp && fs.existsSync(audioTemp)) { try { fs.unlinkSync(audioTemp); } catch(e){} }
          resolve();
        } else {
          // Stream-copy failed due to timestamp jitter / gaps on long video. Attempt audio resync repair merge.
          this.emitLog('warn', `FFmpeg stream-copy exited ${code}. Attempting audio resync recovery for ${path.basename(outputPath)}...`);
          let fallbackArgs = [
            '-y',
            '-err_detect', 'ignore_err',
            '-fflags', '+genpts',
            '-i', videoTemp
          ];
          if (audioTemp) {
            fallbackArgs.push('-i', audioTemp);
          }
          fallbackArgs.push('-map', '0:v:0');
          if (audioTemp) fallbackArgs.push('-map', '1:a:0');
          fallbackArgs.push('-c:v', 'copy');
          if (audioTemp) {
            fallbackArgs.push('-c:a', 'aac', '-b:a', '192k', '-af', 'aresample=async=1');
          }
          fallbackArgs.push('-max_muxing_queue_size', '9999');
          fallbackArgs.push('-avoid_negative_ts', 'make_zero');
          fallbackArgs.push('-movflags', '+faststart');
          fallbackArgs.push(outputPath);

          let fbProc = spawn(ffmpegExe, fallbackArgs);
          let fbStderr = '';
          fbProc.stderr.on('data', (d) => fbStderr += d.toString());
          fbProc.on('close', (fbCode) => {
            if (fbCode === 0) {
              if (fs.existsSync(videoTemp)) { try { fs.unlinkSync(videoTemp); } catch(e){} }
              if (audioTemp && fs.existsSync(audioTemp)) { try { fs.unlinkSync(audioTemp); } catch(e){} }
              resolve();
            } else {
              reject(new Error(`FFmpeg merge failed (Code ${fbCode}): ${fbStderr.slice(-300)}`));
            }
          });
        }
      });
    });
  }

  // CORE ENGINE: Multi-Threaded Chunk Requests (HTTP Range Headers)
  async downloadWithParallelChunks(downloadUrl, filePath, item, settings, headers) {
    const numThreads = Math.min(32, Math.max(2, parseInt(settings.threads || 16, 10)));
    const controller = new AbortController();
    this.activeControllers.set(item.id, controller);
    this.emitLog('info', `Parallel download start for item ${item.id} with ${numThreads} worker(s)`, {
      itemId: item.id,
      threads: numThreads,
      filePath
    });

    // 1. Inspect Content-Length and check server Range support via HEAD
    let totalBytes = parseFloat(item.sizeMB || 0) * 1024 * 1024;
    let supportsRange = false;
    try {
      const headRes = await axios({
        method: 'HEAD',
        url: downloadUrl,
        timeout: 15000,
        headers: headers,
        signal: controller.signal,
        httpAgent: HTTP_AGENT,
        httpsAgent: HTTPS_AGENT
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
          signal: controller.signal,
          httpAgent: HTTP_AGENT,
          httpsAgent: HTTPS_AGENT
        }).catch(() => null);
        if (testRes && (testRes.status === 206 || (testRes.headers['content-range'] && testRes.headers['content-range'].includes('bytes')))) {
          supportsRange = true;
        }
      }
    } catch (e) {}

    // Fall back to single stream if server does not accept Range headers or file is small (< 2MB)
    if (!supportsRange || totalBytes < 2 * 1024 * 1024 || numThreads <= 1) {
      this.emitLog('info', `Parallel download fallback to single stream for item ${item.id}`, {
        itemId: item.id,
        supportsRange,
        totalBytes
      });
      return await this.downloadSingleStreamAxios(downloadUrl, filePath, item, settings, headers, totalBytes, controller);
    }

    const stateFile = filePath + '.state.json';
    let chunks = [];
    if (fs.existsSync(stateFile) && fs.existsSync(filePath)) {
      try {
        const savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (savedState.totalBytes === totalBytes && Array.isArray(savedState.chunks)) {
          chunks = savedState.chunks;
        }
      } catch(e) {}
    }

    let sharedFd = null;
    try {
      if (chunks.length > 0) {
        sharedFd = fs.openSync(filePath, 'r+');
      } else {
        sharedFd = fs.openSync(filePath, 'w+');
        if (totalBytes > 0) {
          fs.ftruncateSync(sharedFd, totalBytes);
        }
      }
    } catch (err) {
      if (sharedFd !== null) { try { fs.closeSync(sharedFd); } catch(e) {} }
      return await this.downloadSingleStreamAxios(downloadUrl, filePath, item, settings, headers, totalBytes, controller);
    }

    if (chunks.length === 0) {
      const chunkSize = Math.ceil(totalBytes / numThreads);
      for (let i = 0; i < numThreads; i++) {
        const startByte = i * chunkSize;
        if (startByte >= totalBytes) break;
        const endByte = Math.min((i + 1) * chunkSize - 1, totalBytes - 1);
        chunks.push({ index: i, startByte, endByte, downloaded: 0 });
      }
    }

    const stateInterval = setInterval(() => {
      if (!this.isCancelled && chunks.length > 0) {
         try { fs.writeFileSync(stateFile, JSON.stringify({ totalBytes, chunks }), 'utf8'); } catch(e){}
      }
    }, 2000);

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
            headers: chunkHeaders,
            httpAgent: HTTP_AGENT,
            httpsAgent: HTTPS_AGENT
          });

          if (response.status === 200 && (currentStart > 0 || chunk.endByte < totalBytes - 1)) {
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

            stream.on('end', () => {
              const expectedTotal = chunk.endByte - chunk.startByte + 1;
              if (chunk.downloaded < expectedTotal) {
                rejectChunk(new Error(`Stream ended prematurely: ${chunk.downloaded}/${expectedTotal} bytes`));
              } else {
                resolveChunk();
              }
            });
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
      clearInterval(stateInterval);
      
      const totalExpected = chunks.reduce((acc, c) => acc + (c.endByte - c.startByte + 1), 0);
      const totalGot = chunks.reduce((acc, c) => acc + c.downloaded, 0);

      if (!this.isCancelled) {
        try { fs.writeFileSync(stateFile, JSON.stringify({ totalBytes, chunks }), 'utf8'); } catch(e){}
        if (sharedFd !== null) { try { fs.closeSync(sharedFd); sharedFd = null; } catch(e) {} }
        
        if (totalExpected === totalGot && fs.existsSync(stateFile)) {
           try { fs.unlinkSync(stateFile); } catch(e){}
        }
        if (totalBytes > 0 && totalGot < totalExpected) {
          throw new Error(`Parallel download incomplete: received ${totalGot} of ${totalExpected} bytes`);
        }
      } else {
        if (sharedFd !== null) { try { fs.closeSync(sharedFd); sharedFd = null; } catch(e) {} }
      }

      this.activeControllers.delete(item.id);
      this.speedMetrics.delete(item.id);

      if (this.isCancelled) {
        return false;
      }
      const isComplete = fs.existsSync(filePath) && (totalBytes <= 0 || totalGot >= totalExpected);
      const isValid = isComplete && (await this.validateMediaFile(filePath));
      if (!isValid && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
        throw new Error('Parallel chunk file incomplete or corrupted');
      }
      return isValid;
    } catch (err) {
      if (sharedFd !== null) { try { fs.closeSync(sharedFd); sharedFd = null; } catch(e) {} }
      this.activeControllers.delete(item.id);
      this.speedMetrics.delete(item.id);
      this.emitLog('warn', `Parallel chunk engine failed for item ${item.id}, trying single stream fallback`, {
        itemId: item.id,
        error: err.message
      });
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
      if (!this.isCancelled) {
        try {
          const fallbackOk = await this.downloadSingleStreamAxios(downloadUrl, filePath, item, settings, headers, totalBytes, controller);
          if (fallbackOk) {
            return true;
          }
        } catch (fallbackErr) {}
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
          this.emitLog('info', `Single stream download started for item ${item.id}`, { itemId: item.id, filePath });
          this.emit('item-progress', { id: item.id, status: 'Downloading Stream...', percentage: 1, downloadedMB: '0.10', speedMbps: '0.00' });
        } else {
          this.emitLog('warn', `Single stream retry ${attempt}/3 for item ${item.id}`, { itemId: item.id, attempt });
          this.emit('item-progress', { id: item.id, status: `Retrying (${attempt}/3)...`, percentage: 1, downloadedMB: '0.10', speedMbps: '0.00' });
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        }

        const response = await axios({
          method: 'GET',
          url: downloadUrl,
          responseType: 'stream',
          signal: controller.signal,
          timeout: 30000,
          headers: headers,
          httpAgent: HTTP_AGENT,
          httpsAgent: HTTPS_AGENT
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
            const bytesPerSec = timeDiff > 0 ? (bytesDiff / timeDiff) : 0;
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
          const isComplete = fs.existsSync(filePath) && (!actualBytes || fs.statSync(filePath).size >= (actualBytes - 2048));
          const isValid = isComplete && (await this.validateMediaFile(filePath));
          if (isValid) {
            downloadSuccess = true;
            this.activeControllers.delete(item.id);
            this.speedMetrics.delete(item.id);
            return true;
          } else {
            if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch (e) {} }
            throw new Error('Single stream download was incomplete or corrupted');
          }
        }
      } catch (error) {
        if (axios.isCancel(error) || this.isCancelled) break;
        if (attempt === 3) throw error;
      }
    }
    this.activeControllers.delete(item.id);
    this.speedMetrics.delete(item.id);
    if (!downloadSuccess && !this.isCancelled) {
      this.emitLog('error', `Single stream download failed for item ${item.id}`, { itemId: item.id });
    }
    return downloadSuccess;
  }

  async processNextInQueue(settings) {
    if (this.isCancelled || this.activeQueue.length === 0) {
      if (this.runningCount === 0 && this.speedTimer) {
        clearInterval(this.speedTimer);
        this.speedTimer = null;
        this.broadcastGlobalStatus();
        this.emit('queue-completed', { completed: this.completedCount, total: this.totalCount });
        this.emitLog('info', `Queue completed: ${this.completedCount}/${this.totalCount}`);
      }
      return;
    }

    const item = this.activeQueue.shift();
    this.runningCount++;
    this.emitLog('info', `Processing item ${item.id}: ${item.title || item.movieName || 'Untitled'}`, {
      itemId: item.id,
      platform: item.platform,
      url: item.downloadUrl || item.url || ''
    });
    const { targetDir, baseFilenameWithoutExt, filePath } = this.buildDownloadPaths(item, settings);

    // Ensure target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    if (settings.subtitleOnly) {
      const subtitlePath = await this.downloadSubtitleOnly(item, settings);
      if (subtitlePath) {
        item.subtitleFiles = [subtitlePath];
        await this.finalizeCompletedItem(item, subtitlePath, settings, 'Completed');
      } else {
        this.runningCount--;
        this.emit('item-progress', { id: item.id, status: 'Error: Subtitle download failed', percentage: 0, downloadedMB: '0.00' });
        this.processNextInQueue(settings);
      }
      return;
    }

    // 1. Download subtitle FIRST before starting video stream
    if (settings.downloadSubtitles !== false) {
      await this.ensureSubtitlesDownloaded(item, targetDir, baseFilenameWithoutExt, settings);
    }

    // 2. Check if video has already been downloaded: do not re-download, mark Completed
    const existingOutput = this.resolveExistingOutputPath(targetDir, baseFilenameWithoutExt, filePath);
    if (existingOutput) {
      const isValid = await this.validateMediaFile(existingOutput);
      if (isValid) {
        this.emitLog('info', `Video already downloaded and verified for item ${item.id} (${path.basename(existingOutput)}). Skipping video download and marking Completed.`, {
          itemId: item.id,
          filePath: existingOutput
        });

        await this.finalizeCompletedItem(item, existingOutput, settings, 'Completed');
        return;
      } else {
        this.emitLog('warn', `Found existing file for item ${item.id} (${path.basename(existingOutput)}) but it failed integrity verification (corrupted/incomplete). Removing to re-download cleanly.`, {
          itemId: item.id,
          filePath: existingOutput
        });
        try { fs.unlinkSync(existingOutput); } catch (e) {}
      }
    }

    const targetUrlLower = (item.downloadUrl || item.url || '').toLowerCase();
    const isBili = item.platform === 'BiliBili' || targetUrlLower.includes('bilibili') || targetUrlLower.includes('b23.tv') || targetUrlLower.includes('bibili');

    if (isBili) {
      this.emitLog('info', `Routing item ${item.id} through Bilibili DASH pipeline`, {
        itemId: item.id,
        mode: settings?.bilibiliMode || 'balanced'
      });
      const dashSuccess = await this.downloadBilibiliDASH(item, filePath, settings, { finalize: false });
      const isValid = dashSuccess && fs.existsSync(filePath) && (await this.validateMediaFile(filePath));
      if (dashSuccess && isValid) {
        await this.finalizeCompletedItem(item, filePath, settings);
      } else if (!this.isCancelled) {
        if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch (e) {} }
        this.emitLog('warn', `Bilibili DASH pipeline unsuccessful or invalid, falling back to resilient yt-dlp pipeline for item ${item.id}`, { itemId: item.id });
        await this.downloadWithYtDlp(item, filePath, settings);
      }
      return;
    }

    if (item.useYtDlp || item.platform === 'YouTube' || item.platform === 'TikTok' || item.platform === 'DramaBox' || targetUrlLower.includes('dramabox') || targetUrlLower.includes('youtube') || targetUrlLower.includes('youtu.be') || targetUrlLower.includes('tiktok')) {
      this.emitLog('info', `Routing item ${item.id} through yt-dlp pipeline`, {
        itemId: item.id,
        platform: item.platform
      });
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
      this.emitLog('info', `Parallel download completed for item ${item.id}`, {
        itemId: item.id,
        filePath
      });
      if (settings && settings.downloadThumbnails !== false) {
        try {
          const thumbPath = await this.downloadThumbnail(item, targetDir, baseFilenameWithoutExt, settings);
          if (thumbPath) {
            item.thumbnailFile = thumbPath;
          }
        } catch (e) {}
      }
      const stats = fs.statSync(filePath);
      const totalBytes = stats.size;
      this.emit('item-progress', {
        id: item.id,
        status: 'Completed',
        percentage: 100,
        downloadedMB: (totalBytes / (1024 * 1024)).toFixed(2),
        speedMbps: '0.00',
        filePath,
        thumbnailPath: item.thumbnailFile || null
      });
    } else if (!this.isCancelled) {
      this.emitLog('error', `Parallel download failed for item ${item.id}`, {
        itemId: item.id,
        filePath
      });
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
    this.emitLog('warn', 'Cancelling all active downloads');
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
