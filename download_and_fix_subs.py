import os
import sys
import re
import time
import json
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).parent.resolve()
DOWNLOADS_DIR = BASE_DIR / "Downloads"
DOWNLOADS_DIR.mkdir(exist_ok=True)

VIDEO_URL = "https://youtu.be/eRjs_sAk2V4"
START_SECONDS = 32400.0  # 9 hours (09:00:00)
BASENAME = "Kaiju_Huode_Quanxi_Xitong_09h_to_end"

OUTPUT_MP4 = DOWNLOADS_DIR / f"{BASENAME}.mp4"
OUTPUT_MKV = DOWNLOADS_DIR / f"{BASENAME}_with_subtitles.mkv"
ZH_SRT = DOWNLOADS_DIR / f"{BASENAME}.zh.srt"
EN_SRT = DOWNLOADS_DIR / f"{BASENAME}.en.srt"
DUAL_SRT = DOWNLOADS_DIR / f"{BASENAME}.dual.srt"

YT_DLP = str(BASE_DIR / "bin" / "yt-dlp.exe")
if not os.path.exists(YT_DLP):
    YT_DLP = "yt-dlp"

COOKIES_FILE = BASE_DIR / "www.youtube.com_cookies.txt"

def parse_time(time_str: str) -> float:
    time_str = time_str.strip().replace(',', '.')
    parts = time_str.split(':')
    if len(parts) == 3:
        h, m, s = parts
        return float(h) * 3600 + float(m) * 60 + float(s)
    elif len(parts) == 2:
        m, s = parts
        return float(m) * 60 + float(s)
    return float(parts[0])

def format_timestamp(seconds: float) -> str:
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

def parse_srt_file(filepath: Path):
    if not filepath.exists():
        return []
    content = filepath.read_text(encoding="utf-8", errors="ignore")
    blocks = re.split(r'\r?\n\r?\n', content.strip())
    entries = []
    time_pat = re.compile(r'(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,\.]\d{3})')
    
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        time_match = None
        text_lines = []
        for line in lines:
            m = time_pat.search(line)
            if m:
                time_match = m
            elif not line.isdigit() and time_match:
                text_lines.append(line)
            elif not time_match and not line.isdigit():
                # Some malformed blocks
                text_lines.append(line)
        
        if time_match:
            start_sec = parse_time(time_match.group(1))
            end_sec = parse_time(time_match.group(2))
            text = " ".join(text_lines).strip()
            if text:
                entries.append({
                    "start": start_sec,
                    "end": end_sec,
                    "text": text
                })
    return entries

def shift_and_filter_subtitles(entries, offset_seconds: float):
    shifted = []
    for e in entries:
        # If the subtitle ended before the cutoff, skip it
        if e["end"] <= offset_seconds:
            continue
        
        # New start and end
        new_start = max(0.0, e["start"] - offset_seconds)
        new_end = max(new_start + 0.1, e["end"] - offset_seconds)
        
        shifted.append({
            "start": new_start,
            "end": new_end,
            "text": e["text"]
        })
    return shifted

def write_srt(entries, out_path: Path):
    with open(out_path, "w", encoding="utf-8") as f:
        for idx, e in enumerate(entries, 1):
            s_str = format_timestamp(e["start"])
            e_str = format_timestamp(e["end"])
            f.write(f"{idx}\n{s_str} --> {e_str}\n{e['text']}\n\n")
    print(f"  [SRT] Wrote {len(entries)} entries to {out_path.name}")

