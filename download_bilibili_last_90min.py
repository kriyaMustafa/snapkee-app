import os
import sys
import re
import time
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).parent.resolve()
DOWNLOADS_DIR = BASE_DIR / "Downloads"
DOWNLOADS_DIR.mkdir(exist_ok=True)

VIDEO_URL = "https://www.bilibili.com/video/BV1mJh763EAS?p=2"
COOKIES_FILE = BASE_DIR / "www.bilibili.com_cookies.txt"
if not COOKIES_FILE.exists():
    COOKIES_FILE = BASE_DIR / "bilibili_cookies.txt"

YT_DLP = str(BASE_DIR / "bin" / "yt-dlp.exe")
if not os.path.exists(YT_DLP):
    YT_DLP = "yt-dlp"

FFMPEG = str(BASE_DIR / "bin" / "ffmpeg.exe")
if not os.path.exists(FFMPEG):
    FFMPEG = "ffmpeg"

# Timing calculation:
# Total duration = 35911 seconds (09:58:31)
# 90 minutes = 5400 seconds
# Start = 35911 - 5400 = 30511 seconds (08:28:31)
START_SECONDS = 30511.0
START_TIME_STR = "08:28:31"

BASENAME = "BV1mJh763EAS_p02_last_90min"
OUTPUT_MP4 = DOWNLOADS_DIR / f"{BASENAME}.mp4"
OUTPUT_MKV = DOWNLOADS_DIR / f"{BASENAME}_with_subtitles.mkv"
ZH_SRT = DOWNLOADS_DIR / f"{BASENAME}.zh.srt"

def parse_srt_timestamp(ts: str) -> float:
    ts = ts.strip().replace(',', '.')
    parts = ts.split(':')
    if len(parts) == 3:
        h, m, s = parts
        return float(h) * 3600 + float(m) * 60 + float(s)
    elif len(parts) == 2:
        m, s = parts
        return float(m) * 60 + float(s)
    return float(parts[0])

def format_srt_timestamp(seconds: float) -> str:
    if seconds < 0:
        seconds = 0.0
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis >= 1000:
        seconds += 1
        millis = 0
    secs = int(seconds)
    hours = secs // 3600
    minutes = (secs % 3600) // 60
    s = secs % 60
    return f"{hours:02d}:{minutes:02d}:{s:02d},{millis:03d}"

def step1_fetch_and_trim_subtitles():
    print("=" * 60)
    print(f"STEP 1: Downloading & Trimming Subtitles (Offset -{START_TIME_STR})...")
    print("=" * 60)

    raw_prefix = DOWNLOADS_DIR / f"{BASENAME}_raw_sub"
    cmd = [
        YT_DLP,
        "--skip-download",
        "--write-subs",
        "--sub-langs", "ai-zh",
        "--sub-format", "srt",
        "-o", f"{raw_prefix}.%(ext)s",
        VIDEO_URL
    ]
    if COOKIES_FILE.exists():
        cmd.extend(["--cookies", str(COOKIES_FILE)])

    print(f"Fetching subtitle track with yt-dlp...")
    subprocess.run(cmd, check=True)

    raw_srt = DOWNLOADS_DIR / f"{BASENAME}_raw_sub.ai-zh.srt"
    if not raw_srt.exists():
        candidates = list(DOWNLOADS_DIR.glob(f"{BASENAME}_raw_sub*.srt"))
        if candidates:
            raw_srt = candidates[0]

    if not raw_srt.exists():
        print("Warning: Could not find downloaded subtitle file.")
        return

    content = raw_srt.read_text(encoding="utf-8", errors="ignore")
    blocks = re.split(r'\r?\n\r?\n', content.strip())
    time_pat = re.compile(r'(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})')

    filtered_blocks = []
    counter = 1
    for block in blocks:
        lines = [l.strip() for l in block.splitlines() if l.strip()]
        if len(lines) < 2:
            continue
        m = None
        t_idx = -1
        for i, l in enumerate(lines):
            m = time_pat.search(l)
            if m:
                t_idx = i
                break
        if not m:
            continue

        start_sec = parse_srt_timestamp(m.group(1))
        end_sec = parse_srt_timestamp(m.group(2))

        # Check if cue overlaps with the clipped range
        if end_sec < START_SECONDS:
            continue

        shifted_start = max(0.0, start_sec - START_SECONDS)
        shifted_end = max(shifted_start + 0.1, end_sec - START_SECONDS)

        s_str = format_srt_timestamp(shifted_start)
        e_str = format_srt_timestamp(shifted_end)
        text = "\n".join(lines[t_idx + 1:])

        filtered_blocks.append(f"{counter}\n{s_str} --> {e_str}\n{text}")
        counter += 1

    ZH_SRT.write_text("\n\n".join(filtered_blocks) + "\n", encoding="utf-8")
    print(f"Successfully trimmed and shifted {len(filtered_blocks)} subtitle cues!")
    print(f"Saved synchronized subtitle: {ZH_SRT.name} ({ZH_SRT.stat().st_size / 1024:.1f} KB)")

    # Clean up raw temp srt
    for p in DOWNLOADS_DIR.glob(f"{BASENAME}_raw_sub*"):
        try:
            p.unlink()
        except Exception:
            pass

