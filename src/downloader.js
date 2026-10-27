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

// High-precision Token-Bucket Bandwidth Limiter & QoS Pacer
// Ensures the app utilizes maximum safe Wi-Fi speed without causing bufferbloat or lagging other devices
class BandwidthLimiter {
  constructor(limitMBps = 0) {
    this.setLimit(limitMBps);
  }

  setLimit(limitMBps) {
    this.limitMBps = Math.max(0, parseFloat(limitMBps) || 0);
    this.bytesPerSec = this.limitMBps > 0 ? this.limitMBps * 1024 * 1024 : 0;
    // Burst capacity: smooth burst between 256KB and 2MB (or 200ms worth of data)
    this.maxBurst = this.bytesPerSec > 0 ? Math.max(256 * 1024, Math.min(2 * 1024 * 1024, this.bytesPerSec * 0.2)) : 0;
    this.tokens = this.maxBurst;
    this.lastRefill = Date.now();
  }

  isEnabled() {
    return this.bytesPerSec > 0;
  }

  consume(bytes) {
    if (this.bytesPerSec <= 0) return 0;

    const now = Date.now();
    const elapsedSec = Math.max(0, (now - this.lastRefill) / 1000);
    this.lastRefill = now;

    // Refill tokens according to elapsed time
    this.tokens = Math.min(this.maxBurst, this.tokens + (elapsedSec * this.bytesPerSec));
    this.tokens -= bytes;

    if (this.tokens < 0) {
      // Calculate delay in ms needed to refill back to zero
      const deficit = -this.tokens;
      const delayMs = Math.ceil((deficit / this.bytesPerSec) * 1000);
      return Math.min(500, Math.max(2, delayMs));
    }

    return 0;
  }
}

class DownloaderEngine extends EventEmitter {
  constructor() {
    super();
    this.activeQueue = [];
    this.globalQueue = [];
    this.localQueue = [];
    this.runningCount = 0;
    this.runningGlobalCount = 0;
    this.runningLocalCount = 0;
    this.completedCount = 0;
    this.totalCount = 0;
    this.globalConcurrencyLimit = 2; // 2 videos for global speed (like bilibili)
    this.localConcurrencyLimit = 2;  // 2 videos for local speed (like youtube)
    this.concurrencyLimit = 4;       // 2 + 2 = 4 together per time
    this.isCancelled = false;
    this.activeControllers = new Map();
    this.speedMetrics = new Map(); // id -> bytes per second
    this.speedTimer = null;
    this.bandwidthLimiter = new BandwidthLimiter();
  }

  getItemSpeedPool(item) {
    if (!item) return 'global';
    if (item.speedPool === 'local' || item.speedPool === 'global') return item.speedPool;
    const targetUrlLower = String(item.downloadUrl || item.url || '').toLowerCase();
    const platformLower = String(item.platform || '').toLowerCase();
    const extractorLower = String(item.extractor || item.extractor_key || '').toLowerCase();

    // Local speed pool (YouTube, Facebook, TikTok, Instagram, Twitter/X, Threads)
    const isDomain = (d) => targetUrlLower.includes(`//${d}`) || targetUrlLower.includes(`.${d}`);
    if (
      platformLower.includes('youtube') || targetUrlLower.includes('youtube.com') || targetUrlLower.includes('youtu.be') || extractorLower.includes('youtube') ||
      platformLower.includes('facebook') || targetUrlLower.includes('facebook.com') || targetUrlLower.includes('fb.watch') || isDomain('fb.com') || extractorLower.includes('facebook') ||
      platformLower.includes('tiktok') || targetUrlLower.includes('tiktok.com') || extractorLower.includes('tiktok') ||
      platformLower.includes('instagram') || targetUrlLower.includes('instagram.com') || extractorLower.includes('instagram') ||
      platformLower === 'x' || platformLower.includes('twitter') || platformLower.includes('twitter/x') || targetUrlLower.includes('twitter.com') || isDomain('x.com') ||
      platformLower.includes('threads') || targetUrlLower.includes('threads.net')
    ) {
      return 'local';
    }

    // Global speed pool (Bilibili, overseas and Chinese platforms)
    return 'global';
  }

  incrementRunning(item) {
    const pool = this.getItemSpeedPool(item);
    if (pool === 'local') {
      this.runningLocalCount++;
    } else {
      this.runningGlobalCount++;
    }
    this.runningCount = this.runningGlobalCount + this.runningLocalCount;
  }

  decrementRunning(item) {
    const pool = this.getItemSpeedPool(item);
    if (pool === 'local') {
      this.runningLocalCount = Math.max(0, this.runningLocalCount - 1);
    } else {
      this.runningGlobalCount = Math.max(0, this.runningGlobalCount - 1);
    }
    this.runningCount = this.runningGlobalCount + this.runningLocalCount;
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

  async resolveDonghuaStreamUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const lower = rawUrl.toLowerCase();
    if (!lower.includes('donghuafun') && !lower.includes('/vod/play/')) return null;

    try {
      const urlModule = require('url');
      let playUrl = rawUrl;
      if (lower.includes('/vod/detail/')) {
        const dRes = await axios.get(rawUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          timeout: 8000
        });
        const match = dRes.data.match(/href="([^"]*\/vod\/play\/[^"]*)"/i);
        if (match) {
          playUrl = urlModule.resolve(rawUrl, match[1]);
        }
      }

      const pRes = await axios.get(playUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        timeout: 8000
      });
      const html = pRes.data;

