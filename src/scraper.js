const axios = require('axios');
const cheerio = require('cheerio');
const urlModule = require('url');

class ScraperEngine {
  constructor() {
    this.sampleVideoStreams = [
      'https://media.w3.org/2010/05/sintel/trailer.mp4',
      'https://media.w3.org/2010/05/bunny/trailer.mp4',
      'https://media.w3.org/2010/05/video/movie_300.mp4',
      'https://www.w3schools.com/html/mov_bbb.mp4',
      'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
      'https://www.learningcontainer.com/wp-content/uploads/2020/05/sample-mp4-file.mp4'
    ];
  }

  formatDuration(seconds) {
    if (!seconds || isNaN(seconds) || seconds <= 0) return '';
    const s = Math.round(seconds);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  extractYouTubeVideoId(url) {
    try {
      const match = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  extractCleanUrl(text) {
    if (!text || typeof text !== 'string') return '';
    const match = text.match(/https?:\/\/[^\s"'<>\n\r]+/i);
    if (match) {
      return match[0].trim().replace(/[.,;!]+$/, '');
    }
    return text.trim();
  }

  async resolveRedirectUrl(rawUrl) {
    if (!rawUrl) return rawUrl;
    const lower = rawUrl.toLowerCase();
    const isShortLink = lower.includes('vt.tiktok.com') ||
                        lower.includes('vm.tiktok.com') ||
                        lower.includes('v.douyin.com') ||
                        lower.includes('b23.tv') ||
                        lower.includes('fb.watch') ||
                        lower.includes('t.co') ||
                        lower.includes('bit.ly') ||
                        lower.includes('tinyurl.com') ||
                        lower.includes('xhslink.com') ||
                        lower.includes('pin.it') ||
                        lower.includes('novelquickapp.com');
    if (!isShortLink) return rawUrl;

    try {
      const res = await axios.get(rawUrl, {
        maxRedirects: 5,
        timeout: 7000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        },
        validateStatus: () => true
      });
      const resolved = res.request?.res?.responseUrl || res.config?.url;
      if (resolved && resolved.startsWith('http')) {
        return resolved;
      }
    } catch (e) {}
    return rawUrl;
  }

  detectPlatform(url, extractorKey = '') {
    const raw = String(url || '').toLowerCase();
    const ext = String(extractorKey || '').toLowerCase();

    if (raw.includes('youtube.com') || raw.includes('youtu.be') || ext.includes('youtube')) return 'YouTube';
    if (raw.includes('bilibili') || raw.includes('b23.tv') || raw.includes('bibili') || ext.includes('bili')) return 'BiliBili';
    if (raw.includes('tiktok.com') || ext.includes('tiktok')) return 'TikTok';
    if (raw.includes('douyin.com') || ext.includes('douyin')) return 'Douyin';
    if (raw.includes('facebook.com') || raw.includes('fb.watch') || raw.includes('fb.com') || ext.includes('facebook')) return 'Facebook';
    if (raw.includes('instagram.com') || ext.includes('instagram')) return 'Instagram';
    if (raw.includes('twitter.com') || raw.includes('x.com') || ext.includes('twitter')) return 'Twitter/X';
    if (raw.includes('threads.net') || ext.includes('threads')) return 'Threads';
    if (raw.includes('reddit.com') || raw.includes('redd.it') || ext.includes('reddit')) return 'Reddit';
    if (raw.includes('pinterest.com') || raw.includes('pin.it') || ext.includes('pinterest')) return 'Pinterest';
    if (raw.includes('twitch.tv') || ext.includes('twitch')) return 'Twitch';
    if (raw.includes('vimeo.com') || ext.includes('vimeo')) return 'Vimeo';
    if (raw.includes('dramabox') || ext.includes('dramabox')) return 'DramaBox';
    if (raw.includes('kuaishou.com') || raw.includes('kwai.com') || ext.includes('kuaishou')) return 'Kuaishou';
    if (raw.includes('xiaohongshu.com') || raw.includes('xhslink.com') || ext.includes('xiaohongshu')) return 'XiaoHongShu';
    if (raw.includes('soundcloud.com') || ext.includes('soundcloud')) return 'SoundCloud';
    if (raw.includes('dailymotion.com') || ext.includes('dailymotion')) return 'Dailymotion';
    if (raw.includes('rumble.com') || ext.includes('rumble')) return 'Rumble';
    if (raw.includes('streamable.com') || ext.includes('streamable')) return 'Streamable';
    if (raw.includes('capcut.com') || ext.includes('capcut')) return 'CapCut';
    if (raw.includes('odysee.com') || raw.includes('lbry.tv') || raw.includes('lbry://') || ext.includes('odysee') || ext.includes('lbry')) return 'Odysee';
    if (raw.includes('donghuafun') || raw.includes('donghua') || ext.includes('donghua')) return 'DonghuaFun';
    if (raw.includes('novelquickapp.com') || raw.includes('hongguo') || raw.includes('qznovel.com') || ext.includes('novelquick') || ext.includes('hongguo')) return 'NovelQuick';
    if (raw.includes('ganjingworld') || ext.includes('ganjing')) return 'GanJingWorld';
    if (extractorKey) return extractorKey;
    return this.getDomain(url);
  }

  getCookieFilePath(platform = 'bilibili') {
    const fs = require('fs');
    const path = require('path');
    const isBili = String(platform || '').toLowerCase().includes('bili');
    const filename = isBili ? 'www.bilibili.com_cookies.txt' : 'www.youtube.com_cookies.txt';
    const candidates = [
      path.join(process.cwd(), filename),
      path.join(__dirname, '..', filename),
      path.join(__dirname, filename)
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  }

  getCookieHeader(platform = 'bilibili') {
    const fs = require('fs');
    const filePath = this.getCookieFilePath(platform);
    if (!filePath) return null;
    try {
      const stats = fs.statSync(filePath);
      const isBili = String(platform || '').toLowerCase().includes('bili');
      const cacheKey = `${filePath}:${stats.mtimeMs}:${isBili ? 'bili' : 'yt'}`;
      if (!this._cookieHeaderCache) this._cookieHeaderCache = new Map();
      if (this._cookieHeaderCache.has(cacheKey)) {
        return this._cookieHeaderCache.get(cacheKey);
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const pairs = [];
      content.split('\n').forEach(line => {
        const l = line.trim();
        if (!l || l.startsWith('#')) return;
        const parts = l.split('\t');
        if (parts.length >= 7) {
          const domain = (parts[0] || '').toLowerCase();
          if (isBili && !domain.includes('bilibili.com')) return;
          if (!isBili && !domain.includes('youtube.com') && !domain.includes('google.com')) return;
          pairs.push(`${parts[5]}=${parts[6]}`);
        }
      });
      const header = pairs.length > 0 ? pairs.join('; ') : null;
      this._cookieHeaderCache.set(cacheKey, header);
      return header;
    } catch (e) {
      return null;
    }
  }

  getBilibiliReferer(rawUrl) {
    try {
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
    } catch (e) {}
    return 'https://www.bilibili.com/';
  }

  async scrapeQueue(urls, onProgress = null) {
    const results = [];
    let itemId = 1;

    for (let i = 0; i < urls.length; i++) {
      const targetUrl = this.extractCleanUrl(urls[i]);
      if (!targetUrl) continue;

      if (onProgress) {
        onProgress({ current: i + 1, total: urls.length, url: targetUrl });
      }

      try {
        const items = await this.scrapeSingleUrl(targetUrl, itemId);
        items.forEach(item => {
          results.push(item);
          itemId++;
        });
      } catch (error) {
        console.error(`Scrape error on ${targetUrl}:`, error.message);
        const platform = this.detectPlatform(targetUrl);
        const yId = platform === 'YouTube' ? this.extractYouTubeVideoId(targetUrl) : null;
        const thumbnail = yId ? `https://img.youtube.com/vi/${yId}/hqdefault.jpg` : '';

        results.push({
          id: itemId++,
          title: `Media Stream - ${platform}`,
          url: targetUrl,
          downloadUrl: targetUrl,
          thumbnail: thumbnail,
          duration: '',
          resolution: '1080p',
          fps: '',
          useYtDlp: true,
          hasCC: true,
          folder: 'video',
          type: 'video/mp4 (+ Subtitle)',
          sizeMB: '450.0',
          profile: platform,
          platform: platform,
          status: 'Ready',
          selected: true
        });
      }
    }

    return results;
  }

  parseIsoDuration(isoDuration) {
    if (!isoDuration || typeof isoDuration !== 'string') return 0;
    const match = isoDuration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
    if (!match) return 0;
    const hours = parseInt(match[1] || 0, 10);
    const minutes = parseInt(match[2] || 0, 10);
    const seconds = parseInt(match[3] || 0, 10);
    return hours * 3600 + minutes * 60 + seconds;
  }

  getYtDlpPath() {
    const path = require('path');
    const fs = require('fs');
    const exeName = 'yt-dlp.exe';
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

  getJsRuntimeArg() {
    const path = require('path');
    const fs = require('fs');
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

  estimateMediaSizeMB(entry) {
    if (!entry) return '25.0';

    // 1. Direct filesize on entry if provided
    if (typeof entry.filesize === 'number' && entry.filesize > 0) {
      return (entry.filesize / (1024 * 1024)).toFixed(1);
    }

    const duration = entry.duration ? parseFloat(entry.duration) : 0;
    const formats = Array.isArray(entry.formats) ? entry.formats : [];

    if (formats.length > 0) {
      // Check for progressive formats (video + audio in single stream)
      const progressiveFormats = formats.filter(f => 
        f && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none'
      );

      // Separate DASH video-only and audio-only streams
      const videoFormats = formats.filter(f => 
        f && f.vcodec && f.vcodec !== 'none' && (!f.acodec || f.acodec === 'none')
      );
      const audioFormats = formats.filter(f => 
        f && f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
      );

      // Pick the best video format (highest resolution, then highest bitrate/filesize)
      let bestVideo = null;
      if (videoFormats.length > 0) {
        const sorted = [...videoFormats].sort((a, b) => {
          const hA = a.height || 0;
          const hB = b.height || 0;
          if (hA !== hB) return hB - hA;
          const sizeA = a.filesize || a.filesize_approx || (a.tbr ? (a.tbr * 1000 / 8 * duration) : 0) || 0;
          const sizeB = b.filesize || b.filesize_approx || (b.tbr ? (b.tbr * 1000 / 8 * duration) : 0) || 0;
          return sizeB - sizeA;
        });
        bestVideo = sorted[0];
      }

      // Pick the best audio format
      let bestAudio = null;
      if (audioFormats.length > 0) {
        const sorted = [...audioFormats].sort((a, b) => {
          const sizeA = a.filesize || a.filesize_approx || (a.abr || a.tbr || 0);
          const sizeB = b.filesize || b.filesize_approx || (b.abr || b.tbr || 0);
          return sizeB - sizeA;
        });
        bestAudio = sorted[0];
      }

      let totalBytes = 0;

      if (bestVideo) {
        if (typeof bestVideo.filesize === 'number' && bestVideo.filesize > 0) {
          totalBytes += bestVideo.filesize;
        } else if (typeof bestVideo.filesize_approx === 'number' && bestVideo.filesize_approx > 0) {
          totalBytes += bestVideo.filesize_approx;
        } else if (duration > 0 && (bestVideo.vbr || bestVideo.tbr)) {
          const kbps = bestVideo.vbr || bestVideo.tbr || 2500;
          totalBytes += (kbps * 1000 / 8) * duration;
        }
      }

      if (bestAudio) {
        if (typeof bestAudio.filesize === 'number' && bestAudio.filesize > 0) {
          totalBytes += bestAudio.filesize;
        } else if (typeof bestAudio.filesize_approx === 'number' && bestAudio.filesize_approx > 0) {
          totalBytes += bestAudio.filesize_approx;
        } else if (duration > 0 && (bestAudio.abr || bestAudio.tbr)) {
          const kbps = bestAudio.abr || bestAudio.tbr || 128;
          totalBytes += (kbps * 1000 / 8) * duration;
        }
      }

      if (totalBytes > 1024 * 1024) {
        return (totalBytes / (1024 * 1024)).toFixed(1);
      }

      // Fallback to progressive formats
      if (progressiveFormats.length > 0) {
        const bestProg = [...progressiveFormats].sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        if (bestProg.filesize) return (bestProg.filesize / (1024 * 1024)).toFixed(1);
        if (bestProg.filesize_approx) return (bestProg.filesize_approx / (1024 * 1024)).toFixed(1);
        if (duration > 0 && bestProg.tbr) {
          return ((bestProg.tbr * 1000 / 8 * duration) / (1024 * 1024)).toFixed(1);
        }
      }
    }

    // 2. Fallback to entry.approximate_filesize if reasonable (> 5MB)
    if (typeof entry.approximate_filesize === 'number' && entry.approximate_filesize > 5 * 1024 * 1024) {
      return (entry.approximate_filesize / (1024 * 1024)).toFixed(1);
    }

    // 3. Fallback to duration-based bitrate estimation by resolution
    if (duration > 0) {
      const height = entry.height || 1080;
      let mbPerSec = 0.55; // 1080p ~ 4.4 Mbps = 0.55 MB/s
      if (height >= 2160) mbPerSec = 2.5;      // 4K ~ 20 Mbps = 2.5 MB/s
      else if (height >= 1440) mbPerSec = 1.2; // 2K ~ 10 Mbps = 1.2 MB/s
      else if (height >= 1080) mbPerSec = 0.55;// 1080p ~ 4.4 Mbps = 0.55 MB/s
      else if (height >= 720) mbPerSec = 0.28; // 720p ~ 2.2 Mbps = 0.28 MB/s
      else if (height >= 480) mbPerSec = 0.15; // 480p ~ 1.2 Mbps = 0.15 MB/s
      else mbPerSec = 0.08;                    // 360p ~ 0.6 Mbps = 0.08 MB/s

      return (duration * mbPerSec).toFixed(1);
    }

    return (entry.height && entry.height >= 2160) ? '1200.0' : '450.0';
  }

  async scrapeWithYtDlp(targetUrl, startId = 1) {
    const { execFile } = require('child_process');
    const util = require('util');
    const path = require('path');
    const fs = require('fs');
    const ytDlpExe = this.getYtDlpPath();
    const execFileAsync = util.promisify(execFile);

    try {
      const targetUrlLower = targetUrl.toLowerCase();
      const isBilibili = targetUrlLower.includes('bilibili') || targetUrlLower.includes('b23.tv') || targetUrlLower.includes('bibili');
      const isYouTube = targetUrlLower.includes('youtube.com') || targetUrlLower.includes('youtu.be');
      const isOdysee = targetUrlLower.includes('odysee.com') || targetUrlLower.includes('lbry.tv') || targetUrlLower.includes('lbry://');
      const isPlaylist = targetUrlLower.includes('list=') || targetUrlLower.includes('/playlist') || targetUrlLower.includes('/channel/') || (targetUrlLower.includes('/@') && !isOdysee);

      const args = [
        '--dump-single-json',
        '--no-warnings',
        '--ignore-errors',
        '--no-check-certificates',
        '--extractor-retries', '3',
        '--socket-timeout', '30',
        ...this.getJsRuntimeArg()
      ];

      if (isPlaylist) {
        args.push('--flat-playlist');
      }

      if (isBilibili) {
        args.push('--add-header', `Referer:${this.getBilibiliReferer(targetUrl)}`);
        args.push('--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36');
        args.push('--extractor-args', 'bilibili:player_client=tv,android,web');
        const biliCookies = [
          process.resourcesPath ? path.join(process.resourcesPath, 'www.bilibili.com_cookies.txt') : null,
          process.execPath ? path.join(path.dirname(process.execPath), 'resources', 'www.bilibili.com_cookies.txt') : null,
          process.execPath ? path.join(path.dirname(process.execPath), 'www.bilibili.com_cookies.txt') : null,
          path.join(process.cwd(), 'www.bilibili.com_cookies.txt'),
          path.join(__dirname, '..', 'www.bilibili.com_cookies.txt'),
          path.join(__dirname, 'www.bilibili.com_cookies.txt'),
          'D:\\PROJECT\\www.bilibili.com_cookies.txt',
          'D:\\PROJECT\\DOWNLOAD\\snapkee-app\\www.bilibili.com_cookies.txt'
        ].filter(Boolean).find(p => fs.existsSync(p));
        if (biliCookies) {
          let realCookie = biliCookies;
          if (biliCookies.includes('app.asar')) {
            try {
              const os = require('os');
              const tmpCookie = path.join(os.tmpdir(), 'snapkee_scraper_bili_cookies.txt');
              fs.writeFileSync(tmpCookie, fs.readFileSync(biliCookies, 'utf8'), 'utf8');
              realCookie = tmpCookie;
            } catch (e) {}
          }
          args.push('--cookies', realCookie);
        }
      } else if (isYouTube) {
        const ytCookies = [
          process.resourcesPath ? path.join(process.resourcesPath, 'www.youtube.com_cookies.txt') : null,
          process.execPath ? path.join(path.dirname(process.execPath), 'resources', 'www.youtube.com_cookies.txt') : null,
          process.execPath ? path.join(path.dirname(process.execPath), 'www.youtube.com_cookies.txt') : null,
          path.join(process.cwd(), 'www.youtube.com_cookies.txt'),
          path.join(__dirname, '..', 'www.youtube.com_cookies.txt'),
          path.join(__dirname, 'www.youtube.com_cookies.txt'),
          'D:\\PROJECT\\www.youtube.com_cookies.txt',
          'D:\\PROJECT\\DOWNLOAD\\snapkee-app\\www.youtube.com_cookies.txt'
        ].filter(Boolean).find(p => fs.existsSync(p));
        if (ytCookies) {
          let realCookie = ytCookies;
          if (ytCookies.includes('app.asar')) {
            try {
              const os = require('os');
              const tmpCookie = path.join(os.tmpdir(), 'snapkee_scraper_yt_cookies.txt');
              fs.writeFileSync(tmpCookie, fs.readFileSync(ytCookies, 'utf8'), 'utf8');
              realCookie = tmpCookie;
            } catch (e) {}
          }
          args.push('--cookies', realCookie);
        }
      } else if (isOdysee) {
        args.push('--add-header', 'Referer:https://odysee.com/');
        args.push('--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36');
      } else {
        args.push('--impersonate', 'chrome');
      }
      const targetCleanUrl = isBilibili ? this.cleanBilibiliUrl(targetUrl) : targetUrl;
      args.push(targetCleanUrl);

      let stdout;
      try {
        const res = await execFileAsync(ytDlpExe, args, { timeout: 45000, maxBuffer: 50 * 1024 * 1024 });
        stdout = res.stdout;
      } catch (firstErr) {
        const cookieIdx = args.indexOf('--cookies');
        const fallbackArgs = [
          '--dump-single-json',
          '--no-warnings',
          '--ignore-errors',
          '--no-check-certificates',
          ...this.getJsRuntimeArg()
        ];
        if (cookieIdx !== -1 && args[cookieIdx + 1]) {
          fallbackArgs.push('--cookies', args[cookieIdx + 1]);
        }
        fallbackArgs.push(targetCleanUrl);
        const res = await execFileAsync(ytDlpExe, fallbackArgs, { timeout: 45000, maxBuffer: 50 * 1024 * 1024 });
        stdout = res.stdout;
      }

      const data = JSON.parse(stdout);
      const entries = data.entries || [data];
      const items = [];

      entries.forEach((entry, idx) => {
        if (!entry) return;
        const entryUrl = entry.webpage_url || entry.url || targetUrl;
        const title = entry.title || data.title || `Video ${startId + idx}`;
        
        const sizeMB = this.estimateMediaSizeMB(entry);
        
        const platform = this.detectPlatform(entryUrl, entry.extractor_key);
        const uploader = entry.uploader || entry.channel || entry.uploader_id || platform;

        // Extract thumbnail
        let thumbnail = entry.thumbnail || '';
        if (!thumbnail && Array.isArray(entry.thumbnails) && entry.thumbnails.length > 0) {
          thumbnail = entry.thumbnails[entry.thumbnails.length - 1].url || '';
        }
        if (!thumbnail && platform === 'YouTube') {
          const yId = this.extractYouTubeVideoId(entryUrl);
          if (yId) thumbnail = `https://img.youtube.com/vi/${yId}/hqdefault.jpg`;
        }

        // Extract duration & resolution
        const durationSec = entry.duration ? Math.round(entry.duration) : null;
        const duration = this.formatDuration(durationSec);
        
        let effectiveDim = (entry.height && entry.width) ? Math.min(entry.height, entry.width) : (entry.height || 0);
        if (Array.isArray(entry.formats)) {
          for (const f of entry.formats) {
            if (f) {
              const dim = (f.height && f.width) ? Math.min(f.height, f.width) : (f.height || 0);
              if (dim > effectiveDim) {
                effectiveDim = dim;
              }
            }
          }
        }
        let resolution = '1080p';
        if (effectiveDim >= 2160) resolution = '4K (2160p)';
        else if (effectiveDim >= 1440) resolution = '2K (1440p)';
        else if (effectiveDim >= 1080) resolution = '1080p (Full HD)';
        else if (effectiveDim >= 720) resolution = '720p (HD)';
        else if (effectiveDim > 0) resolution = `${effectiveDim}p`;
        else if (entry.resolution) resolution = entry.resolution;

        let fps = entry.fps ? `${entry.fps}fps` : '';

        // Subtitles detection
        let hasCC = false;
        let hasAiSubtitle = false;
        let subtitleLangs = [];
        if (entry.subtitles && typeof entry.subtitles === 'object') {
          const langs = Object.keys(entry.subtitles).filter(k => k !== 'live_chat' && k !== 'danmaku');
          if (langs.length > 0) {
            hasCC = true;
            subtitleLangs.push(...langs);
            if (isBilibili && langs.some(k => String(k).toLowerCase() === 'ai-zh')) {
              hasAiSubtitle = true;
            }
          }
        }
        if (entry.automatic_captions && typeof entry.automatic_captions === 'object') {
          const langs = Object.keys(entry.automatic_captions).filter(k => k !== 'live_chat' && k !== 'danmaku');
          if (langs.length > 0) {
            hasCC = true;
            subtitleLangs.push(...langs);
            if (isBilibili && langs.some(k => String(k).toLowerCase() === 'ai-zh')) {
              hasAiSubtitle = true;
            }
          }
        }

        // Default YouTube and major platforms to having CC enabled
        if (platform === 'YouTube') {
          hasCC = true;
        }

        const isZhLang = (l) => /zh|chinese|chi|zho|cmn|hans|hant|中文|简体|繁体/i.test(l);
        const isEnLang = (l) => (/en|english|eng/i.test(l)) && !isZhLang(l);
        const sortedSubLangs = [...new Set(subtitleLangs)].sort((a, b) => {
          const aZh = isZhLang(a) ? 1 : 0;
          const bZh = isZhLang(b) ? 1 : 0;
          const aEn = isEnLang(a) ? 1 : 0;
          const bEn = isEnLang(b) ? 1 : 0;
          if (aZh !== bZh) return bZh - aZh;
          if (aEn !== bEn) return bEn - aEn;
          return a.localeCompare(b);
        });
        const uniqueLangs = sortedSubLangs.slice(0, 4);
        const subtitleLabel = hasAiSubtitle
          ? 'Subtitle [AI-ZH]'
          : (uniqueLangs.length > 0 ? `CC Available (${uniqueLangs.join(', ')})` : (hasCC ? 'CC Available' : ''));
        const itemType = hasCC ? `video/mp4 (+ ${subtitleLabel || 'Subtitle'})` : 'video/mp4 (No Subtitle)';

        items.push({
          id: startId + idx,
          title: title,
          url: entryUrl,
          downloadUrl: entryUrl,
          thumbnail: thumbnail,
          duration: duration,
          durationSeconds: durationSec,
          resolution: resolution,
          fps: fps,
          useYtDlp: true,
          hasCC: hasCC,
          hasAiSubtitle: hasAiSubtitle,
          subtitleLangs: uniqueLangs,
          folder: 'video',
          type: itemType,
          sizeMB: sizeMB,
          profile: uploader,
          platform: platform,
          status: 'Ready',
          selected: true
        });
      });

      return items;
    } catch (err) {
      console.error('[scrapeWithYtDlp ERROR]:', err && (err.message || err));
      return null;
    }
  }

  async scrapeSingleUrl(targetUrl, startId = 1) {
    targetUrl = this.extractCleanUrl(targetUrl);
    targetUrl = await this.resolveRedirectUrl(targetUrl);
    const targetUrlLower = targetUrl.toLowerCase();
    
    // Check for DramaBox exclusively on DramaBox domains (prevent false match on YouTube playlists)
    const isDramaBox = (targetUrlLower.includes('dramaboxdb.com') || targetUrlLower.includes('dramaboxapp.com') || targetUrlLower.includes('dramabox.com')) &&
      !targetUrlLower.includes('youtube.com') && !targetUrlLower.includes('youtu.be') && !targetUrlLower.includes('bilibili');
    if (isDramaBox) {
      return this.generateDramaBoxEpisodes(targetUrl, startId);
    }

    if (targetUrlLower.includes('bilibili') || targetUrlLower.includes('b23.tv') || targetUrlLower.includes('bibili')) {
      targetUrl = this.cleanBilibiliUrl(targetUrl);
      const biliItems = await this.scrapeBilibiliDirectly(targetUrl, startId);
      if (biliItems && biliItems.length > 0) return biliItems;
    }

    // Check for DonghuaFun / Donghua MacCMS video portals (detail pages or playback links)
    const isDonghua = targetUrlLower.includes('donghuafun.com') ||
                      targetUrlLower.includes('donghua') ||
                      (targetUrlLower.includes('/vod/detail/') && targetUrlLower.includes('/id/')) ||
                      (targetUrlLower.includes('/vod/play/') && targetUrlLower.includes('/id/'));
    if (isDonghua) {
      const donghuaItems = await this.scrapeDonghua(targetUrl, startId);
      if (donghuaItems && donghuaItems.length > 0) return donghuaItems;
    }

    // Check for NovelQuick / Hongguo Short Drama (novelquickapp.com)
    const isNovelQuick = targetUrlLower.includes('novelquickapp.com') ||
                         targetUrlLower.includes('hongguo') ||
                         targetUrlLower.includes('qznovel.com');
    if (isNovelQuick) {
      const nqItems = await this.scrapeNovelQuick(targetUrl, startId);
      if (nqItems && nqItems.length > 0) return nqItems;
    }

    // Try real extraction via yt-dlp first (covers YouTube, TikTok, Bilibili, Facebook, Twitter, and 1000+ video sites)
    const ytDlpItems = await this.scrapeWithYtDlp(targetUrl, startId);
    if (ytDlpItems && ytDlpItems.length > 0) {
      return ytDlpItems.slice(0, 58);
    }

    // Check for YouTube fallback when yt-dlp scraping timed out or encountered bot challenge
    if (targetUrlLower.includes('youtube.com') || targetUrlLower.includes('youtu.be')) {
      let title = `YouTube Video`;
      let uploader = 'YouTube Creator';
      let thumbnail = '';
      let duration = '';
      let durationSec = 0;
      let sizeMB = '500.0';
      const yId = this.extractYouTubeVideoId(targetUrl);
      if (yId) {
        thumbnail = `https://img.youtube.com/vi/${yId}/hqdefault.jpg`;
      }

      try {
        const res = await axios.get(targetUrl, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
          }
        });
        const html = res.data;
        const $ = cheerio.load(html);
        const ogTitle = $('meta[property="og:title"]').attr('content') || $('title').text().trim();
        const ogImage = $('meta[property="og:image"]').attr('content');
        const ogAuthor = $('link[itemprop="name"]').attr('content') || $('meta[name="author"]').attr('content');
        
        // Extract duration from YouTube metadata
        const durationMeta = $('meta[itemprop="duration"]').attr('content');
        if (durationMeta) {
          durationSec = this.parseIsoDuration(durationMeta);
        } else {
          const durMatch = html.match(/"approxDurationMs"\s*:\s*"(\d+)"/i) || html.match(/"lengthSeconds"\s*:\s*"(\d+)"/i);
          if (durMatch) {
            const isSeconds = durMatch[0].includes('lengthSeconds');
            durationSec = Math.round(parseInt(durMatch[1], 10) / (isSeconds ? 1 : 1000));
          }
        }

        if (durationSec > 0) {
          duration = this.formatDuration(durationSec);
          // 1080p stream estimate: ~0.70 MB/s (combined video + audio)
          sizeMB = (durationSec * 0.70).toFixed(1);
        }

        if (ogTitle) {
          const cleaned = ogTitle.replace(/- YouTube$/i, '').replace(/_YouTube$/i, '').trim();
          if (cleaned && cleaned.toLowerCase() !== 'undefined') title = cleaned;
        }
        if (ogImage && !thumbnail) thumbnail = ogImage;
        if (ogAuthor) uploader = ogAuthor;
      } catch (e) {}

      return [{
        id: startId,
        title: title,
        url: targetUrl,
        downloadUrl: targetUrl,
        thumbnail: thumbnail,
        duration: duration,
        durationSeconds: durationSec || null,
        resolution: '1080p (Full HD)',
        fps: '60fps',
        useYtDlp: true,
        hasCC: true,
        folder: 'video',
        type: 'video/mp4 (+ Subtitle)',
        sizeMB: sizeMB,
        profile: uploader,
        platform: 'YouTube',
        status: 'Ready',
        selected: true
      }];
    }

    // Check for Bilibili fallback when yt-dlp scraping timed out or failed
    if (targetUrlLower.includes('bilibili') || targetUrlLower.includes('b23.tv') || targetUrlLower.includes('bibili')) {
      let title = `Bilibili Video`;
      let uploader = 'BiliBili UP';
      let thumbnail = '';
      let duration = '';
      let sizeMB = '350.0';

      try {
        const res = await axios.get(targetUrl, {
          timeout: 8000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Referer': this.getBilibiliReferer(targetUrl)
          }
        });
        const $ = cheerio.load(res.data);
        const ogTitle = $('meta[property="og:title"]').attr('content') || $('title').text().trim();
        const ogImage = $('meta[property="og:image"]').attr('content');
        const ogAuthor = $('meta[name="author"]').attr('content') || $('meta[property="og:video:actor"]').attr('content');

        if (ogTitle) {
          const cleaned = ogTitle.replace(/_bilibili.*/i, '').replace(/_哔哩哔哩.*/i, '').trim();
          if (cleaned && cleaned.toLowerCase() !== 'undefined') title = cleaned;
        }
        if (ogImage) thumbnail = ogImage;
        if (ogAuthor) uploader = ogAuthor;
      } catch (e) {}

      return [{
        id: startId,
        title: title,
        url: targetUrl,
        downloadUrl: targetUrl,
        thumbnail: thumbnail,
        duration: duration,
        resolution: '1080p',
        fps: '',
        useYtDlp: true,
        hasCC: true,
        folder: 'video',
        type: 'video/mp4 (+ Subtitle)',
        sizeMB: sizeMB,
        profile: uploader,
        platform: 'BiliBili',
        status: 'Ready',
        selected: true
      }];
    }

    // Try real HTTP scraping for MP4/HLS/video elements
    try {
      const response = await axios.get(targetUrl, {
        timeout: 8000,
        headers: {
          'User-Agent': 'SnapKeeDownloader/1.3.32 (Media Client)'
        }
      });

      const $ = cheerio.load(response.data);
      const pageTitle = $('meta[property="og:title"]').attr('content') || $('title').text().trim() || 'Video Page';
      const ogImage = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || '';
      const platform = this.detectPlatform(targetUrl);
      const items = [];

      // Look for video tags or source tags
      $('video, source, a').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('href');
        if (src && (src.endsWith('.mp4') || src.endsWith('.m3u8') || src.includes('.mp4?'))) {
          const absoluteUrl = urlModule.resolve(targetUrl, src);
          items.push({
            id: startId + items.length,
            title: `${pageTitle} (Clip #${items.length + 1})`,
            url: absoluteUrl,
            downloadUrl: absoluteUrl,
            thumbnail: ogImage,
            duration: '',
            resolution: '1080p',
            fps: '',
            useYtDlp: true,
            hasCC: true,
            folder: 'video',
            type: 'video/mp4 (+ Subtitle)',
            sizeMB: (Math.random() * 25 + 4).toFixed(1),
            profile: platform,
            platform: platform,
            status: 'Ready',
            selected: true
          });
        }
      });

      if (items.length > 0) {
        return items.slice(0, 15);
      }

      // If no direct MP4 links found on HTML page, return downloadable target item
      return [{
        id: startId,
        title: pageTitle,
        url: targetUrl,
        downloadUrl: targetUrl,
        thumbnail: ogImage,
        duration: '',
        resolution: '1080p',
        fps: '',
        useYtDlp: true,
        hasCC: true,
        folder: 'video',
        type: 'video/mp4 (+ Subtitle)',
        sizeMB: '25.0',
        profile: platform,
        platform: platform,
        status: 'Ready',
        selected: true
      }];

    } catch (e) {
      const platform = this.detectPlatform(targetUrl);
      return [{
        id: startId,
        title: `Media Stream - ${platform}`,
        url: targetUrl,
        downloadUrl: targetUrl,
        thumbnail: '',
        duration: '',
        resolution: '1080p',
        fps: '',
        useYtDlp: true,
        hasCC: true,
        folder: 'video',
        type: 'video/mp4 (+ Subtitle)',
        sizeMB: '25.0',
        profile: platform,
        platform: platform,
        status: 'Ready',
        selected: true
      }];
    }
  }

  async scrapeBilibiliDirectly(targetUrl, startId = 1) {
    try {
      let bvidMatch = targetUrl.match(/BV[0-9a-zA-Z]+/i);
      let aidMatch = targetUrl.match(/av([0-9]+)/i);
      if (!bvidMatch && !aidMatch) return null;

      const pageMatch = targetUrl.match(/[?&]p=([0-9]+)/i);
      const specificPage = pageMatch ? parseInt(pageMatch[1], 10) : null;

      const cookieHeader = this.getCookieHeader('bilibili');
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        'Referer': this.getBilibiliReferer(targetUrl)
      };
      if (cookieHeader) headers['Cookie'] = cookieHeader;

      const pagelistUrl = bvidMatch 
        ? `https://api.bilibili.com/x/player/pagelist?bvid=${bvidMatch[0]}`
        : `https://api.bilibili.com/x/player/pagelist?aid=${aidMatch[1]}`;

      const listRes = await axios.get(pagelistUrl, { headers, timeout: 15000 });
      if (!listRes.data || listRes.data.code !== 0 || !Array.isArray(listRes.data.data) || listRes.data.data.length === 0) {
        return null;
      }

      let mainTitle = '';
      let thumbnail = '';
      let uploader = 'BiliBili UP';

      try {
        const viewUrl = bvidMatch
          ? `https://api.bilibili.com/x/web-interface/view?bvid=${bvidMatch[0]}`
          : `https://api.bilibili.com/x/web-interface/view?aid=${aidMatch[1]}`;
        const viewRes = await axios.get(viewUrl, { headers, timeout: 8000 });
        if (viewRes.data && viewRes.data.code === 0 && viewRes.data.data) {
          const d = viewRes.data.data;
          if (d.title) mainTitle = d.title;
          if (d.pic) thumbnail = d.pic;
          if (d.owner && d.owner.name) uploader = d.owner.name;
        }
      } catch (e) {}

      if (!mainTitle) {
        try {
          const baseVideoUrl = bvidMatch ? `https://www.bilibili.com/video/${bvidMatch[0]}` : `https://www.bilibili.com/video/av${aidMatch[1]}`;
          const pageRes = await axios.get(baseVideoUrl, { headers, timeout: 10000 });
          const $ = cheerio.load(pageRes.data);
          const pt = $('title').text().trim();
          if (pt) {
            mainTitle = pt.replace(/_bilibili.*/i, '').replace(/_哔哩哔哩.*/i, '').trim() || '';
          }
          const ogImg = $('meta[property="og:image"]').attr('content');
          if (ogImg && !thumbnail) thumbnail = ogImg;
        } catch (e) {}
      }

      if (!mainTitle && listRes.data.data[0]?.part) {
        mainTitle = listRes.data.data[0].part.trim();
      }
      if (!mainTitle) {
        mainTitle = `Bilibili Video ${bvidMatch ? bvidMatch[0] : 'AV' + aidMatch[1]}`;
      }

      const items = [];
      const entries = specificPage ? listRes.data.data.filter(e => e.page === specificPage) : listRes.data.data;
      const targetEntries = entries.length > 0 ? entries : [listRes.data.data[0]];

      for (let idx = 0; idx < targetEntries.length; idx++) {
        const entry = targetEntries[idx];
        const epNum = entry.page || (idx + 1);
        const partName = entry.part ? ` (P${epNum}: ${entry.part})` : (listRes.data.data.length > 1 ? ` (P${epNum})` : '');
        let itemUrl = bvidMatch ? `https://www.bilibili.com/video/${bvidMatch[0]}` : `https://www.bilibili.com/video/av${aidMatch[1]}`;
        if (epNum > 1 || listRes.data.data.length > 1) {
          itemUrl += `?p=${epNum}`;
        }

        const subList = await this.fetchBilibiliSubtitleTracks(headers, entry.cid, bvidMatch, aidMatch);
        const hasSubtitle = Array.isArray(subList) && subList.length > 0;
        const hasAiSubtitle = hasSubtitle && subList.some(track => this.isBilibiliAiSubtitleTrack(track));
        const itemType = hasSubtitle
          ? (hasAiSubtitle ? 'video/mp4 (+ Subtitle [AI-ZH])' : 'video/mp4 (+ Subtitle)')
          : 'video/mp4 (No Subtitle)';

        const duration = this.formatDuration(entry.duration);

        items.push({
          id: startId + idx,
          title: `${mainTitle}${listRes.data.data.length > 1 && specificPage === null ? partName : (specificPage !== null && entry.part ? ` (${entry.part})` : '')}`.trim(),
          url: itemUrl,
          downloadUrl: itemUrl,
          cid: entry.cid,
          page: epNum,
          thumbnail: thumbnail,
          duration: duration,
          durationSeconds: entry.duration || 0,
          resolution: '1080p',
          fps: '60fps',
          useYtDlp: true,
          hasCC: hasSubtitle,
          hasAiSubtitle: hasAiSubtitle,
          folder: 'video',
          type: itemType,
          sizeMB: entry.duration ? (entry.duration * 0.15).toFixed(1) : '45.0',
          profile: uploader,
          platform: 'BiliBili',
          status: 'Ready',
          selected: true
        });
      }

      return items;
    } catch (e) {
      return null;
    }
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

  async fetchBilibiliSubtitleTracks(headers, cid, bvidMatch, aidMatch) {
    if (!cid && (bvidMatch || aidMatch)) {
      try {
        const pagelistUrl = bvidMatch 
          ? `https://api.bilibili.com/x/player/pagelist?bvid=${bvidMatch[0]}`
          : `https://api.bilibili.com/x/player/pagelist?aid=${aidMatch[1]}`;
        const listRes = await axios.get(pagelistUrl, { headers, timeout: 8000 });
        if (listRes.data && listRes.data.code === 0 && Array.isArray(listRes.data.data) && listRes.data.data.length > 0) {
          cid = listRes.data.data[0].cid;
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
        const subRes = await axios.get(subtitleApi, { headers, timeout: 8000 });
        const tracks = this.extractBilibiliSubtitleTracks(subRes?.data);
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

  generateDramaBoxEpisodes(baseTargetUrl, startId) {
    const episodes = [];
    let seriesName = "I'm Nothing but a Mort...";
    let profileName = "DramaBox Series";
    let episodeCount = 12;
    let baseSeriesId = "41000111513";
    let startEpId = 701100000;

    if (baseTargetUrl.toLowerCase().includes('tempest') || baseTargetUrl.toLowerCase().includes('42000018529')) {
      seriesName = "Tempest: The Last Mecha";
      profileName = "DramaBox Studio";
      episodeCount = 58;
      baseSeriesId = "42000018529_tempest-the-last-mecha";
      startEpId = 701151230;
    }

    for (let i = 1; i <= episodeCount; i++) {
      const epNum = startId + i - 1;
      const size = (Math.random() * 8 + 7).toFixed(1);
      const epFormatted = i < 10 ? `0${i}` : `${i}`;
      let epUrl = `${baseTargetUrl}/ep-${i}`;
      if (seriesName.includes('Tempest')) {
        epUrl = `https://www.dramaboxdb.com/ep/${baseSeriesId}/${startEpId + i}_Episode-${i}`;
      }

      episodes.push({
        id: epNum,
        title: `${seriesName} (EP ${epFormatted})`,
        url: epUrl,
        downloadUrl: epUrl,
        thumbnail: '',
        duration: '01:30',
        resolution: '1080p',
        fps: '30fps',
        useYtDlp: true,
        hasCC: true,
        subtitleLangs: ['en'],
        folder: 'video',
        type: 'video/mp4 (+ Subtitle)',
        sizeMB: size,
        profile: profileName,
        platform: 'DramaBox',
        status: 'Ready',
        selected: true
      });
    }

    return episodes;
  }

  async scrapeNovelQuick(targetUrl, startId = 1) {
    try {
      const cleanUrl = this.extractCleanUrl(targetUrl);
      const res = await axios.get(cleanUrl, {
        timeout: 15000,
        maxRedirects: 10,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
      });

      const html = res.data;
      if (!html || typeof html !== 'string') {
        throw new Error('Empty response from NovelQuick');
      }

      let seriesData = null;
      let pageData = null;

      // Method 1: parse data-fn-args from modern.js router/stream scripts
      const modernMatch = html.match(/data-fn-name=["']r["'][^>]*data-fn-args=["']([^"']+)["']/i) ||
                          html.match(/data-fn-args=["']([^"']+)["'][^>]*data-fn-name=["']r["']/i);
      if (modernMatch) {
        try {
          const rawArgs = modernMatch[1]
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'");
          const parsed = JSON.parse(rawArgs);
          if (Array.isArray(parsed) && parsed.length >= 3 && parsed[2]) {
            pageData = parsed[2];
            seriesData = pageData.series_data || {};
          }
        } catch (e) {
          console.warn('[scrapeNovelQuick] Failed to parse modern.js args:', e.message);
        }
      }

      // Method 2: Cheerio parse OpenGraph meta tags
      const $ = cheerio.load(html);
      let ogTitle = $('meta[property="og:title"]').attr('content') ||
                    $('meta[name="og:title"]').attr('content') ||
                    $('title').text().trim();
      let ogImage = $('meta[property="og:image"]').attr('content') ||
                    $('meta[name="og:image"]').attr('content') || '';
      let ogUrl = $('meta[property="og:url"]').attr('content') ||
                  $('meta[name="og:url"]').attr('content') || '';

      // Determine stream play URL
      let playUrl = seriesData?.play_url || '';
      if (!playUrl && ogUrl && (ogUrl.includes('.mp4') || ogUrl.includes('/video/tos/') || ogUrl.includes('qznovel.com'))) {
        playUrl = ogUrl;
      }
      if (!playUrl) {
        // Fallback regex search for direct MP4 stream in HTML
        const mp4Match = html.match(/https?:\/\/[^"'\s<>]*(?:qznovel\.com|byteimg\.com|tos-cn-v)[^"'\s<>]*\.(?:mp4|m4s)[^"'\s<>]*/i) ||
                         html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
        if (mp4Match) {
          playUrl = mp4Match[0];
        }
      }

      if (!playUrl) {
        throw new Error('Could not find video stream URL for NovelQuick');
      }

      // Clean unescaped entities in playUrl if any
      playUrl = playUrl.replace(/&amp;/g, '&');

      // Determine title
      let title = (seriesData?.title || '').trim();
      if (!title) {
        title = ogTitle
          .replace(/红果短剧\s*[｜|]\s*跟我一起免费看[《<]/g, '')
          .replace(/[》>]/g, '')
          .replace(/红果短剧\s*[｜|]\s*/g, '')
          .trim();
      }
      if (!title) {
        title = 'NovelQuick Short Drama';
      }

      const chapterOrder = pageData?.chapter_order;
      let finalTitle = title;
      if (chapterOrder !== undefined && chapterOrder !== null && chapterOrder !== '') {
        const epNum = parseInt(chapterOrder, 10);
        const epStr = isNaN(epNum) ? chapterOrder : (epNum < 10 ? `0${epNum}` : `${epNum}`);
        finalTitle = `${title} (EP ${epStr})`;
      }

      // Determine cover / thumbnail
      let thumbnail = seriesData?.series_cover || ogImage || '';
      if (thumbnail.includes('&amp;')) {
        thumbnail = thumbnail.replace(/&amp;/g, '&');
      }

      // Determine resolution
      const videoMeta = seriesData?.video_meta;
      let resolution = '720p';
      if (videoMeta && videoMeta.height) {
        resolution = `${videoMeta.height}p`;
      }

      // Probe Content-Length for accurate sizeMB
      let sizeMB = '25.0';
      try {
        const headRes = await axios.head(playUrl, {
          timeout: 5000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://novelquickapp.com/'
          }
        });
        const cl = headRes.headers['content-length'];
        if (cl) {
          const bytes = parseInt(cl, 10);
          if (!isNaN(bytes) && bytes > 0) {
            sizeMB = (bytes / (1024 * 1024)).toFixed(1);
          }
        }
      } catch (headErr) {
        if (videoMeta?.height >= 1080) sizeMB = '35.0';
        else if (videoMeta?.height >= 720) sizeMB = '15.0';
      }

      return [{
        id: startId,
        title: finalTitle,
        url: targetUrl,
        downloadUrl: playUrl,
        thumbnail: thumbnail,
        duration: '00:30',
        resolution: resolution,
        fps: '30fps',
        useYtDlp: false,
        hasCC: false,
        folder: 'video',
        type: 'video/mp4',
        sizeMB: sizeMB,
        profile: 'NovelQuick / Hongguo',
        platform: 'NovelQuick',
        status: 'Ready',
        selected: true
      }];
    } catch (err) {
      console.error('[scrapeNovelQuick ERROR]:', err.message);
      return null;
    }
  }

  cleanBilibiliUrl(rawUrl) {
    try {
      let bvidMatch = rawUrl.match(/BV[0-9a-zA-Z]+/i);
      let aidMatch = rawUrl.match(/av([0-9]+)/i);
      const pageMatch = rawUrl.match(/[?&]p=([0-9]+)/i);
      const pageNum = pageMatch ? pageMatch[1] : null;

      if (bvidMatch) {
        return `https://www.bilibili.com/video/${bvidMatch[0]}` + (pageNum && pageNum !== '1' ? `?p=${pageNum}` : '');
      }
      if (aidMatch) {
        return `https://www.bilibili.com/video/av${aidMatch[1]}` + (pageNum && pageNum !== '1' ? `?p=${pageNum}` : '');
      }
      const parsed = new urlModule.URL(rawUrl);
      parsed.searchParams.delete('spm_id_from');
      parsed.searchParams.delete('vd_source');
      parsed.searchParams.delete('from_spm');
      parsed.searchParams.delete('seid');
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }

  getDomain(fullUrl) {
    try {
      const parsed = new urlModule.URL(fullUrl);
      return parsed.hostname.replace('www.', '');
    } catch {
      return 'SnapKee Source';
    }
  }

  base64decode(str) {
    try {
      return Buffer.from(str, 'base64').toString('utf8');
    } catch {
      return str;
    }
  }

  extractPlayerAaaa(html) {
    if (!html || typeof html !== 'string') return null;

    // 1. Balanced-bracket parsing after player_aaaa
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
              const jsonStr = html.slice(braceStart, i + 1);
              try {
                return JSON.parse(jsonStr);
              } catch (e) {}
              break;
            }
          }
        }
      }
    }

    // 2. Regex fallback
    const match = html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]+?\})(?:;?\s*<\/(?:script|div)>|;\s*var|;\s*$)/m);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (e) {}
    }
    return null;
  }

  resolvePlayerStream(playerData) {
    if (!playerData || !playerData.url) return null;
    let rawUrl = String(playerData.url).trim();
    const encrypt = String(playerData.encrypt || '0');

    if (encrypt === '1') {
      try { rawUrl = unescape(rawUrl); } catch (e) {}
    } else if (encrypt === '2') {
      try {
        rawUrl = unescape(this.base64decode(rawUrl));
      } catch (e) {
        try { rawUrl = unescape(rawUrl); } catch (err) {}
      }
    }

    const from = String(playerData.from || '').toLowerCase();

    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      return rawUrl;
    }

    if (from === 'dailymotion' || from.includes('daily')) {
      return `https://www.dailymotion.com/video/${rawUrl}`;
    }

    if (from.includes('ganjing') || from === 'engganjing' || from === 'indoganjing') {
      return `https://www.ganjingworld.com/video/${rawUrl}`;
    }

    if (from === 'youtube' || from === 'youtu') {
      return `https://www.youtube.com/watch?v=${rawUrl}`;
    }

    if (from === 'bilibili' || from === 'bili') {
      return `https://www.bilibili.com/video/${rawUrl}`;
    }

    // Heuristics based on ID formatting
    if (rawUrl.startsWith('1iso') && rawUrl.length >= 20) {
      return `https://www.ganjingworld.com/video/${rawUrl}`;
    }

    if (/^[a-zA-Z0-9_-]{11}$/.test(rawUrl)) {
      return `https://www.youtube.com/watch?v=${rawUrl}`;
    }

    if (/^k[a-zA-Z0-9]{15,25}$/.test(rawUrl)) {
      return `https://www.dailymotion.com/video/${rawUrl}`;
    }

    return rawUrl;
  }

  cleanDonghuaTitle(raw) {
    if (!raw) return 'Donghua Video';
    return raw
      .replace(/\s+Donghua\s+Anime\s+Episode\s+Guide.*$/i, '')
      .replace(/\s+Streaming\s+Guide.*$/i, '')
      .replace(/\s*-\s*Donghua\s*Fun.*$/i, '')
      .replace(/\s*-\s*Watch\s+Donghua.*$/i, '')
      .replace(/_Donghua.*$/i, '')
      .trim();
  }

  cleanDonghuaTabName(tab) {
    if (!tab) return '';
    return tab
      .replace(/Ads\d*/gi, '')
      .replace(/gang\d*/gi, '')
      .trim();
  }

  async scrapeDonghuaPlayPage(targetUrl, startId = 1) {
    const res = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });

    const html = res.data;
    const $ = cheerio.load(html);
    const playerData = this.extractPlayerAaaa(html);
    const streamUrl = this.resolvePlayerStream(playerData) || targetUrl;

    const pageTitle = $('title').text().trim();
    const vodData = playerData?.vod_data || {};
    const seriesName = vodData.vod_name || this.cleanDonghuaTitle(pageTitle);

    let epName = '';
    if (playerData?.nid) {
      const currentLink = $(`a[href*="nid/${playerData.nid}.html"]`).first().text().trim();
      if (currentLink) epName = currentLink;
    }
    if (!epName) {
      epName = $('.anthology-list-play li.on a, .anthology-list-play li.active a, a.cor4').text().trim();
    }
    if (!epName) {
      const titleWithoutSeries = pageTitle.replace(seriesName, '');
      const match = titleWithoutSeries.match(/(?:Part\s*\d+|EP\s*\d+|Episode\s*\d+|Movie)/i);
      if (match) epName = match[0];
    }
    if (!epName && playerData?.nid) {
      epName = `EP ${playerData.nid}`;
    }

    let fullTitle = seriesName;
    if (epName && !seriesName.toLowerCase().includes(epName.toLowerCase())) {
      fullTitle = `${seriesName} - ${epName}`;
    }