def write_dual_srt(zh_entries, en_entries, out_path: Path):
    merged = []
    en_idx = 0
    en_len = len(en_entries)
    
    for zh in zh_entries:
        mid = (zh["start"] + zh["end"]) / 2
        # Advance en_idx until it is near mid
        while en_idx < en_len and en_entries[en_idx]["end"] < zh["start"]:
            en_idx += 1
            
        matched_en = []
        look_idx = en_idx
        while look_idx < en_len and en_entries[look_idx]["start"] <= zh["end"] + 1.5:
            e = en_entries[look_idx]
            if (e["start"] <= mid <= e["end"]) or (abs(e["start"] - zh["start"]) < 1.5):
                matched_en.append(e["text"])
            look_idx += 1
            
        en_text = " ".join(matched_en).strip() if matched_en else ""
        merged.append({
            "start": zh["start"],
            "end": zh["end"],
            "zh": zh["text"],
            "en": en_text
        })
    with open(out_path, "w", encoding="utf-8") as f:
        for idx, item in enumerate(merged, 1):
            s_str = format_timestamp(item["start"])
            e_str = format_timestamp(item["end"])
            text_body = item["zh"]
            if item["en"]:
                text_body += f"\n{item['en']}"
            f.write(f"{idx}\n{s_str} --> {e_str}\n{text_body}\n\n")
    print(f"  [Dual SRT] Wrote {len(merged)} bilingual entries to {out_path.name}")

def step1_fetch_and_fix_subtitles():
    if ZH_SRT.exists() and EN_SRT.exists() and DUAL_SRT.exists() and ZH_SRT.stat().st_size > 1000:
        print("=" * 60)
        print("STEP 1: Subtitle files already synchronized!")
        print(f"  Chinese: {ZH_SRT.name} ({ZH_SRT.stat().st_size / 1024:.1f} KB)")
        print(f"  English: {EN_SRT.name} ({EN_SRT.stat().st_size / 1024:.1f} KB)")
        print(f"  Dual:    {DUAL_SRT.name} ({DUAL_SRT.stat().st_size / 1024:.1f} KB)")
        print("=" * 60 + "\n")
        return
    print("=" * 60)
    print("STEP 1: Downloading & Synchronizing Subtitles (-9 hours offset)...")
    print("=" * 60)
    raw_prefix = DOWNLOADS_DIR / "raw_subs"
    
    cmd = [
        YT_DLP,
        "--js-runtimes", "node",
        "--skip-download",
        "--write-subs",
        "--sub-langs", "zh-Hans,en",
        "--sub-format", "srt",
        "-o", f"{raw_prefix}.%(ext)s",
        VIDEO_URL
    ]
    if COOKIES_FILE.exists():
        cmd.extend(["--cookies", str(COOKIES_FILE)])
        
    subprocess.run(cmd, check=True)
    
    raw_zh = DOWNLOADS_DIR / "raw_subs.zh-Hans.srt"
    raw_en = DOWNLOADS_DIR / "raw_subs.en.srt"
    
    if not raw_zh.exists():
        # Fallback to any zh
        candidates = list(DOWNLOADS_DIR.glob("raw_subs.zh*.srt"))
        if candidates:
            raw_zh = candidates[0]
            
    zh_entries = parse_srt_file(raw_zh) if raw_zh.exists() else []
    en_entries = parse_srt_file(raw_en) if raw_en.exists() else []
    
    print(f"Original Chinese entries: {len(zh_entries)}")
    print(f"Original English entries: {len(en_entries)}")
    
    fixed_zh = shift_and_filter_subtitles(zh_entries, START_SECONDS)
    fixed_en = shift_and_filter_subtitles(en_entries, START_SECONDS)
    
    write_srt(fixed_zh, ZH_SRT)
    if fixed_en:
        write_srt(fixed_en, EN_SRT)
        write_dual_srt(fixed_zh, fixed_en, DUAL_SRT)
        
    # Clean up raw subs
    for p in DOWNLOADS_DIR.glob("raw_subs.*"):
        try: p.unlink()
        except: pass
    print("  Subtitles successfully synchronized starting from 00:00:00!\n")