      let pData = null;
      const startIdx = html.indexOf('player_aaaa');
      if (startIdx !== -1) {
        const braceStart = html.indexOf('{', startIdx);
        if (braceStart !== -1) {
          let depth = 0;
          for (let i = braceStart; i < html.length; i++) {
            if (html[i] === '{') depth++;
            else if (html[i] === '}') {
              depth--;
              if (depth === 0) {
                try { pData = JSON.parse(html.slice(braceStart, i + 1)); } catch (e) {}
                break;
              }
            }
          }
        }
      }
      if (!pData) {
        const match = html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]+?\})(?:;?\s*<\/(?:script|div)>|;\s*var|;\s*$)/m);
        if (match) {
          try { pData = JSON.parse(match[1]); } catch (e) {}
        }
      }

      if (pData && pData.url) {
        let stream = String(pData.url).trim();
        const encrypt = String(pData.encrypt || '0');
        if (encrypt === '1') {
          try { stream = unescape(stream); } catch (e) {}
        } else if (encrypt === '2') {
          try {
            stream = unescape(Buffer.from(stream, 'base64').toString('utf8'));
          } catch (e) {
            try { stream = unescape(stream); } catch (err) {}
          }
        }
        const from = String(pData.from || '').toLowerCase();
        if (stream.startsWith('http://') || stream.startsWith('https://')) return stream;
        if (from === 'dailymotion' || from.includes('daily')) return `https://www.dailymotion.com/video/${stream}`;
        if (from.includes('ganjing')) return `https://www.ganjingworld.com/video/${stream}`;
        if (from === 'youtube' || from === 'youtu') return `https://www.youtube.com/watch?v=${stream}`;
        if (from === 'bilibili' || from === 'bili') return `https://www.bilibili.com/video/${stream}`;
        if (stream.startsWith('1iso') && stream.length >= 20) return `https://www.ganjingworld.com/video/${stream}`;
        if (/^[a-zA-Z0-9_-]{11}$/.test(stream)) return `https://www.youtube.com/watch?v=${stream}`;
        if (/^k[a-zA-Z0-9]{15,25}$/.test(stream)) return `https://www.dailymotion.com/video/${stream}`;
        return stream;
      }
    } catch (e) {}
    return null;
  }

  getBilibiliDashTuning(totalBytes, streamType, settings = {}) {
    const mode = String(settings.bilibiliMode || 'fast').toLowerCase();
    const isWifiFriendly = settings.wifiFriendly !== false && settings.speedLimitMode !== 'unlimited';

    // Optimized multi-threaded tuning for Bilibili streams (unlocked up to 16 workers for high speed)
    const presets = {
      stable: {
        videoWorkers: 4,
        audioWorkers: 2,
        minVideoChunkMB: 4,
        maxVideoChunkMB: 16,
        minAudioChunkMB: 2,
        maxAudioChunkMB: 8,
        staggerMs: isWifiFriendly ? 40 : 20,
        flushIntervalMs: 40,
        flushThresholdKB: 1024,
        maxBufferedKB: 4096,
        retryBackoffMs: 600,
        maxChunkRetries: 25
      },
      balanced: {
        videoWorkers: isWifiFriendly ? 6 : 10,
        audioWorkers: 2,
        minVideoChunkMB: 4,
        maxVideoChunkMB: 24,
        minAudioChunkMB: 2,
        maxAudioChunkMB: 12,
        staggerMs: isWifiFriendly ? 30 : 15,
        flushIntervalMs: 30,
        flushThresholdKB: isWifiFriendly ? 1024 : 2048,
        maxBufferedKB: isWifiFriendly ? 4096 : 8192,
        retryBackoffMs: 500,
        maxChunkRetries: 25
      },
      fast: {
        videoWorkers: isWifiFriendly ? 8 : 16,
        audioWorkers: 4,
        minVideoChunkMB: 4,
        maxVideoChunkMB: 32,
        minAudioChunkMB: 2,
        maxAudioChunkMB: 16,
        staggerMs: isWifiFriendly ? 20 : 10,
        flushIntervalMs: 20,
        flushThresholdKB: isWifiFriendly ? 1024 : 2048,
        maxBufferedKB: isWifiFriendly ? 4096 : 8192,
        retryBackoffMs: 400,
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

    const findCookiesForPlatform = (type) => {
      const filename = type === 'youtube' ? 'www.youtube.com_cookies.txt' : 'www.bilibili.com_cookies.txt';
      const altFilename = type === 'youtube' ? 'youtube_cookies.txt' : 'bilibili_cookies.txt';
      const rawDir = (typeof rawCookies === 'string' && rawCookies.trim() && path.isAbsolute(rawCookies.trim())) ? path.dirname(rawCookies.trim()) : null;
      const candidates = [
        rawDir ? path.join(rawDir, filename) : null,
        rawDir ? path.join(rawDir, altFilename) : null,
        process.resourcesPath ? path.join(process.resourcesPath, filename) : null,
        process.execPath ? path.join(path.dirname(process.execPath), 'resources', filename) : null,
        process.execPath ? path.join(path.dirname(process.execPath), filename) : null,
        path.join(process.cwd(), filename),
        path.join(__dirname, '..', filename),
        path.join(__dirname, filename),
        path.join('D:\\PROJECT', filename),
        path.join('D:\\PROJECT\\DOWNLOAD\\snapkee-app', filename)
      ].filter(Boolean);
      return candidates.find(p => fs.existsSync(p)) || '';
    };

    // If cookies were provided but belong to another platform, perform intelligent domain mapping
    if (typeof rawCookies === 'string' && rawCookies.trim()) {
      const rawLower = rawCookies.toLowerCase();
      if (isYouTube && (rawLower.includes('bilibili') || rawLower.includes('b23'))) {
        rawCookies = findCookiesForPlatform('youtube');
      } else if (isBilibili && rawLower.includes('youtube')) {
        rawCookies = findCookiesForPlatform('bilibili');
      } else if (!isBilibili && !isYouTube && (rawLower.includes('bilibili') || rawLower.includes('youtube') || rawLower.includes('b23') || rawLower.includes('google'))) {
        rawCookies = '';
      }
    } else {
      if (isBilibili) {
        rawCookies = findCookiesForPlatform('bilibili');
      } else if (isYouTube) {
        rawCookies = findCookiesForPlatform('youtube');
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
        let finalPath = resolvedPath;
        if (resolvedPath.includes('app.asar')) {
          try {
            const os = require('os');
            const extractedCookiePath = path.join(os.tmpdir(), `snapkee_${platformKey}_cookies.txt`);
            fs.writeFileSync(extractedCookiePath, content, 'utf8');
            finalPath = extractedCookiePath;
          } catch (err) {}
        }
        const result = { cookieFile: finalPath, cookieHeader: headerStr };
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

  parseTimeToSeconds(input, totalSec = 0) {
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

  formatSecondsToTime(sec, forceHours = true) {
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

  getEffectiveTimeRange(item, settings = {}) {
    if (item?.timeRange && item.timeRange.enabled) {
      return item.timeRange;
    }
    if (settings?.timeRange && settings.timeRange.enabled) {
      return settings.timeRange;
    }
    return null;
  }

  formatDownloadSection(timeRange, itemDurationSec = 0) {
    if (!timeRange || !timeRange.enabled) return null;
    let startSec = this.parseTimeToSeconds(timeRange.start, itemDurationSec);
    let endSec = this.parseTimeToSeconds(timeRange.end, itemDurationSec);

    if (startSec === null || startSec === undefined) startSec = 0;
    if (endSec === null || endSec === undefined || endSec === '' || timeRange.toEnd) {
      endSec = (itemDurationSec && itemDurationSec > 0) ? itemDurationSec : 'inf';
    }

    let startStr = typeof startSec === 'number' ? (startSec < 0 ? String(startSec) : this.formatSecondsToTime(startSec)) : String(startSec);
    let endStr = (endSec === 'inf' || endSec === Infinity) ? 'inf' : (typeof endSec === 'number' ? this.formatSecondsToTime(endSec) : String(endSec));

    return `*${startStr}-${endStr}`;
  }

  formatTimeRangeFilenameTag(timeRange, item = {}) {
    const durSec = item.durationSeconds || this.parseTimeToSeconds(item.duration) || 0;
    let startSec = this.parseTimeToSeconds(timeRange.start, durSec);
    let endSec = this.parseTimeToSeconds(timeRange.end, durSec);
    if (startSec === null || startSec === undefined) startSec = 0;

    const startStr = typeof startSec === 'number' ? this.formatSecondsToTime(startSec).replace(/:/g, '.') : String(timeRange.start || '0').replace(/:/g, '.');
    let endStr = 'End';
    if (endSec !== 'inf' && endSec !== Infinity && endSec !== null && !timeRange.toEnd) {
      endStr = typeof endSec === 'number' ? this.formatSecondsToTime(endSec).replace(/:/g, '.') : String(timeRange.end || 'End').replace(/:/g, '.');
    }
    return `${startStr}-${endStr}`;
  }

  parseSrtTimestamp(ts) {
    if (!ts) return 0;
    const parts = ts.trim().split(/[:,]/);
    if (parts.length < 4) return 0;
    return parseInt(parts[0], 10) * 3600 +
           parseInt(parts[1], 10) * 60 +
           parseInt(parts[2], 10) +
           parseInt(parts[3], 10) / 1000;
  }

  formatSrtTimestamp(sec) {
    const s = Math.max(0, sec || 0);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  }

  trimSubtitleToTimeRange(srtFilePath, timeRange, totalDurSec = 0) {
    try {
      if (!fs.existsSync(srtFilePath)) return false;
      const startSec = this.parseTimeToSeconds(timeRange.start, totalDurSec) || 0;
      let endSec = this.parseTimeToSeconds(timeRange.end, totalDurSec);
      if (endSec === null || endSec === undefined || timeRange.toEnd) endSec = 'inf';

      const content = fs.readFileSync(srtFilePath, 'utf8');
      const blocks = content.split(/\r?\n\r?\n/);
      const newBlocks = [];
      let counter = 1;

      for (const block of blocks) {
        const lines = block.trim().split(/\r?\n/);
        if (lines.length < 2) continue;
        const timeLineIndex = lines.findIndex(l => l.includes('-->'));
        if (timeLineIndex === -1) continue;

        const [startRaw, endRaw] = lines[timeLineIndex].split('-->').map(s => s.trim());
        const itemStart = this.parseSrtTimestamp(startRaw);
        const itemEnd = this.parseSrtTimestamp(endRaw);

        if (itemEnd < startSec) continue;
        if (endSec !== 'inf' && itemStart > endSec) continue;

        const shiftedStart = Math.max(0, itemStart - startSec);
        const shiftedEnd = Math.max(shiftedStart + 0.1, itemEnd - startSec);

        const textLines = lines.slice(timeLineIndex + 1);
        newBlocks.push(`${counter++}\n${this.formatSrtTimestamp(shiftedStart)} --> ${this.formatSrtTimestamp(shiftedEnd)}\n${textLines.join('\n')}`);
      }

      if (newBlocks.length > 0) {
        fs.writeFileSync(srtFilePath, newBlocks.join('\n\n') + '\n', 'utf8');
        this.emitLog('info', `Synchronized subtitle for custom section [start offset: -${this.formatSecondsToTime(startSec)}, ${newBlocks.length} cues preserved]`, {
          filePath: srtFilePath
        });
      }
      return true;
    } catch (e) {
      this.emitLog('warn', `Failed to trim subtitle: ${e.message}`, { filePath: srtFilePath });
      return false;
    }
  }

  cleanMovieTitle(item, settings = {}) {
    const fallbackId = this.getVideoFilenameFallback(item);
    let raw = (item?.title || item?.movieName || '').trim();
    if (!raw || raw.toLowerCase().startsWith('media stream') || raw.toLowerCase() === 'video') {
      raw = `${item?.platform || 'Video'}_${fallbackId}`;
    }
    let sanitized = this.sanitizeFilename(raw, fallbackId).substring(0, 150);

    const effectiveTimeRange = this.getEffectiveTimeRange(item, settings);
    if (effectiveTimeRange && effectiveTimeRange.enabled) {
      const rangeTag = this.formatTimeRangeFilenameTag(effectiveTimeRange, item);
      if (rangeTag) {
        sanitized = `${sanitized} [${rangeTag}]`;
      }
    }

    return sanitized;
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
          const fatalCorrupt = /(?:moov atom not found|Invalid data found when processing input|EBADF|Header missing|Truncated|Invalid NAL unit)/i.test(stderr);
          if (code === 0 && !fatalCorrupt) {
            try {
              const { spawnSync } = require('child_process');
              const probe = spawnSync(ffmpegExe, ['-i', filePath], { encoding: 'utf8' });
              const info = (probe.stderr || '') + (probe.stdout || '');
              const hasVideo = /Stream #\d+:\d+.*Video:/i.test(info);
              const durMatch = info.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/i);
              if (hasVideo && durMatch) {
                const durSec = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
                if (durSec > 20) {
                  const testPts = [Math.floor(durSec * 0.5), Math.floor(durSec * 0.8)];
                  for (const pt of testPts) {
                    const chk = spawnSync(ffmpegExe, ['-v', 'error', '-ss', String(pt), '-i', filePath, '-vframes', '1', '-f', 'null', '-'], { encoding: 'utf8' });
                    if (chk.status !== 0 || (chk.stderr && /Invalid NAL unit|missing picture/i.test(chk.stderr))) {
                      return resolve(false);
                    }
                  }
                }
              }
            } catch (e) {}
            resolve(true);
          } else {
            // Check if file is simply shorter than 10 seconds
            const probeProc = spawn(ffmpegExe, ['-i', filePath]);
            let probeErr = '';
            const probeTimer = setTimeout(() => {
              try { probeProc.kill('SIGKILL'); } catch (e) {}
              resolve(false);
            }, 5000);
            probeProc.stderr?.on('data', (pd) => probeErr += pd.toString());
            probeProc.on('close', () => {
              clearTimeout(probeTimer);
              const durMatch = probeErr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/i);
              if (durMatch) {
                const durSec = parseInt(durMatch[1], 10) * 3600 + parseInt(durMatch[2], 10) * 60 + parseFloat(durMatch[3]);
                if (durSec <= 10) {
                  const { spawnSync } = require('child_process');
                  const quickRes = spawnSync(ffmpegExe, ['-v', 'error', '-ss', '0', '-i', filePath, '-vframes', '1', '-f', 'null', '-']);
                  return resolve(quickRes.status === 0);
                }
              }
              // For videos > 10s, if trailer packet decode failed, the file is truncated or corrupted mid-stream!
              resolve(false);
            });
            probeProc.on('error', () => {
              clearTimeout(probeTimer);
              resolve(false);
            });
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
    const baseFilenameWithoutExt = this.cleanMovieTitle(item, settings);
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

      if (thumbUrl.includes('img.php?url=')) {
        const unwrapped = thumbUrl.split('img.php?url=')[1];
        if (unwrapped && unwrapped.startsWith('http')) {
          thumbUrl = decodeURIComponent(unwrapped);
        }
      }

      const headers = {
        'User-Agent': this.getModernUserAgent(settings, item),
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      };
      if (isBili) {
        headers['Referer'] = this.getBilibiliReferer(item);
      } else if (isYt) {
        headers['Referer'] = 'https://www.youtube.com/';
      } else if (thumbUrl.includes('doubanio.com')) {
        headers['Referer'] = 'https://movie.douban.com/';
      } else if (thumbUrl.includes('donghuafun')) {
        headers['Referer'] = 'https://donghuafun.com/';
      } else if (thumbUrl.includes('byteimg.com') || item.platform === 'NovelQuick') {
        headers['Referer'] = 'https://novelquickapp.com/';
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
    this.decrementRunning(item);
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
    this.checkAndFillPools(settings);
    this.checkQueueCompleted();
  }

  async ensureSubtitlesDownloaded(item, targetDir, baseFilenameWithoutExt, settings) {
    if (settings.downloadSubtitles === false || item.platform === 'NovelQuick') return null;

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
    const baseFilenameWithoutExt = this.cleanMovieTitle(item, settings);
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
      if (files && files.length > 0) {
        const effectiveTimeRange = this.getEffectiveTimeRange(item, settings);
        if (effectiveTimeRange) {
          this.trimSubtitleToTimeRange(files[0], effectiveTimeRange, item.durationSeconds || this.parseTimeToSeconds(item.duration));
        }
        return files[0];
      }
      return null;
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
      '-o', path.join(tempSubDir, `${baseFilenameWithoutExt}.%(ext)s`),
      '--socket-timeout', '30',
      '--impersonate', 'chrome'
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
          const effectiveTimeRange = this.getEffectiveTimeRange(item, settings);
          if (effectiveTimeRange) {
            this.trimSubtitleToTimeRange(normalized, effectiveTimeRange, item.durationSeconds || this.parseTimeToSeconds(item.duration));
          }
          this.emitLog('info', `Saved 1 subtitle-only file: ${path.basename(normalized)}`, { itemId: item.id, filePath: normalized });
          resolve(normalized);
        } else {
          this.emitLog('error', `Subtitle-only download produced no subtitle (yt-dlp exit ${code})`, { itemId: item.id, output: output.slice(-1000) });
          resolve(null);
        }
      });
    });
  }

  startQueue(items, settings = {}) {
    this.cancelAll(); // Clean up any previous runs
    this.isCancelled = false;

    // Smart Wi-Fi QoS & Bandwidth Cap Configuration
    const speedLimitMode = String(settings.speedLimitMode || 'unlimited');
    let speedLimitMB = 0;
    if (speedLimitMode === '10' || speedLimitMode === 'wifi-balanced') {
      speedLimitMB = 10; // 10 MB/s (80 Mbps) - Perfect 80% sweet-spot for 100M broadband (leaves ~20 Mbps clean headroom!)
    } else if (speedLimitMode === '11.5' || speedLimitMode === 'wifi-turbo') {
      speedLimitMB = 11.5; // 11.5 MB/s (~92 Mbps) - Turbo for 100M line
    } else if (speedLimitMode === '8' || speedLimitMode === 'wifi-safe') {
      speedLimitMB = 8; // 8 MB/s (~64 Mbps) - Ultra safe for gaming / Zoom calls
    } else if (speedLimitMode === '20') {
      speedLimitMB = 20; // 20 MB/s (~160 Mbps) for 200M plans
    } else if (speedLimitMode === '30') {
      speedLimitMB = 30; // 30 MB/s (~240 Mbps) for 300M+ plans
    } else if (speedLimitMode === '5' || speedLimitMode === 'wifi-light') {
      speedLimitMB = 5; // 5 MB/s (~40 Mbps) for 50M plans
    } else if (speedLimitMode === 'custom') {
      speedLimitMB = Math.max(0.5, parseFloat(settings.customSpeedMB || 10));
    } else if (speedLimitMode === 'unlimited') {
      speedLimitMB = 0; // Uncapped
    } else {
      const parsedNum = parseFloat(speedLimitMode);
      if (!isNaN(parsedNum) && parsedNum > 0) {
        speedLimitMB = parsedNum;
      }
    }

    const isWifiFriendly = settings.wifiFriendly !== false && speedLimitMode !== 'unlimited';
    settings.speedLimitMB = speedLimitMB;
    settings.wifiFriendly = isWifiFriendly;

    this.bandwidthLimiter.setLimit(speedLimitMB);

    // Dual Speed Concurrency configuration:
    // Can download 2 global speed videos (like Bilibili) and 2 local speed videos (like YouTube) together simultaneously
    this.globalConcurrencyLimit = Math.max(1, parseInt(settings.globalConcurrency || 2, 10));
    this.localConcurrencyLimit = Math.max(1, parseInt(settings.localConcurrency || 2, 10));
    this.concurrencyLimit = this.globalConcurrencyLimit + this.localConcurrencyLimit;

    this.globalQueue = [];
    this.localQueue = [];
    for (const item of items) {
      const pool = this.getItemSpeedPool(item);
      item.speedPool = pool;
      if (pool === 'local') {
        this.localQueue.push(item);
      } else {
        this.globalQueue.push(item);
      }
    }

    this.activeQueue = [...items];
    this.totalCount = items.length;
    this.completedCount = 0;
    this.runningCount = 0;
    this.runningGlobalCount = 0;
    this.runningLocalCount = 0;
    this.speedMetrics.clear();
    this.emitLog(
      'info',
      `Dual-Speed Queue started: ${items.length} item(s) [Global (Bilibili/Overseas): ${this.globalQueue.length} (limit ${this.globalConcurrencyLimit}), Local (YouTube/Domestic): ${this.localQueue.length} (limit ${this.localConcurrencyLimit})]. Downloading up to ${this.concurrencyLimit} streams together per time. QoS=${isWifiFriendly ? 'ON' : 'OFF'}, Speed Limit=${speedLimitMB > 0 ? speedLimitMB + ' MB/s' : 'Uncapped'}`,
      {
        totalItems: items.length,
        globalCount: this.globalQueue.length,
        localCount: this.localQueue.length,
        globalLimit: this.globalConcurrencyLimit,
        localLimit: this.localConcurrencyLimit,
        totalConcurrency: this.concurrencyLimit,
        mode: settings?.bilibiliMode || 'fast',
        isWifiFriendly,
        speedLimitMB
      }
    );

    // Start global speed broadcast interval
    this.speedTimer = setInterval(() => {
      this.broadcastGlobalStatus();
    }, 500);

    // Launch dual-channel concurrent workers together (up to 2 global + 2 local simultaneously)
    this.checkAndFillPools(settings);
  }

  async downloadWithYtDlp(item, filePath, settings) {
    const { spawn } = require('child_process');
    let targetUrl = item.downloadUrl || item.url;
    const targetUrlRawLower = String(targetUrl || '').toLowerCase();
    if (targetUrl && (targetUrlRawLower.includes('donghuafun') || targetUrlRawLower.includes('/vod/play/') || targetUrlRawLower.includes('/vod/detail/'))) {
      const resolved = await this.resolveDonghuaStreamUrl(targetUrl);
      if (resolved) {
        targetUrl = resolved;
        item.downloadUrl = resolved;
      }
    }
    const targetDir = path.dirname(filePath);
    const baseFilenameWithoutExt = this.cleanMovieTitle(item, settings);

      const userAgent = this.getModernUserAgent(settings, item);
      const { cookieFile, cookieHeader } = this.prepareCookieConfig(settings, item, targetDir);

    return new Promise((resolve) => {
      let isDone = false;
      const targetUrlLower = targetUrl.toLowerCase();
      const isBilibili = targetUrlLower.includes('bilibili') || targetUrlLower.includes('b23.tv') || targetUrlLower.includes('bibili') || item.platform === 'BiliBili' || (item.profile && item.profile.toLowerCase().includes('bili'));
      const isYouTube = targetUrlLower.includes('youtube.com') || targetUrlLower.includes('youtu.be') || item.platform === 'YouTube';
      const isOdysee = targetUrlLower.includes('odysee.com') || targetUrlLower.includes('lbry.tv') || targetUrlLower.includes('lbry://') || item.platform === 'Odysee' || item.platform === 'LBRY';
      const isDailymotion = targetUrlLower.includes('dailymotion.com') || item.platform === 'Dailymotion' || (item.profile && item.profile.toLowerCase().includes('dailymotion'));
      const isGanjing = targetUrlLower.includes('ganjingworld.com') || targetUrlLower.includes('ganjing') || item.platform === 'GanJingWorld';
      const isDonghua = targetUrlLower.includes('donghuafun') || item.platform === 'DonghuaFun' || item.platform === 'Donghua';
      const isDashOrHls = isYouTube || isBilibili || isDailymotion || isGanjing || isDonghua || /\.(?:mpd|m3u8)(?:[?#]|$)/i.test(targetUrlLower) || /(?:dash|hls)/i.test(String(item.format || item.protocol || ''));
      const preferredSubtitleLanguages = this.getPreferredSubtitleLanguages(settings, item);

      const effectiveTimeRange = this.getEffectiveTimeRange(item, settings);
      const sectionSpec = effectiveTimeRange ? this.formatDownloadSection(effectiveTimeRange, item.durationSeconds || this.parseTimeToSeconds(item.duration)) : null;

      let capturedFilePath = null;
      const args = [
        '--newline',
        '--continue',
        '--no-playlist',
        '--no-warnings',
        '--abort-on-unavailable-fragment',
        '--no-check-certificates',
        '--windows-filenames',
        '--socket-timeout', '30',
        '--throttled-rate', '100K',
        ...this.getJsRuntimeArg()
      ];

      if (sectionSpec) {
        args.push('--download-sections', sectionSpec);
        this.emitLog('info', `yt-dlp custom time range active: ${sectionSpec} for item ${item.id}`, {
          itemId: item.id,
          timeRange: effectiveTimeRange,
          sectionSpec
        });
      }

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
      } else if (isOdysee) {
        args.push('--add-header', 'Referer:https://odysee.com/');
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
        args.push('--extractor-args', 'bilibili:player_client=tv,android,web');
      } else if (isOdysee) {
        args.push('--add-header', 'Referer: https://odysee.com/');
      } else if (isDailymotion) {
        args.push('--add-header', 'Referer: https://www.dailymotion.com/');
      } else if (isGanjing) {
        args.push('--add-header', 'Referer: https://www.ganjingworld.com/');
      } else if (isDonghua) {
        args.push('--add-header', 'Referer: https://donghuafun.com/');
      }

      const ytDlpExe = this.getBinPath('yt-dlp.exe');
      const ffmpegExe = this.getBinPath('ffmpeg.exe');
      const aria2cExe = this.getBinPath('aria2c.exe');

      const isWifiFriendly = settings.wifiFriendly !== false && settings.speedLimitMode !== 'unlimited';
      const speedLimitMB = parseFloat(settings.speedLimitMB || 0);
      const concurrency = Math.max(1, this.concurrencyLimit || 1);
      const perItemLimitMB = speedLimitMB > 0 ? Math.max(1, Math.floor(speedLimitMB / concurrency)) : 0;

      if (isBilibili) {
        const biliMode = String(settings.bilibiliMode || 'fast').toLowerCase();
        // High-speed parallel downloader for Bilibili DASH streams (up to 16 concurrent fragments)
        const fallbackProfiles = {
          stable: { fragments: '4', buffer: isWifiFriendly ? '4M' : '8M', retries: '25', conn: '4' },
          balanced: { fragments: isWifiFriendly ? '6' : '10', buffer: isWifiFriendly ? '4M' : '16M', retries: '25', conn: isWifiFriendly ? '6' : '10' },
          fast: { fragments: isWifiFriendly ? '8' : '16', buffer: isWifiFriendly ? '8M' : '32M', retries: '20', conn: isWifiFriendly ? '8' : '16' }
        };
        const fallback = fallbackProfiles[biliMode] || fallbackProfiles.fast;
        const requestedWorkers = Math.max(1, parseInt(settings.bilibiliThreads || settings.threads || fallback.conn, 10));
        const numConn = Math.min(16, Math.max(4, requestedWorkers));
        const numFrags = String(numConn);

        this.emitLog('info', `yt-dlp Bilibili configured: mode=${biliMode} (${numConn} connections/fragments, buffer=${fallback.buffer}, Wi-Fi Friendly=${isWifiFriendly ? 'ON' : 'OFF'}, limit=${perItemLimitMB > 0 ? perItemLimitMB + 'M' : 'Uncapped'})`, {
          itemId: item.id,
          mode: biliMode,
          fragments: numFrags,
          limitRate: perItemLimitMB
        });

        if (aria2cExe && fs.existsSync(aria2cExe) && !sectionSpec) {
          args.push('--downloader', 'aria2c');
          args.push('--downloader-args', `aria2c:-c -x ${numConn} -s ${numConn} -j 4 -k 1M --min-split-size=1M --max-connection-per-server=${numConn} --lowest-speed-limit=20K --timeout=15 --retry-wait=2`);
          usesExternalDownloader = true;
        }
        args.push('--downloader', 'dash,m3u8:native');
        args.push('--concurrent-fragments', numFrags);
        args.push('--buffer-size', fallback.buffer);
        args.push('--file-access-retries', fallback.retries);
        args.push('--retries', fallback.retries);
        args.push('--fragment-retries', fallback.retries);
        if (perItemLimitMB > 0) args.push('--limit-rate', `${perItemLimitMB}M`);
      } else if (isYouTube) {
        // High-speed optimized YouTube downloader: concurrent fragments, 10M chunking and 32M buffer
        const userThreads = parseInt(settings.threads || 16, 10);
        const numFrags = String(isWifiFriendly ? Math.min(8, Math.max(4, userThreads)) : Math.min(16, Math.max(4, userThreads)));
        const bufSize = isWifiFriendly ? '4M' : '32M';
        args.push('--downloader', 'dash,m3u8:native');
        args.push('--concurrent-fragments', numFrags);
        args.push('--buffer-size', bufSize);
        args.push('--http-chunk-size', '10M');
        args.push('--file-access-retries', '25');
        args.push('--retries', '25');
        args.push('--fragment-retries', '25');
        if (perItemLimitMB > 0) args.push('--limit-rate', `${perItemLimitMB}M`);
        this.emitLog('info', `Using accelerated native yt-dlp downloader (${numFrags} fragments, 10M chunks, ${bufSize} buffer, limit=${perItemLimitMB > 0 ? perItemLimitMB + 'M' : 'Uncapped'}) for YouTube item ${item.id}`, { itemId: item.id });
      } else if (isOdysee) {
        // High-reliability native yt-dlp downloader for Odysee / LBRY streams
        args.push('--buffer-size', isWifiFriendly ? '4M' : '16M');
        args.push('--file-access-retries', '25');
        args.push('--retries', '25');
        args.push('--fragment-retries', '25');
        if (perItemLimitMB > 0) args.push('--limit-rate', `${perItemLimitMB}M`);
        this.emitLog('info', `Using resilient native yt-dlp downloader for Odysee item ${item.id}`, { itemId: item.id });
      } else if (isDashOrHls) {
        // High-speed fragments for generic DASH / HLS streams
        const userThreads = parseInt(settings.threads || 16, 10);
        const numFrags = String(isWifiFriendly ? Math.min(8, Math.max(4, userThreads)) : Math.min(16, Math.max(4, userThreads)));
        args.push('--downloader', 'dash,m3u8:native');
        args.push('--concurrent-fragments', numFrags);
        args.push('--buffer-size', isWifiFriendly ? '4M' : '16M');
        args.push('--file-access-retries', '25');
        args.push('--retries', '25');
        args.push('--fragment-retries', '25');
        if (perItemLimitMB > 0) args.push('--limit-rate', `${perItemLimitMB}M`);
        this.emitLog('info', `Using accelerated native yt-dlp downloader (${numFrags} fragments) for DASH/HLS item ${item.id}`, { itemId: item.id });
      } else if (sectionSpec) {
        // Native / ffmpeg downloader for precise section download
        args.push('--downloader', 'dash,m3u8:native');
        args.push('--buffer-size', isWifiFriendly ? '4M' : '16M');
        args.push('--file-access-retries', '20');
        args.push('--retries', '20');
        args.push('--fragment-retries', '20');
        if (perItemLimitMB > 0) args.push('--limit-rate', `${perItemLimitMB}M`);
        this.emitLog('info', `Using native ffmpeg section downloader for item ${item.id} (${sectionSpec})`, { itemId: item.id });
      } else {
        // Tuned connections and min-split for direct static HTTP files via aria2c
        const numThreads = isWifiFriendly ? Math.min(8, Math.max(4, parseInt(settings.threads || 8, 10))) : Math.min(16, Math.max(4, parseInt(settings.threads || 16, 10)));
        let aria2Args = `-c -x ${numThreads} -s ${numThreads} -j 4 -k 1M --min-split-size=1M --max-connection-per-server=${numThreads} --timeout=30 --retry-wait=2`;
        if (perItemLimitMB > 0) aria2Args += ` --max-download-limit=${perItemLimitMB}M`;
        args.push('--downloader', aria2cExe);
        args.push('--downloader-args', `aria2c:${aria2Args}`);
        usesExternalDownloader = true;
        args.push('--downloader', 'dash,m3u8:native');
        args.push('--concurrent-fragments', String(numThreads));
        args.push('--buffer-size', isWifiFriendly ? '4M' : '16M');
        args.push('--file-access-retries', '20');
        args.push('--retries', '20');
        args.push('--fragment-retries', '20');
        if (perItemLimitMB > 0) args.push('--limit-rate', `${perItemLimitMB}M`);
        this.emitLog('info', `Using aria2c accelerator (${numThreads} connections, limit=${perItemLimitMB > 0 ? perItemLimitMB + 'M' : 'Uncapped'}) for item ${item.id}`, { itemId: item.id });
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
        
        const codecPref = (settings.videoCodec || 'quality').toLowerCase();
        let formatFilter = '';
        if (isOdysee) {
          formatFilter = 'bestvideo+bestaudio/best/original';
        } else if (qualitySetting.includes('1080') || qualitySetting === '1080p') {
          if (codecPref === 'compatible') {
            formatFilter = isBilibili 
              ? 'bv*[height<=1080][vcodec^=avc]+ba/bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b/best'
              : 'bestvideo[height<=1080][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
          } else if (codecPref === 'efficient') {
            formatFilter = isBilibili 
              ? 'bv*[height<=1080][vcodec^=hev]+ba/bv*[height<=1080][vcodec^=av01]+ba/bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/best'
              : 'bestvideo[height<=1080][vcodec^=av01]+bestaudio/bestvideo[height<=1080][vcodec^=vp9]+bestaudio/bestvideo[height<=1080][vcodec^=hev]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
          } else {
            // 'quality' (Default): Prioritize highest bitrate at 1080p (AVC high-bitrate first on Bilibili)
            formatFilter = isBilibili 
              ? 'bv*[height<=1080][vcodec^=avc]+ba/bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b/best'
              : 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
          }
        } else if (qualitySetting.includes('720') || qualitySetting === '720p') {
          if (codecPref === 'compatible') {
            formatFilter = isBilibili
              ? 'bv*[height<=720][vcodec^=avc]+ba/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b/best'
              : 'bestvideo[height<=720][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best';
          } else if (codecPref === 'efficient') {
            formatFilter = isBilibili
              ? 'bv*[height<=720][vcodec^=hev]+ba/bv*[height<=720][vcodec^=av01]+ba/bv*[height<=720]+ba/b[height<=720]/best'
              : 'bestvideo[height<=720][vcodec^=av01]+bestaudio/bestvideo[height<=720][vcodec^=vp9]+bestaudio/bestvideo[height<=720]+bestaudio/best[height<=720]/best';
          } else {
            formatFilter = isBilibili
              ? 'bv*[height<=720][vcodec^=avc]+ba/bv*[height<=720]+ba/b[height<=720]/bv*+ba/b/best'
              : 'bestvideo[height<=720]+bestaudio/best[height<=720]/best';
          }
        } else if (qualitySetting.includes('480') || qualitySetting === '480p') {
          formatFilter = isBilibili
            ? 'bv*[height<=480]+ba/b[height<=480]/bv*+ba/best'
            : 'bestvideo[height<=480]+bestaudio/best[height<=480]/best';
        } else if (qualitySetting.includes('1440') || qualitySetting === '1440p' || qualitySetting.includes('2k')) {
          formatFilter = isBilibili
            ? 'bv*[height<=1440]+ba/bv*[height<=1440]+ba/b[height<=1440]/bv*+ba/best'
            : 'bestvideo[height<=1440]+bestaudio/best';
        } else if (qualitySetting.includes('2160') || qualitySetting.includes('4k')) {
          formatFilter = isBilibili
            ? 'bv*[height<=2160]+ba/bv*[height<=2160]+ba/b[height<=2160]/bv*+ba/best'
            : 'bestvideo[height<=2160]+bestaudio/best';
        } else {
          // Highest Available (Original / 4K / 1080p+ / 8K)
          if (codecPref === 'compatible') {
            formatFilter = isBilibili
              ? 'bv*[vcodec^=avc]+ba/bv*+ba/b/best'
              : 'bestvideo[vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/b/best';
          } else if (codecPref === 'efficient') {
            formatFilter = isBilibili
              ? 'bv*[vcodec^=hev]+ba/bv*[vcodec^=av01]+ba/bv*+ba/b/best'
              : 'bestvideo[vcodec^=av01]+bestaudio/bestvideo[vcodec^=vp9]+bestaudio/bestvideo+bestaudio/b/best';
          } else {
            // 'quality' (Default): Highest bitrate format available
            formatFilter = isBilibili
              ? 'bv*+ba/b/best'
              : 'bestvideo+bestaudio/best';
          }
        }

        args.push('-f', formatFilter);
        args.push('--merge-output-format', mergeFormat);
        const muxingPostArgs = mergeFormat === 'mp4'
          ? 'Merger:-movflags +faststart -max_muxing_queue_size 9999'
          : 'Merger:-max_muxing_queue_size 9999';
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
          const ariaMatch = line.match(/\[#\w+\s+([\d\.]+)([KMG]i?B)\/([\d\.]+)([KMG]i?B)\(([\d\.]+)%\).*?DL:([\d\.]+)([KMG]i?B)/i);

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
              percentage = Math.min(99, Math.round(parseFloat(ariaMatch[5])));
              const rawAria = parseFloat(ariaMatch[1]);
              const ariaUnit = (ariaMatch[2] || '').toUpperCase();
              if (ariaUnit.includes('G')) downloadedMB = (rawAria * 1024).toFixed(2);
              else if (ariaUnit.includes('K')) downloadedMB = (rawAria / 1024).toFixed(2);
              else downloadedMB = rawAria.toFixed(2);
              val = ariaMatch[6];
              unit = ariaMatch[7] ? ariaMatch[7].toUpperCase() + '/S' : null;
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
          this.decrementRunning(item);
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
          this.checkAndFillPools(settings);
          this.checkQueueCompleted();
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
          if (!isDone) {
            isDone = true;
            this.decrementRunning(item);
            this.emit('item-progress', { id: item.id, status: 'Cancelled (Paused)' });
            this.emitLog('warn', `yt-dlp cancelled for item ${item.id} (partial download preserved for resume)`, { itemId: item.id, exitCode: code });
            this.checkQueueCompleted();
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

        // If actual file was produced but is corrupted or incomplete, remove it
        if (actualFilePath && !isFileValid) {
          this.emitLog('warn', `yt-dlp produced an invalid or incomplete video file (${path.basename(actualFilePath)}, exitCode=${code}, valid=false). Removing broken file to protect user playback.`, {
            itemId: item.id,
            exitCode: code,
            filePath: actualFilePath
          });
          try { fs.unlinkSync(actualFilePath); } catch (e) {}
          actualFilePath = null;
        }

        if (actualFilePath && isFileValid) {
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
                if (effectiveTimeRange && sectionSpec) {
                  this.trimSubtitleToTimeRange(subtitlePath, effectiveTimeRange, item.durationSeconds || this.parseTimeToSeconds(item.duration));
                }
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
                  if (effectiveTimeRange && sectionSpec) {
                    this.trimSubtitleToTimeRange(subFiles[0], effectiveTimeRange, item.durationSeconds || this.parseTimeToSeconds(item.duration));
                  }
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
            this.decrementRunning(item);
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
            this.checkAndFillPools(settings);
            this.checkQueueCompleted();
            resolve();
          }
        }
      });
    });
  }

  async probeBilibiliMirrors(urls, headers, controller) {
    if (!Array.isArray(urls) || urls.length === 0) return urls || [];
    const rawCandidates = [...urls].filter(Boolean);
    if (rawCandidates.length === 0) return [];

    // Trusted, high-bandwidth UPOS hosts that DO NOT throttle sustained video downloads
    const FAST_UPOS_HOSTS = [
      'upos-sz-mirroraliov.bilivideo.com', // Alibaba Cloud Global / Overseas (Fastest & Most reliable worldwide)
      'upos-sz-mirrorali.bilivideo.com',   // Alibaba Cloud Mainland
      'upos-sz-mirrorcoso1.bilivideo.com', // Tencent Cloud Mirror 1 (High capacity, excellent speeds)
      'upos-sz-mirrorcosov.bilivideo.com', // Tencent Cloud Overseas
      'upos-sz-mirrorhw.bilivideo.com',    // Huawei Cloud
      'upos-sz-mirrorcos.bilivideo.com'    // Tencent Cloud Standard
    ];

    const candidates = [];
    const seenHosts = new Set();

    // 1. Generate URLs for fast UPOS hosts using path/query from primary URL
    try {
      const sample = new URL(rawCandidates[0]);
      for (const fastHost of FAST_UPOS_HOSTS) {
        if (!seenHosts.has(fastHost)) {
          seenHosts.add(fastHost);
          const alt = new URL(sample.toString());
          alt.hostname = fastHost;
          candidates.push(alt.toString());
        }
      }
    } catch (e) {}

    // 2. Include raw candidate URLs if they are NOT known throttling hosts (akamaized / mcdn)
    for (const rawUrl of rawCandidates) {
      try {
        const u = new URL(rawUrl);
        const host = u.hostname.toLowerCase();
        // Skip akamaized (throttles to 0.01MB/s after 3min) and mcdn (PCDN aggressive throttling)
        if (host.includes('akamaized.net') || host.includes('mcdn.bilivideo.cn')) {
          continue;
        }
        if (!seenHosts.has(host)) {
          seenHosts.add(host);
          candidates.push(rawUrl);
        }
      } catch (e) {}
    }

    if (candidates.length === 0) {
      candidates.push(...rawCandidates);
    }

    // 3. Probe candidates with 2KB range test (3500ms timeout)
    const probePromises = candidates.map(async (url) => {
      const start = Date.now();
      try {
        const res = await axios({
          method: 'GET',
          url,
          headers: { ...headers, Range: 'bytes=0-2048' },
          timeout: 3500,
          responseType: 'arraybuffer',
          signal: controller?.signal,
          httpAgent: HTTP_AGENT,
          httpsAgent: HTTPS_AGENT,
          validateStatus: (status) => status === 200 || status === 206
        });
        const latency = Date.now() - start;
        const valid = (res.status === 200 || res.status === 206) && res.data && res.data.byteLength > 0;
        return { url, latency, ok: valid };
      } catch (e) {
        return { url, latency: 99999, ok: false };
      }
    });

    try {
      const results = await Promise.all(probePromises);
      const healthy = results.filter(r => r.ok).sort((a, b) => a.latency - b.latency);
      if (healthy.length > 0) {
        // Return ONLY verified healthy URLs, fastest first!
        return healthy.map(h => h.url);
      }
    } catch (e) {}

    // Safe fallback: prioritize aliov, then raw candidates
    try {
      const fallbackUrl = new URL(rawCandidates[0]);
      fallbackUrl.hostname = 'upos-sz-mirroraliov.bilivideo.com';
      return [fallbackUrl.toString(), ...rawCandidates];
    } catch(e) {
      return rawCandidates;
    }
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

    const videoTemp = filePath + '.video.m4s';
    const audioTemp = filePath + '.audio.m4s';

    try {
      const hasExistingResume = fs.existsSync(videoTemp) || fs.existsSync(audioTemp) || fs.existsSync(videoTemp + '.aria2');
      logPhase('info', `${hasExistingResume ? 'Resuming' : 'Starting'} Bilibili DASH download: ${path.basename(filePath)}`);
      this.emit('item-progress', {
        id: item.id,
        status: hasExistingResume ? 'Resuming DASH download...' : 'Fetching DASH manifest...',
        percentage: item.percentage && item.percentage > 0 ? item.percentage : 1,
        downloadedMB: item.downloadedMB && item.downloadedMB !== '0.00' ? item.downloadedMB : '0.00',
        speedMbps: '0.00'
      });

      let bvidMatch = targetUrl.match(/BV[0-9a-zA-Z]+/i);
      let aidMatch = targetUrl.match(/av([0-9]+)/i);
      const pageMatch = targetUrl.match(/[?&]p=([0-9]+)/i);
      const pageNum = pageMatch ? parseInt(pageMatch[1], 10) : (item && item.page ? item.page : 1);

      if (!bvidMatch && !aidMatch) throw new Error("Invalid Bilibili URL");

      let cid = item && item.cid ? item.cid : null;
      if (!cid) {
        const pagelistUrl = bvidMatch 
          ? `https://api.bilibili.com/x/player/pagelist?bvid=${bvidMatch[0]}`
          : `https://api.bilibili.com/x/player/pagelist?aid=${aidMatch[1]}`;

        const pagelistStart = Date.now();
        const listRes = await axios.get(pagelistUrl, { headers, timeout: 15000 });
        if (!listRes.data || listRes.data.code !== 0 || !listRes.data.data) {
          throw new Error("Failed to get pagelist: " + (listRes.data ? listRes.data.message : ''));
        }
        const pageEntry = listRes.data.data.find(e => e.page === pageNum) || listRes.data.data[0];
        cid = pageEntry ? pageEntry.cid : null;
        logPhase('info', `Pagelist ready in ${Date.now() - pagelistStart}ms (cid=${cid}, page=${pageNum})`);
      } else {
        logPhase('info', `Using pre-resolved CID (cid=${cid}, page=${pageNum})`);
      }

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
        
        const qualitySetting = String(settings.fileType || settings.videoQuality || '').toLowerCase();
        let maxHeight = 99999;
        if (qualitySetting.includes('480') || qualitySetting === '480p') maxHeight = 480;
        else if (qualitySetting.includes('720') || qualitySetting === '720p') maxHeight = 720;
        else if (qualitySetting.includes('1080') || qualitySetting === '1080p') maxHeight = 1080;
        else if (qualitySetting.includes('1440') || qualitySetting === '1440p' || qualitySetting.includes('2k')) maxHeight = 1440;
        else if (qualitySetting.includes('2160') || qualitySetting === '4k') maxHeight = 2160;

        // Filter candidate videos that fit within maxHeight (e.g. 1440p / 2K, 4K, 1080p)
        const matchingVideos = dash.video.filter(v => (v.height || 0) <= maxHeight);
        const candidateVideos = matchingVideos.length > 0 ? matchingVideos : dash.video;

        // 1. Group by highest resolution / quality tier (e.g. 127:8K, 120:4K, 116:1080p60, 112:1080p+, 80:1080p, 64:720p)
        const sorted = [...candidateVideos].sort((a, b) => (b.id || 0) - (a.id || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
        const topId = sorted[0].id;
        const topTracks = sorted.filter(v => v.id === topId);

        const codecPref = (settings.videoCodec || 'quality').toLowerCase();

        if (codecPref === 'compatible') {
          // Explicitly prefer AVC / H.264 for maximum compatibility
          return topTracks.find(v => v.codecs && v.codecs.startsWith('avc'))
              || topTracks.find(v => v.codecs && (v.codecs.startsWith('hvc') || v.codecs.startsWith('hev')))
              || topTracks.find(v => v.codecs && v.codecs.startsWith('av01'))
              || topTracks[0];
        } else if (codecPref === 'efficient') {
          // Explicitly prefer HEVC/AV1 for smaller file size, picking highest bitrate among them
          const efficientTracks = topTracks.filter(v => v.codecs && (v.codecs.startsWith('hvc') || v.codecs.startsWith('hev') || v.codecs.startsWith('av01')));
          if (efficientTracks.length > 0) {
            return efficientTracks.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
          }
          return topTracks[0];
        } else {
          // 'quality' (Smart Bitrate & Quality Selection - Default):
          // Compare actual bitrates across AVC, HEVC, and AV1 variants.
          // Never blindly do "AV1 first -> therefore best" when Bilibili heavily starves AV1 bitrate!
          const avcTrack = topTracks.find(v => v.codecs && v.codecs.startsWith('avc'));
          const hevcTrack = topTracks.find(v => v.codecs && (v.codecs.startsWith('hvc') || v.codecs.startsWith('hev')));
          const av1Track = topTracks.find(v => v.codecs && v.codecs.startsWith('av01'));

          const avcBw = avcTrack ? (avcTrack.bandwidth || 0) : 0;
          const hevcBw = hevcTrack ? (hevcTrack.bandwidth || 0) : 0;
          const av1Bw = av1Track ? (av1Track.bandwidth || 0) : 0;

          // Perceptual quality weighting: HEVC delivers ~50% better compression than AVC, AV1 ~60%.
          // When bitrates are comparable, HEVC/AV1 delivers equal or superior detail at half the file size.
          const avcScore = avcBw * 1.0;
          const hevcScore = hevcBw * 2.0;
          const av1Score = av1Bw * 2.5;

          const candidates = [];
          if (avcTrack) candidates.push({ track: avcTrack, score: avcScore, bw: avcBw, name: 'AVC' });
          if (hevcTrack) candidates.push({ track: hevcTrack, score: hevcScore, bw: hevcBw, name: 'HEVC' });
          if (av1Track) candidates.push({ track: av1Track, score: av1Score, bw: av1Bw, name: 'AV1' });

          if (candidates.length > 0) {
            candidates.sort((a, b) => b.score - a.score || b.bw - a.bw);
            const winner = candidates[0];
            logPhase('info', `Smart Quality Selection: Chose ${winner.name} (${Math.round(winner.bw / 1000)} kbps) for top visual fidelity [Score: ${Math.round(winner.score)}]`);
            return winner.track;
          }

          return topTracks[0];
        }
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

      let totalBytes = 0;
      let downloadedBytes = 0;

      const downloadStream = async (type, getUrlsFn, tempPath) => {
        const streamStartedAt = Date.now();
        let streamUrls = await getUrlsFn(false);
        if (!Array.isArray(streamUrls) || streamUrls.length === 0) {
          throw new Error(`Failed to resolve stream URLs for ${type}`);
        }
        let streamTotalBytes = 0;
        logPhase('info', `${type} stream URLs resolved (${streamUrls.length} mirror(s): ${streamUrls.map(u => { try { return new URL(u).hostname; } catch(e){ return 'mirror'; } }).join(', ')})`);

        for (const probeCandidate of streamUrls) {
          try {
            const headRes = await axios({
              method: 'HEAD',
              url: probeCandidate,
              timeout: 10000,
              headers,
              signal: controller.signal,
              httpAgent: HTTP_AGENT,
              httpsAgent: HTTPS_AGENT
            });
            streamTotalBytes = parseInt(headRes.headers['content-length'], 10) || 0;
            if (streamTotalBytes > 0) break;
          } catch (e) {
            try {
              const probeRes = await axios({
                method: 'GET',
                url: probeCandidate,
                timeout: 10000,
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
              if (streamTotalBytes > 0) break;
            } catch (probeErr) {}
          }
        }

        if (!streamTotalBytes) {
          throw new Error(`Failed to get stream info for ${type}`);
        }
        
        totalBytes += streamTotalBytes;
        logPhase('info', `${type} stream size detected: ${(streamTotalBytes / (1024 * 1024)).toFixed(2)} MB`);

        // Adaptive high-performance aria2c engine integration
        const aria2cExe = this.getBinPath('aria2c.exe');
        if (aria2cExe && fs.existsSync(aria2cExe) && Array.isArray(streamUrls) && streamUrls.length > 0) {
          let ariaSuccess = false;
          const maxAriaAttempts = 2;

          for (let attempt = 1; attempt <= maxAriaAttempts; attempt++) {
            if (this.isCancelled) break;
            try {
              if (attempt > 1) {
                logPhase('info', `Refreshing Bilibili stream URLs and tokens for aria2c retry ${attempt}/${maxAriaAttempts}`);
                try {
                  const fresh = await getUrlsFn(true);
                  if (Array.isArray(fresh) && fresh.length > 0) streamUrls = fresh;
                } catch (e) {}
              }

              const requestedThreads = parseInt(settings.threads || settings.bilibiliThreads || 4, 10);
              const connections = type === 'audio'
                ? Math.min(2, Math.max(1, requestedThreads))
                : Math.min(6, Math.max(2, requestedThreads));

              logPhase('info', `Accelerating ${type} stream with aria2c (${connections} connections, attempt ${attempt}/${maxAriaAttempts})`);
              const ariaFilename = path.basename(tempPath);
              const ariaDir = path.dirname(tempPath);
              const targetMirrorUrls = streamUrls.filter(Boolean);
              const ariaArgs = [
                '-x', String(connections),
                '-s', String(connections),
                '-j', '4',
                '-k', '1M',
                '--min-split-size=1M',
                '--max-connection-per-server=' + String(connections),
                '--file-allocation=none',
                '--continue=true',
                '--max-tries=15',
                '--retry-wait=2',
                '--summary-interval=1',
                '--lowest-speed-limit=20K',
                '--timeout=15',
                '--connect-timeout=10',
                '--header', `User-Agent: ${userAgent}`,
                '--header', `Referer: ${this.getBilibiliReferer(item)}`,
                '--header', 'Origin: https://www.bilibili.com',
                '-d', ariaDir,
                '-o', ariaFilename,
                '--auto-file-renaming=false',
                '--allow-overwrite=true'
              ];
              if (cookieHeader) {
                ariaArgs.push('--header', `Cookie: ${cookieHeader}`);
              }
              if (settings.speedLimitMB && settings.speedLimitMB > 0) {
                ariaArgs.push(`--max-download-limit=${settings.speedLimitMB}M`);
              }
              // Prioritize the top verified mirror URL; if a backup shares the same host, add it
              if (targetMirrorUrls.length > 0) {
                ariaArgs.push(targetMirrorUrls[0]);
                if (targetMirrorUrls.length > 1 && targetMirrorUrls[1]) {
                  try {
                    const host0 = new URL(targetMirrorUrls[0]).hostname;
                    const host1 = new URL(targetMirrorUrls[1]).hostname;
                    if (host0 === host1) {
                      ariaArgs.push(targetMirrorUrls[1]);
                    }
                  } catch (e) {}
                }
              }

              const { spawn } = require('child_process');
              const ariaProc = spawn(aria2cExe, ariaArgs);
              const abortHandler = () => {
                try { ariaProc.kill('SIGINT'); } catch(e){}
              };
              if (controller && controller.signal) {
                controller.signal.addEventListener('abort', abortHandler);
              }

              let prevDownloaded = 0;
              ariaProc.stdout.on('data', d => {
                const str = d.toString();
                let curBytes = 0;
                const detailedMatch = str.match(/\[#\w+\s+([\d\.]+)([KMG]i?B)\/([\d\.]+)([KMG]i?B)/i);
                if (detailedMatch) {
                  const num = parseFloat(detailedMatch[1]);
                  const u = detailedMatch[2].toUpperCase();
                  if (u.includes('G')) curBytes = Math.round(num * 1024 * 1024 * 1024);
                  else if (u.includes('M')) curBytes = Math.round(num * 1024 * 1024);
                  else if (u.includes('K')) curBytes = Math.round(num * 1024);
                  else curBytes = Math.round(num);
                } else {
                  const match = str.match(/\((\d+)%\)/);
                  if (match) {
                    const pct = parseInt(match[1], 10);
                    curBytes = Math.round((pct / 100) * streamTotalBytes);
                  }
                }
                if (curBytes > prevDownloaded) {
                  const delta = curBytes - prevDownloaded;
                  prevDownloaded = curBytes;
                  downloadedBytes += delta;
                }
              });

              await new Promise((resAria, rejAria) => {
                ariaProc.on('close', code => {
                  if (controller && controller.signal) {
                    controller.signal.removeEventListener('abort', abortHandler);
                  }
                  if (this.isCancelled) {
                    logPhase('info', `aria2c stopped by user; preserving partial download and control file for resume`);
                    resAria();
                    return;
                  }
                  const minExpected = Math.floor(streamTotalBytes * 0.95);
                  const ariaControl = tempPath + '.aria2';
                  const ariaStillPresent = fs.existsSync(ariaControl);
                  if (code === 0 && fs.existsSync(tempPath) && !ariaStillPresent && fs.statSync(tempPath).size >= minExpected) {
                    downloadedBytes += Math.max(0, streamTotalBytes - prevDownloaded);
                    logPhase('info', `aria2c completed ${type} stream successfully`);
                    ariaSuccess = true;
                    resAria();
                  } else {
                    rejAria(new Error(`aria2c exited with code ${code}${ariaStillPresent ? ' (aria2 control file still exists, stream incomplete)' : ''}`));
                  }
                });
                ariaProc.on('error', rejAria);
              });

              if (this.isCancelled || ariaSuccess) break;
            } catch (ariaErr) {
              if (this.isCancelled) return;
              logPhase('warn', `aria2c attempt ${attempt} encountered an issue: ${ariaErr.message}`);
              if (attempt >= maxAriaAttempts) {
                logPhase('warn', `aria2c retries exhausted for ${type}, falling back to native chunk pipeline (preserving existing downloaded data)`);
              }
            }
          }

          if (ariaSuccess || this.isCancelled) return;
        }

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
            if (fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0 && !fs.existsSync(tempPath + '.aria2')) {
              sharedFd = fs.openSync(tempPath, 'r+');
            } else {
              sharedFd = fs.openSync(tempPath, 'w+');
              if (streamTotalBytes > 0) fs.ftruncateSync(sharedFd, streamTotalBytes);
            }
          }
        } catch (e) {
          if (sharedFd !== null) fs.closeSync(sharedFd);
          throw e;
        }

        const tuning = this.getBilibiliDashTuning(streamTotalBytes, type, settings);
        if (chunks.length === 0) {
          logPhase('info', `${type} stream tuned for ${tuning.workerCount} worker(s), chunk ${(tuning.chunkBytes / (1024 * 1024)).toFixed(2)} MB across ${streamUrls.length} mirror(s)`);
          const chunkSize = tuning.chunkBytes;
          for (let i = 0, startByte = 0; startByte < streamTotalBytes; i++, startByte += chunkSize) {
            if (startByte >= streamTotalBytes) break;
            const endByte = Math.min((i + 1) * chunkSize - 1, streamTotalBytes - 1);
            chunks.push({ startByte, endByte, downloaded: 0, inProgress: false });
          }
        }

        let refreshPromise = null;
        const refreshUrls = async (force = false) => {
          if (refreshPromise) return refreshPromise;
          refreshPromise = (async () => {
            try {
              const fresh = await getUrlsFn(force);
              if (Array.isArray(fresh) && fresh.length > 0) {
                streamUrls = fresh;
              }
              return streamUrls;
            } finally {
              refreshPromise = null;
            }
          })();
          return refreshPromise;
        };

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

            let failureCount = 0;

            while (true) {
              if (this.isCancelled) break;
              const currentStart = chunk.startByte + chunk.downloaded;
              if (currentStart > chunk.endByte) break;

              // Stick to assigned mirror URL for this worker to prevent CDN Range snapping shifts
              let workerUrl = streamUrls[workerIndex % streamUrls.length];
              if (failureCount > 2) {
                // Persistent failure on assigned mirror: switch mirror and preserve downloaded progress
                workerUrl = streamUrls[(workerIndex + failureCount) % streamUrls.length];
              }

              let response = null;
              try {
                const chunkHeaders = { ...headers, 'Range': `bytes=${currentStart}-${chunk.endByte}` };
                response = await axios({
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
                  chunk.downloaded = 0;
                  throw new Error('Server returned full stream (200 OK) instead of partial range (206)');
                }

                // Verify Content-Range header to guarantee alignment with requested byte range
                const contentRange = response.headers['content-range'];
                if (contentRange) {
                  const rangeMatch = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
                  if (rangeMatch) {
                    const serverStart = parseInt(rangeMatch[1], 10);
                    if (serverStart !== currentStart) {
                      chunk.downloaded = 0;
                      throw new Error(`Content-Range start mismatch: requested ${currentStart}, server returned ${serverStart}. Resetting chunk to start.`);
                    }
                  }
                }

                await new Promise((resolveChunk, rejectChunk) => {
                  const stream = response.data;
                  let pendingBuffers = [];
                  let pendingBytes = 0;
                  let lastFlush = Date.now();
                  let stallTimer = null;
                  let settled = false;

                  const cleanup = () => {
                    if (stallTimer) {
                      clearTimeout(stallTimer);
                      stallTimer = null;
                    }
                    if (stream) {
                      stream.removeAllListeners('data');
                      stream.removeAllListeners('end');
                      stream.removeAllListeners('error');
                      stream.removeAllListeners('close');
                    }
                  };

                  const abortConnection = (err) => {
                    cleanup();
                    // Drop unflushed unverified partial buffers on abort/error to maintain clean byte alignment
                    pendingBuffers = [];
                    pendingBytes = 0;
                    try {
                      if (response && response.request) {
                        if (response.request.socket && !response.request.socket.destroyed) {
                          response.request.socket.destroy();
                        }
                        if (!response.request.destroyed) {
                          response.request.destroy();
                        }
                      }
                    } catch (e) {}
                    try {
                      if (stream && !stream.destroyed) {
                        stream.destroy(err);
                      }
                    } catch (e) {}
                  };

                  const resetStallTimer = () => {
                    if (stallTimer) clearTimeout(stallTimer);
                    stallTimer = setTimeout(() => {
                      if (settled) return;
                      settled = true;
                      const stallErr = new Error('Connection data stall (15s inactivity)');
                      abortConnection(stallErr);
                      rejectChunk(stallErr);
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
                    if (this.isCancelled) {
                      settled = true;
                      abortConnection(new Error('Cancelled'));
                      return;
                    }
                    try {
                      pendingBuffers.push(buffer);
                      pendingBytes += buffer.length;

                      if (this.bandwidthLimiter && this.bandwidthLimiter.isEnabled()) {
                        const throttleDelayMs = this.bandwidthLimiter.consume(buffer.length);
                        if (throttleDelayMs > 0) {
                          stream.pause();
                          setTimeout(() => {
                            if (!settled && stream && !stream.destroyed) {
                              try { stream.resume(); } catch (e) {}
                            }
                          }, throttleDelayMs);
                        }
                      }

                      const flushAge = Date.now() - lastFlush;
                      if (pendingBytes >= tuning.flushThresholdBytes || flushAge >= tuning.flushIntervalMs) {
                        flushPending();
                      } else if (pendingBytes >= tuning.maxBufferedBytes) {
                        stream.pause();
                        flushPending();
                        stream.resume();
                      }
                    } catch (e) {
                      if (!settled) {
                        settled = true;
                        abortConnection(e);
                        rejectChunk(e);
                      }
                    }
                  });

                  stream.on('end', () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    try {
                      flushPending();
                      const expectedTotal = chunk.endByte - chunk.startByte + 1;
                      if (chunk.downloaded < expectedTotal) {
                        abortConnection(new Error(`Stream ended prematurely: ${chunk.downloaded}/${expectedTotal} bytes`));
                        rejectChunk(new Error(`Stream ended prematurely: ${chunk.downloaded}/${expectedTotal} bytes`));
                      } else {
                        resolveChunk();
                      }
                    } catch (e) {
                      abortConnection(e);
                      rejectChunk(e);
                    }
                  });

                  stream.on('error', (err) => {
                    if (settled) return;
                    settled = true;
                    abortConnection(err);
                    rejectChunk(err);
                  });
                });
                break; // Chunk succeeded!
              } catch (err) {
                // Ensure socket is destroyed on any catch to eliminate connection reuse desync
                try {
                  if (response && response.request) {
                    if (response.request.socket && !response.request.socket.destroyed) {
                      response.request.socket.destroy();
                    }
                    if (!response.request.destroyed) {
                      response.request.destroy();
                    }
                  }
                } catch (e) {}
                if (axios.isCancel(err) || this.isCancelled) break;
                failureCount++;
                logPhase('warn', `${type} worker chunk [${chunk.startByte}-${chunk.endByte}] retry ${failureCount}/${tuning.maxChunkRetries}: ${err.message}`, {
                  workerIndex,
                  failureCount,
                  error: err.message
                });

                // Failover to alternative mirror and refresh DASH manifest if retries persist
                if (failureCount > 2) {
                  try {
                    await refreshUrls(true);
                  } catch (e) {}
                }

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

        try {
          await Promise.all(workerPromises);
        } finally {
          clearInterval(stateInterval);
          if (sharedFd !== null) {
            try { fs.closeSync(sharedFd); sharedFd = null; } catch(e) {}
          }
          if (chunks.length > 0) {
            try {
              fs.writeFileSync(stateFile, JSON.stringify({
                streamTotalBytes,
                chunks: chunks.map(c => ({ startByte: c.startByte, endByte: c.endByte, downloaded: c.downloaded }))
              }), 'utf8');
            } catch(e) {}
          }
        }
        
        if (!this.isCancelled) {
          const totalExpected = chunks.reduce((acc, c) => acc + (c.endByte - c.startByte + 1), 0);
          if (totalExpected === totalGot) {
             if (fs.existsSync(stateFile)) { try { fs.unlinkSync(stateFile); } catch(e){} }
             if (fs.existsSync(tempPath + '.aria2')) { try { fs.unlinkSync(tempPath + '.aria2'); } catch(e){} }
          }
          if (streamTotalBytes > 0 && totalGot < totalExpected) {
            throw new Error(`${type} stream incomplete: received ${totalGot} of ${totalExpected} bytes`);
          }
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

      const getVidUrls = async (force = false) => { 
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
        let urls = [vTrack.baseUrl, ...(vTrack.backupUrl || []), ...(vTrack.backup_url || [])].filter(Boolean);
        return await this.probeBilibiliMirrors(urls, headers, controller);
      };
      const getAudUrls = async (force = false) => { 
        await getDashUrls(force); 
        let aTrack = null;
        if (cachedDash && Array.isArray(cachedDash.audio)) {
          if (lockedAudioId) {
            aTrack = cachedDash.audio.find(a => a.id === lockedAudioId);
          }
          if (!aTrack) aTrack = getBestAudioTrack(cachedDash);
        }
        if (!aTrack) return null;
        let urls = [aTrack.baseUrl, ...(aTrack.backupUrl || []), ...(aTrack.backup_url || [])].filter(Boolean);
        return await this.probeBilibiliMirrors(urls, headers, controller);
      };

      const isMp3 = String(settings.fileType || '').toLowerCase().includes('mp3') ||
                    String(settings.fileFormat || '').toLowerCase().includes('mp3') ||
                    String(item.type || '').toLowerCase().includes('mp3');

      if (isMp3 && audioInfo) {
        logPhase('info', 'Audio-only MP3 format requested: downloading audio stream directly');
        await downloadStream('audio', getAudUrls, audioTemp);
        clearInterval(progressTimer);
        const mp3Out = filePath.replace(/\.[^.]+$/, '.mp3');
        await new Promise((resolve, reject) => {
          const ffmpegExe = this.getBinPath('ffmpeg.exe');
          const ffArgs = ['-y', '-i', audioTemp, '-vn', '-c:a', 'libmp3lame', '-q:a', '0', mp3Out];
          const { spawn } = require('child_process');
          const p = spawn(ffmpegExe, ffArgs);
          p.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg MP3 convert exited ${code}`)));
        });
        if (fs.existsSync(audioTemp)) { try { fs.unlinkSync(audioTemp); } catch(e){} }
        if (filePath !== mp3Out && fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch(e){} }
        if (finalize) {
          await this.finalizeCompletedItem(item, mp3Out, settings);
        }
        return true;
      }

      logPhase('info', `Launching DASH workers${audioInfo ? ' for video and audio' : ' for video only'}`);
      const promises = [downloadStream('video', getVidUrls, videoTemp)];
      if (audioInfo) promises.push(downloadStream('audio', getAudUrls, audioTemp));
      
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
      const vState = videoTemp + '.state.json';
      const aState = audioTemp + '.state.json';
      const vAria = videoTemp + '.aria2';
      const aAria = audioTemp + '.aria2';
      if (fs.existsSync(vState) || fs.existsSync(vAria)) {
        const vSize = fs.existsSync(videoTemp) ? fs.statSync(videoTemp).size : 0;
        if (vSize >= 100 * 1024) {
          try { if (fs.existsSync(vState)) fs.unlinkSync(vState); } catch(e){}
          try { if (fs.existsSync(vAria)) fs.unlinkSync(vAria); } catch(e){}
        } else {
          throw new Error('Video stream download incomplete (state or aria2 control file still present), aborting merge to prevent corrupt video');
        }
      }
      if (audioInfo && (fs.existsSync(aState) || fs.existsSync(aAria))) {
        const aSize = fs.existsSync(audioTemp) ? fs.statSync(audioTemp).size : 0;
        if (aSize >= 10 * 1024) {
          try { if (fs.existsSync(aState)) fs.unlinkSync(aState); } catch(e){}
          try { if (fs.existsSync(aAria)) fs.unlinkSync(aAria); } catch(e){}
        } else {
          throw new Error('Audio stream download incomplete (state or aria2 control file still present), aborting merge to prevent corrupt video');
        }
      }

      const partFilePath = filePath + '.part.mp4';
      logPhase('info', 'Merging DASH streams with FFmpeg to temporary part container');
      this.emit('item-progress', { id: item.id, status: 'Merging Video & Audio (FFmpeg)...', percentage: 99, downloadedMB: (totalBytes / (1024 * 1024)).toFixed(2), speedMbps: '0.00' });
      
      await this.muxBilibiliDash(videoTemp, audioInfo ? audioTemp : null, partFilePath);
      logPhase('info', 'FFmpeg merge finished');

      const isMuxValid = await this.validateMediaFile(partFilePath);
      const partStat = fs.existsSync(partFilePath) ? fs.statSync(partFilePath) : null;
      const minExpectedBytes = Math.round(0.85 * totalBytes);
      if (!isMuxValid || !partStat || (totalBytes > 0 && partStat.size < minExpectedBytes)) {
        throw new Error(`Merged video file failed integrity verification (size: ${partStat ? partStat.size : 0} bytes, expected >= ${minExpectedBytes})`);
      }

      // Atomically promote part file to final output
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
      fs.renameSync(partFilePath, filePath);
      logPhase('info', `Verified and finalized: ${path.basename(filePath)} (${(partStat.size / (1024 * 1024)).toFixed(2)} MB)`);

      // Cleanup temp streams only after successful promotion
      if (fs.existsSync(videoTemp)) { try { fs.unlinkSync(videoTemp); } catch(e){} }
      if (audioInfo && fs.existsSync(audioTemp)) { try { fs.unlinkSync(audioTemp); } catch(e){} }
      try { fs.unlinkSync(videoTemp + '.aria2'); } catch(e){}
      if (audioInfo) { try { fs.unlinkSync(audioTemp + '.aria2'); } catch(e){} }

      if (settings.downloadSubtitles !== false && (!item.subtitleFiles || item.subtitleFiles.length === 0)) {
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
      // Clean up failed output
      const partFilePath = filePath + '.part.mp4';
      if (fs.existsSync(partFilePath)) { try { fs.unlinkSync(partFilePath); } catch(e){} }
      if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch(e){} }
      if (err.message && err.message.includes('integrity verification')) {
        // If merged video failed integrity verification, clear corrupted temp video stream so user retry doesn't re-merge corrupt data
        if (fs.existsSync(videoTemp)) { try { fs.unlinkSync(videoTemp); } catch(e){} }
        const vState = videoTemp + '.state.json';
        if (fs.existsSync(vState)) { try { fs.unlinkSync(vState); } catch(e){} }
      }
      if (finalize) {
        this.decrementRunning(item);
        const currentPct = totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : (item.percentage || 0);
        const currentMB = totalBytes > 0 ? (downloadedBytes / (1024 * 1024)).toFixed(2) : (item.downloadedMB || '0.00');
        this.emit('item-progress', { id: item.id, status: `Error: ${err.message}`, percentage: currentPct, downloadedMB: currentMB });
        this.checkAndFillPools(settings);
        this.checkQueueCompleted();
      }
      return false;
    }
  }

  async downloadBilibiliDirectly(item, filePath, settings) {
    return await this.downloadBilibiliDASH(item, filePath, settings, { finalize: false });
  }

  alignDashFmp4(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return false;
    try {
      const fd = fs.openSync(filePath, 'r');
      const stat = fs.fstatSync(fd);
      if (stat.size < 1024 * 1024) {
        fs.closeSync(fd);
        return false;
      }

      // Check for sidx box
      const sidxHeader = Buffer.alloc(16);
      let sidxOffset = -1;
      let sidxSize = 0;
      let pos = 0;
      while (pos < 200000 && pos < stat.size - 16) {
        fs.readSync(fd, sidxHeader, 0, 16, pos);
        const boxSize = sidxHeader.readUInt32BE(0);
        const boxType = sidxHeader.toString('latin1', 4, 8);
        if (boxType === 'sidx') {
          sidxOffset = pos;
          sidxSize = boxSize;
          break;
        }
        if (boxType === 'moof') break;
        if (boxSize <= 0 || boxSize > 5000000) break;
        pos += boxSize;
      }

      if (sidxOffset === -1 || sidxSize <= 32 || sidxSize > 500000) {
        fs.closeSync(fd);
        return false;
      }

      // Read sidx
      const sidxBuf = Buffer.alloc(sidxSize);
      fs.readSync(fd, sidxBuf, 0, sidxSize, sidxOffset);
      const version = sidxBuf.readUInt8(8);
      let sOffset = 20;
      if (version === 0) {
        sOffset += 8;
      } else {
        sOffset += 16;
      }
      sOffset += 2; // reserved
      const refCount = sidxBuf.readUInt16BE(sOffset); sOffset += 2;
      if (refCount < 2 || refCount > 50000) {
        fs.closeSync(fd);
        return false;
      }

      let runningOffset = sidxOffset + sidxSize;
      let segments = [];
      for (let i = 0; i < refCount; i++) {
        if (sOffset + 12 > sidxSize) break;
        const ref = sidxBuf.readUInt32BE(sOffset); sOffset += 4;
        const refSize = ref & 0x7FFFFFFF;
        sOffset += 8; // skip duration and flags
        segments.push({ expectedOffset: runningOffset, expectedSize: refSize });
        runningOffset += refSize;
      }

      // Quick probe to check if alignment is actually needed
      let hasShift = false;
      const testBuf = Buffer.alloc(16);
      const step = Math.max(1, Math.floor(segments.length / 50));
      for (let i = 0; i < segments.length; i += step) {
        fs.readSync(fd, testBuf, 0, 16, segments[i].expectedOffset);
        if (testBuf.toString('latin1', 4, 8) !== 'moof') {
          hasShift = true;
          break;
        }
      }

      if (!hasShift) {
        fs.closeSync(fd);
        return false;
      }

      this.emitLog('info', `Detected shifted DASH fMP4 fragments in ${path.basename(filePath)}. Re-aligning container...`);

      const repairedPath = filePath + '.aligned.tmp';
      const dstFd = fs.openSync(repairedPath, 'w');
      const firstMoofOffset = segments[0].expectedOffset;

      // Copy init segment
      const initBuf = Buffer.alloc(firstMoofOffset);
      fs.readSync(fd, initBuf, 0, firstMoofOffset, 0);
      fs.writeSync(dstFd, initBuf, 0, firstMoofOffset, 0);
      let dstOffset = firstMoofOffset;

      const headerBuf = Buffer.alloc(16);
      const searchRange = 1024 * 1024;
      const searchBuf = Buffer.alloc(searchRange * 2);

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        let actualMoofOffset = seg.expectedOffset;

        fs.readSync(fd, headerBuf, 0, 8, actualMoofOffset);
        if (headerBuf.toString('latin1', 4, 8) !== 'moof') {
          const startRead = Math.max(0, seg.expectedOffset - searchRange);
          const bytesRead = fs.readSync(fd, searchBuf, 0, searchBuf.length, startRead);
          let sPos = 0;
          let bestOffset = null;
          let minDiff = Infinity;
          while (true) {
            const idx = searchBuf.indexOf('moof', sPos);
            if (idx === -1 || idx >= bytesRead) break;
            const cand = startRead + idx - 4;
            const diff = Math.abs(cand - seg.expectedOffset);
            if (diff < minDiff) {
              minDiff = diff;
              bestOffset = cand;
            }
            sPos = idx + 4;
          }
          if (bestOffset !== null) actualMoofOffset = bestOffset;
        }

        fs.readSync(fd, headerBuf, 0, 8, actualMoofOffset);
        const moofSize = headerBuf.readUInt32BE(0);
        const mdatOffset = actualMoofOffset + moofSize;
        fs.readSync(fd, headerBuf, 0, 8, mdatOffset);
        let mdatSize = headerBuf.readUInt32BE(0);
        let mdatType = headerBuf.toString('latin1', 4, 8);

        let segTotalSize = moofSize + mdatSize;
        if (mdatType !== 'mdat' || segTotalSize > 10 * 1024 * 1024) {
          segTotalSize = seg.expectedSize;
          mdatSize = segTotalSize - moofSize;
        }

        const segBuf = Buffer.alloc(segTotalSize);
        fs.readSync(fd, segBuf, 0, segTotalSize, actualMoofOffset);

        if (segBuf.toString('latin1', moofSize + 4, moofSize + 8) !== 'mdat') {
          segBuf.writeUInt32BE(mdatSize, moofSize);
          segBuf.write('mdat', moofSize + 4, 4, 'latin1');
        }

        fs.writeSync(dstFd, segBuf, 0, segTotalSize, dstOffset);
        dstOffset += segTotalSize;
      }

      fs.closeSync(fd);
      fs.closeSync(dstFd);

      // Atomically replace filePath with aligned file
      fs.unlinkSync(filePath);
      fs.renameSync(repairedPath, filePath);
      this.emitLog('info', `DASH container alignment complete for ${path.basename(filePath)} (${(dstOffset / (1024*1024)).toFixed(2)} MB)`);
      return true;
    } catch (err) {
      this.emitLog('warn', `DASH container auto-alignment failed: ${err.message}`);
      return false;
    }
  }

  async muxBilibiliDash(videoTemp, audioTemp, outputPath) {
    const { spawn } = require('child_process');
    const ffmpegExe = this.getBinPath('ffmpeg.exe');

    if (videoTemp && fs.existsSync(videoTemp)) {
      try { this.alignDashFmp4(videoTemp); } catch(e) {}
    }

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
      args.push('-movflags', '+faststart');
      args.push('-f', 'mp4');
      args.push(outputPath);

      let proc = spawn(ffmpegExe, args);
      let stderrLog = '';
      proc.stderr.on('data', (d) => stderrLog += d.toString());
      
      proc.on('close', (code) => {
        if (code === 0) {
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
          fallbackArgs.push('-f', 'mp4');
          fallbackArgs.push(outputPath);

          let fbProc = spawn(ffmpegExe, fallbackArgs);
          let fbStderr = '';
          fbProc.stderr.on('data', (d) => fbStderr += d.toString());
          fbProc.on('close', (fbCode) => {
            if (fbCode === 0) {
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
    const isWifiFriendly = settings.wifiFriendly !== false && settings.speedLimitMode !== 'unlimited';
    const maxAllowedThreads = isWifiFriendly ? 6 : 16;
    const numThreads = Math.min(maxAllowedThreads, Math.max(2, parseInt(settings.threads || (isWifiFriendly ? 6 : 12), 10)));
    const controller = new AbortController();
    this.activeControllers.set(item.id, controller);
    this.emitLog('info', `Parallel download start for item ${item.id} with ${numThreads} worker(s) (Wi-Fi Friendly=${isWifiFriendly ? 'ON' : 'OFF'})`, {
      itemId: item.id,
      threads: numThreads,
      isWifiFriendly,
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
        let response = null;
        try {
          const currentStart = chunk.startByte + chunk.downloaded;
          if (currentStart > chunk.endByte) break; // Chunk completed

          const chunkHeaders = {
            ...headers,
            'Range': `bytes=${currentStart}-${chunk.endByte}`
          };

          response = await axios({
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

          const contentRange = response.headers['content-range'];
          if (contentRange) {
            const rangeMatch = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+)/i);
            if (rangeMatch) {
              const serverStart = parseInt(rangeMatch[1], 10);
              if (serverStart !== currentStart) {
                throw new Error(`Content-Range start mismatch: requested ${currentStart}, server returned ${serverStart}`);
              }
            }
          }

          await new Promise((resolveChunk, rejectChunk) => {
            const stream = response.data;
            let settled = false;

            const cleanup = () => {
              if (stream) {
                stream.removeAllListeners('data');
                stream.removeAllListeners('end');
                stream.removeAllListeners('error');
                stream.removeAllListeners('close');
              }
            };

            const abort = (err) => {
              cleanup();
              try {
                if (response && response.request) {
                  if (response.request.socket && !response.request.socket.destroyed) response.request.socket.destroy();
                  if (!response.request.destroyed) response.request.destroy();
                }
              } catch(e) {}
              try {
                if (stream && !stream.destroyed) stream.destroy(err);
              } catch(e) {}
            };

            stream.on('data', (buffer) => {
              if (this.isCancelled) {
                settled = true;
                abort(new Error('Cancelled'));
                return;
              }
              try {
                if (this.bandwidthLimiter && this.bandwidthLimiter.isEnabled()) {
                  const throttleDelayMs = this.bandwidthLimiter.consume(buffer.length);
                  if (throttleDelayMs > 0) {
                    stream.pause();
                    setTimeout(() => {
                      if (!settled && stream && !stream.destroyed) {
                        try { stream.resume(); } catch (e) {}
                      }
                    }, throttleDelayMs);
                  }
                }

                const writeOffset = chunk.startByte + chunk.downloaded;
                fs.writeSync(sharedFd, buffer, 0, buffer.length, writeOffset);

                chunk.downloaded += buffer.length;
                updateProgress();
              } catch (writeErr) {
                if (!settled) {
                  settled = true;
                  abort(writeErr);
                  rejectChunk(writeErr);
                }
              }
            });

            stream.on('end', () => {
              if (settled) return;
              settled = true;
              cleanup();
              const expectedTotal = chunk.endByte - chunk.startByte + 1;
              if (chunk.downloaded < expectedTotal) {
                abort(new Error(`Stream ended prematurely: ${chunk.downloaded}/${expectedTotal} bytes`));
                rejectChunk(new Error(`Stream ended prematurely: ${chunk.downloaded}/${expectedTotal} bytes`));
              } else {
                resolveChunk();
              }
            });
            stream.on('error', (err) => {
              if (settled) return;
              settled = true;
              abort(err);
              rejectChunk(err);
            });
          });

          break; // Worker stream finished successfully
        } catch (err) {
          try {
            if (response && response.request) {
              if (response.request.socket && !response.request.socket.destroyed) response.request.socket.destroy();
              if (!response.request.destroyed) response.request.destroy();
            }
          } catch(e) {}
          if (axios.isCancel(err) || this.isCancelled) break;
          if (attempt === 3) throw err;
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        }
      }
    });

    try {
      try {
        await Promise.all(workerPromises);
      } finally {
        clearInterval(stateInterval);
        if (sharedFd !== null) { try { fs.closeSync(sharedFd); sharedFd = null; } catch(e) {} }
      }
      
      const totalExpected = chunks.reduce((acc, c) => acc + (c.endByte - c.startByte + 1), 0);
      const totalGot = chunks.reduce((acc, c) => acc + c.downloaded, 0);

      if (!this.isCancelled) {
        try { fs.writeFileSync(stateFile, JSON.stringify({ totalBytes, chunks }), 'utf8'); } catch(e){}
        
        if (totalExpected === totalGot && fs.existsSync(stateFile)) {
           try { fs.unlinkSync(stateFile); } catch(e){}
        }
        if (totalBytes > 0 && totalGot < totalExpected) {
          throw new Error(`Parallel download incomplete: received ${totalGot} of ${totalExpected} bytes`);
        }
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

          if (this.bandwidthLimiter && this.bandwidthLimiter.isEnabled()) {
            const throttleDelayMs = this.bandwidthLimiter.consume(chunk.length);
            if (throttleDelayMs > 0) {
              response.data.pause();
              setTimeout(() => {
                if (response.data && !response.data.destroyed) {
                  try { response.data.resume(); } catch (e) {}
                }
              }, throttleDelayMs);
            }
          }

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

  checkAndFillPools(settings) {
    if (this.isCancelled) return;
    while (this.runningGlobalCount < this.globalConcurrencyLimit && this.globalQueue.length > 0) {
      this.processNextInPool('global', settings);
    }
    while (this.runningLocalCount < this.localConcurrencyLimit && this.localQueue.length > 0) {
      this.processNextInPool('local', settings);
    }
  }

  checkQueueCompleted() {
    if (this.isCancelled) return;
    if (
      this.runningGlobalCount === 0 &&
      this.runningLocalCount === 0 &&
      this.globalQueue.length === 0 &&
      this.localQueue.length === 0
    ) {
      if (this.speedTimer) {
        clearInterval(this.speedTimer);
        this.speedTimer = null;
      }
      this.broadcastGlobalStatus();
      this.emit('queue-completed', { completed: this.completedCount, total: this.totalCount });
      this.emitLog('info', `Dual-speed queue completed: ${this.completedCount}/${this.totalCount}`);
    }
  }

  async processNextInPool(pool, settings) {
    if (this.isCancelled) return;

    const queue = pool === 'local' ? this.localQueue : this.globalQueue;
    const running = pool === 'local' ? this.runningLocalCount : this.runningGlobalCount;
    const limit = pool === 'local' ? this.localConcurrencyLimit : this.globalConcurrencyLimit;

    if (running >= limit || queue.length === 0) {
      this.checkQueueCompleted();
      return;
    }

    const item = queue.shift();
    this.incrementRunning(item);
    await this.executeItemDownload(item, settings);
  }

  processNextInQueue(settings, item = null) {
    if (item) {
      this.decrementRunning(item);
    }
    this.checkAndFillPools(settings);
    this.checkQueueCompleted();
  }

  async executeItemDownload(item, settings) {
    try {
      this.emitLog('info', `Processing item ${item.id} [${item.speedPool || 'global'} speed channel]: ${item.title || item.movieName || 'Untitled'}`, {
        itemId: item.id,
        platform: item.platform,
        speedPool: item.speedPool || 'global',
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
          this.decrementRunning(item);
          this.emit('item-progress', { id: item.id, status: 'Error: Subtitle download failed', percentage: 0, downloadedMB: '0.00' });
          this.checkAndFillPools(settings);
          this.checkQueueCompleted();
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
      const effectiveTimeRange = this.getEffectiveTimeRange(item, settings);
      const hasTimeRange = Boolean(effectiveTimeRange && effectiveTimeRange.enabled);

      if (isBili && !hasTimeRange) {
        this.emitLog('info', `Routing item ${item.id} through high-speed Bilibili DASH pipeline`, {
          itemId: item.id,
          platform: item.platform || 'BiliBili',
          mode: settings?.bilibiliMode || 'fast'
        });
        const dashSuccess = await this.downloadBilibiliDASH(item, filePath, settings, { finalize: false });
        if (this.isCancelled) {
          this.decrementRunning(item);
          this.emit('item-progress', { id: item.id, status: 'Cancelled (Paused)' });
          this.checkQueueCompleted();
          return;
        }
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

      if (item.platform !== 'NovelQuick' && (hasTimeRange || item.useYtDlp || isBili || item.platform === 'YouTube' || item.platform === 'TikTok' || item.platform === 'DramaBox' || item.platform === 'DonghuaFun' || item.platform === 'Donghua' || item.platform === 'Dailymotion' || item.platform === 'GanJingWorld' || item.platform === 'Odysee' || item.platform === 'LBRY' || targetUrlLower.includes('dramabox') || targetUrlLower.includes('donghua') || targetUrlLower.includes('dailymotion') || targetUrlLower.includes('ganjingworld') || targetUrlLower.includes('youtube') || targetUrlLower.includes('youtu.be') || targetUrlLower.includes('tiktok') || targetUrlLower.includes('odysee.com') || targetUrlLower.includes('lbry.tv'))) {
        this.emitLog('info', `Routing item ${item.id} through yt-dlp pipeline${hasTimeRange ? ' (custom time range active)' : ''}`, {
          itemId: item.id,
          platform: item.platform,
          hasTimeRange
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
      if (item.platform === 'NovelQuick' || (downloadUrl && (downloadUrl.includes('qznovel.com') || downloadUrl.includes('novelquickapp.com')))) {
        headers['Referer'] = 'https://novelquickapp.com/';
      }

      // Execute Multi-Threaded Chunk Range download engine
      const success = await this.downloadWithParallelChunks(downloadUrl, filePath, item, settings, headers);

      this.decrementRunning(item);
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

      this.checkAndFillPools(settings);
      this.checkQueueCompleted();
    } catch (err) {
      this.emitLog('error', `Unexpected error processing item ${item.id}: ${err.message}`, { itemId: item.id, error: err.message });
      this.decrementRunning(item);
      this.emit('item-progress', { id: item.id, status: `Error: ${err.message}`, percentage: 0, downloadedMB: '0.00' });
      this.checkAndFillPools(settings);
      this.checkQueueCompleted();
    }
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
    this.globalQueue = [];
    this.localQueue = [];
    this.runningCount = 0;
    this.runningGlobalCount = 0;
    this.runningLocalCount = 0;
    this.emit('global-metrics', {
      totalSpeedMbps: '0.00',
      running: 0,
      runningGlobal: 0,
      runningLocal: 0,
      completed: this.completedCount,
      total: this.totalCount
    });
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
      runningGlobal: this.runningGlobalCount,
      runningLocal: this.runningLocalCount,
      completed: this.completedCount,
      total: this.totalCount
    });
  }
}

module.exports = DownloaderEngine;