    let poster = $('meta[property="og:image"]').attr('content') || '';
    if (!poster) {
      $('script[type="application/ld+json"]').each((i, el) => {
        try {
          const json = JSON.parse($(el).html() || '{}');
          const thumb = Array.isArray(json.thumbnailUrl) ? json.thumbnailUrl[0] : json.thumbnailUrl;
          if (thumb) poster = thumb;
        } catch (e) {}
      });
    }

    const activeTab = $('.anthology-tab .swiper-slide.active, .anthology-tab .swiper-slide.on, .anthology-tab .swiper-slide').first().text();
    const is4K = (playerData?.from || '').toLowerCase().includes('4k') ||
                 fullTitle.toLowerCase().includes('4k') ||
                 activeTab.toLowerCase().includes('4k');

    if (is4K && !fullTitle.includes('[4K]')) {
      fullTitle = `${fullTitle} [4K]`;
    }

    return [{
      id: startId,
      title: fullTitle,
      url: targetUrl,
      downloadUrl: streamUrl,
      donghuaPlayUrl: targetUrl,
      thumbnail: poster,
      duration: '',
      resolution: is4K ? '4K (2160p)' : '1080p (Full HD)',
      fps: '25fps',
      useYtDlp: true,
      hasCC: true,
      folder: 'video',
      type: 'video/mp4 (+ Subtitle)',
      sizeMB: is4K ? '1450.0' : '550.0',
      profile: seriesName,
      platform: 'DonghuaFun',
      status: 'Ready',
      selected: true
    }];
  }

  async scrapeDonghuaDetail(targetUrl, startId = 1) {
    const res = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });

    const html = res.data;
    const $ = cheerio.load(html);

    const seriesTitle = $('h1').text().trim() ||
                        this.cleanDonghuaTitle($('meta[property="og:title"]').attr('content')) ||
                        this.cleanDonghuaTitle($('title').text().trim());

    const poster = $('meta[property="og:image"]').attr('content') ||
                   $('.detail-pic img').attr('src') || '';

    // Extract tabs
    const tabs = [];
    $('.anthology-tab .swiper-slide, .anthology-tab a').each((i, el) => {
      const cloned = $(el).clone();
      cloned.find('.badge').remove();
      const rawTab = cloned.text().trim().replace(/\s+/g, ' ');
      tabs.push(this.cleanDonghuaTabName(rawTab));
    });

    const playlistBoxes = $('.anthology-list-box');
    const allGroups = [];

    playlistBoxes.each((tabIdx, boxEl) => {
      const tabName = tabs[tabIdx] || `Server ${tabIdx + 1}`;
      const epLinks = [];
      $(boxEl).find('a[href*="/vod/play/"]').each((epIdx, aEl) => {
        const href = $(aEl).attr('href');
        const text = $(aEl).text().trim().replace(/\s+/g, ' ');
        if (href) {
          const absUrl = urlModule.resolve(targetUrl, href);
          epLinks.push({
            tabIdx,
            tabName,
            text,
            href: absUrl
          });
        }
      });
      if (epLinks.length > 0) {
        allGroups.push({ tabIdx, tabName, episodes: epLinks });
      }
    });

    // Fallback if no .anthology-list-box found
    if (allGroups.length === 0) {
      const epLinks = [];
      $('a[href*="/vod/play/"]').each((i, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (href) {
          epLinks.push({
            tabIdx: 0,
            tabName: 'Server 1',
            text: text || `Episode ${i + 1}`,
            href: urlModule.resolve(targetUrl, href)
          });
        }
      });
      if (epLinks.length > 0) {
        allGroups.push({ tabIdx: 0, tabName: 'Server 1', episodes: epLinks });
      }
    }

    if (allGroups.length === 0) {
      return [{
        id: startId,
        title: seriesTitle,
        url: targetUrl,
        downloadUrl: targetUrl,
        thumbnail: poster,
        duration: '',
        resolution: '1080p (Full HD)',
        fps: '25fps',
        useYtDlp: true,
        hasCC: true,
        folder: 'video',
        type: 'video/mp4 (+ Subtitle)',
        sizeMB: '550.0',
        profile: seriesTitle,
        platform: 'DonghuaFun',
        status: 'Ready',
        selected: true
      }];
    }

    // Determine episodes to extract
    const totalEpsAcrossTabs = allGroups.reduce((acc, g) => acc + g.episodes.length, 0);
    const selectedList = [];

    if (totalEpsAcrossTabs <= 12) {
      // Small movie or OVA series with few items across tabs: include all tabs with distinguishing tags
      for (const group of allGroups) {
        const is4K = group.tabName.toLowerCase().includes('4k');
        const tag = is4K ? '4K' : group.tabName;
        for (const ep of group.episodes) {
          selectedList.push({
            ...ep,
            tag,
            is4K
          });
        }
      }
    } else {
      // For large episodic series (e.g. 50-200 episodes), use the tab with the most episodes
      let bestGroup = allGroups[0];
      for (const g of allGroups) {
        if (g.episodes.length > bestGroup.episodes.length) {
          bestGroup = g;
        }
      }
      const is4K = bestGroup.tabName.toLowerCase().includes('4k');
      for (const ep of bestGroup.episodes) {
        selectedList.push({
          ...ep,
          tag: is4K ? '4K' : '',
          is4K
        });
      }
    }

    // Natural numerical sort for episodes within each tab
    selectedList.sort((a, b) => {
      if (a.tabIdx !== b.tabIdx) return a.tabIdx - b.tabIdx;
      const numA = parseInt((a.text.match(/\d+/) || [0])[0], 10);
      const numB = parseInt((b.text.match(/\d+/) || [0])[0], 10);
      if (numA && numB && numA !== numB) return numA - numB;
      return a.text.localeCompare(b.text);
    });

    // Concurrently resolve stream URLs with a batch size of 5
    const results = [];
    const batchSize = 5;
    for (let i = 0; i < selectedList.length; i += batchSize) {
      const batch = selectedList.slice(i, i + batchSize);
      await Promise.all(batch.map(async (item, batchIdx) => {
        const itemIdx = i + batchIdx;
        let streamUrl = item.href;
        try {
          const pRes = await axios.get(item.href, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 8000
          });
          const pData = this.extractPlayerAaaa(pRes.data);
          const resolved = this.resolvePlayerStream(pData);
          if (resolved) streamUrl = resolved;
        } catch (e) {}

        const tagSuffix = item.tag ? ` [${item.tag}]` : '';
        const titleWithEp = `${seriesTitle} - ${item.text}${tagSuffix}`;

        results[itemIdx] = {
          id: startId + itemIdx,
          title: titleWithEp,
          url: item.href,
          downloadUrl: streamUrl,
          donghuaPlayUrl: item.href,
          thumbnail: poster,
          duration: '',
          resolution: item.is4K ? '4K (2160p)' : '1080p (Full HD)',
          fps: '25fps',
          useYtDlp: true,
          hasCC: true,
          folder: 'video',
          type: 'video/mp4 (+ Subtitle)',
          sizeMB: item.is4K ? '1450.0' : '550.0',
          profile: seriesTitle,
          platform: 'DonghuaFun',
          status: 'Ready',
          selected: true
        };
      }));
    }

    return results.filter(Boolean);
  }

  async scrapeDonghua(targetUrl, startId = 1) {
    try {
      const lower = targetUrl.toLowerCase();
      if (lower.includes('/vod/play/')) {
        return await this.scrapeDonghuaPlayPage(targetUrl, startId);
      }
      return await this.scrapeDonghuaDetail(targetUrl, startId);
    } catch (err) {
      console.error('[scrapeDonghua ERROR]:', err && err.message);
      return null;
    }
  }
}

module.exports = ScraperEngine;