def step2_download_video():
    print("=" * 60)
    print("STEP 2: Downloading High-Quality Video (09:00:00 to Finish)...")
    print("        Using AV1 1080p + AAC (Optimal Quality & Compression)")
    print("=" * 60)
    
    part_file = Path(str(OUTPUT_MP4) + ".part")
    if part_file.exists():
        try:
            part_file.unlink()
            print(f"Removed previous partial file: {part_file.name}")
        except Exception as e:
            print(f"Warning removing part file: {e}")

    # AV1 1080p (399) + AAC (140)
    # If 399 is not available, fallback to 1080p vp9 (248) or best 1080p
    cmd = [
        YT_DLP,
        "--js-runtimes", "node",
        "-f", "399+140/248+140/bestvideo[height<=1080]+bestaudio/best",
        "--download-sections", "*09:00:00-inf",
        "--retries", "10",
        "--fragment-retries", "10",
        "--downloader-args", "ffmpeg_i:-reconnect 1 -reconnect_at_eof 1 -reconnect_streamed 1 -reconnect_delay_max 5",
        "--merge-output-format", "mp4",
        "-o", str(OUTPUT_MP4),
        VIDEO_URL
    ]
    if COOKIES_FILE.exists():
        cmd.extend(["--cookies", str(COOKIES_FILE)])
        
    print(f"Executing: {' '.join(cmd)}")
    t0 = time.time()
    subprocess.run(cmd, check=True)
    size_mb = OUTPUT_MP4.stat().st_size / (1024 * 1024)
    print(f"\nDownload finished in {time.time()-t0:.1f}s. Size: {size_mb:.2f} MB ({size_mb/1024:.2f} GB)")

def step3_mux_container():
    if not OUTPUT_MP4.exists() or not ZH_SRT.exists():
        return
    print("\n" + "=" * 60)
    print("STEP 3: Muxing MKV with Soft Subtitles embedded (Zero re-encoding)...")
    print("=" * 60)
    cmd = [
        "ffmpeg", "-y",
        "-i", str(OUTPUT_MP4),
        "-i", str(ZH_SRT)
    ]
    extra_maps = ["-map", "0:v", "-map", "0:a", "-map", "1:s"]
    sub_titles = ["-metadata:s:s:0", "title=Chinese (Simplified)", "-metadata:s:s:0", "language=chi"]
    
    sub_count = 1
    if EN_SRT.exists():
        cmd.extend(["-i", str(EN_SRT)])
        extra_maps.extend(["-map", f"{sub_count+1}:s"])
        sub_titles.extend([f"-metadata:s:s:{sub_count}", "title=English", f"-metadata:s:s:{sub_count}", "language=eng"])
        sub_count += 1
        
    if DUAL_SRT.exists():
        cmd.extend(["-i", str(DUAL_SRT)])
        extra_maps.extend(["-map", f"{sub_count+1}:s"])
        sub_titles.extend([f"-metadata:s:s:{sub_count}", "title=Bilingual (ZH + EN)", f"-metadata:s:s:{sub_count}", "language=mul"])
        sub_count += 1
        
    cmd.extend(extra_maps)
    cmd.extend(["-c:v", "copy", "-c:a", "copy", "-c:s", "srt"])
    cmd.extend(sub_titles)
    cmd.append(str(OUTPUT_MKV))
    
    t0 = time.time()
    subprocess.run(cmd, check=True)
    mkv_mb = OUTPUT_MKV.stat().st_size / (1024 * 1024)
    print(f"Muxing completed in {time.time()-t0:.1f}s. MKV Size: {mkv_mb:.2f} MB ({mkv_mb/1024:.2f} GB)")

def main():
    step1_fetch_and_fix_subtitles()
    step2_download_video()
    step3_mux_container()
    print("\n" + "=" * 60)
    print("ALL DONE SUCCESSFULLY!")
    print(f"  MP4 Video: {OUTPUT_MP4}")
    print(f"  Chinese Subtitles: {ZH_SRT}")
    if EN_SRT.exists():
        print(f"  English Subtitles: {EN_SRT}")
    if DUAL_SRT.exists():
        print(f"  Dual Bilingual Subtitles: {DUAL_SRT}")
    if OUTPUT_MKV.exists():
        print(f"  MKV with embedded soft subtitles: {OUTPUT_MKV}")
    print("=" * 60)

if __name__ == "__main__":
    main()