def step2_download_video_clip():
    print("\n" + "=" * 60)
    print(f"STEP 2: Downloading Video Clip ({START_TIME_STR} to End, 90 mins)...")
    print("=" * 60)

    part_file = Path(str(OUTPUT_MP4) + ".part")
    if part_file.exists():
        try:
            part_file.unlink()
        except Exception:
            pass

    cmd = [
        YT_DLP,
        "--add-header", "Referer: https://www.bilibili.com/",
        "-f", "bestvideo[height<=1080]+bestaudio/best",
        "--download-sections", f"*{START_TIME_STR}-09:58:31",
        "--retries", "10",
        "--fragment-retries", "10",
        "--merge-output-format", "mp4",
        "-o", str(OUTPUT_MP4),
        VIDEO_URL
    ]
    if COOKIES_FILE.exists():
        cmd.extend(["--cookies", str(COOKIES_FILE)])

    print(f"Executing: {' '.join(cmd)}")
    t0 = time.time()
    subprocess.run(cmd, check=True)
    if OUTPUT_MP4.exists():
        size_mb = OUTPUT_MP4.stat().st_size / (1024 * 1024)
        print(f"\nDownload finished in {time.time()-t0:.1f}s. Size: {size_mb:.2f} MB")

def step3_mux_mkv():
    if not OUTPUT_MP4.exists() or not ZH_SRT.exists():
        return
    print("\n" + "=" * 60)
    print("STEP 3: Muxing MKV with Embedded Subtitle (Direct Stream Copy)...")
    print("=" * 60)

    cmd = [
        FFMPEG, "-y",
        "-i", str(OUTPUT_MP4),
        "-i", str(ZH_SRT),
        "-map", "0:v", "-map", "0:a", "-map", "1:s",
        "-c:v", "copy",
        "-c:a", "copy",
        "-c:s", "srt",
        "-metadata:s:s:0", "title=Chinese (AI-ZH)",
        "-metadata:s:s:0", "language=chi",
        "-disposition:s:0", "default",
        str(OUTPUT_MKV)
    ]
    subprocess.run(cmd, check=True)
    if OUTPUT_MKV.exists():
        size_mb = OUTPUT_MKV.stat().st_size / (1024 * 1024)
        print(f"Muxed container created: {OUTPUT_MKV.name} ({size_mb:.2f} MB)")

if __name__ == "__main__":
    t_start = time.time()
    step1_fetch_and_trim_subtitles()
    step2_download_video_clip()
    step3_mux_mkv()
    print("\n" + "=" * 60)
    print(f"ALL STEPS COMPLETED in {time.time()-t_start:.1f}s!")
    print(f"Outputs located in: {DOWNLOADS_DIR}")
    print("=" * 60)
