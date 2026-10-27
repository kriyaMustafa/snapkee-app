import os
import sys
import time
import json
import base64
import hashlib
import subprocess
import urllib.request
import urllib.parse
from pathlib import Path

# Setup paths
BASE_DIR = Path(__file__).parent.resolve()
DOWNLOADS_DIR = BASE_DIR / "Downloads"
DOWNLOADS_DIR.mkdir(exist_ok=True)

COOKIES_FILE = BASE_DIR / "combined_cookies.txt"
RAW_COOKIES_FILE = BASE_DIR / "www.bilibili.com_cookies.txt"

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
VIDEO_URL = "https://www.bilibili.com/video/BV1QCak6RELJ?p=1"
OUTPUT_BASENAME = "Cangsheng_Wei_Ju_Wo_Ni_Jianghu_06h27m_to_end"
OUTPUT_MP4 = DOWNLOADS_DIR / f"{OUTPUT_BASENAME}.mp4"
AUDIO_WAV = DOWNLOADS_DIR / f"{OUTPUT_BASENAME}_audio.wav"

ZH_SRT = DOWNLOADS_DIR / f"{OUTPUT_BASENAME}.zh.srt"
EN_SRT = DOWNLOADS_DIR / f"{OUTPUT_BASENAME}.en.srt"
DUAL_SRT = DOWNLOADS_DIR / f"{OUTPUT_BASENAME}.dual.srt"
OUTPUT_MKV = DOWNLOADS_DIR / f"{OUTPUT_BASENAME}_with_subtitles.mkv"

# Setup CUDA DLL directory for faster-whisper
CUBLAS_DIR = r"C:\Users\3SAJ\AppData\Roaming\Python\Python314\site-packages\nvidia\cublas\bin"
CUDNN_DIR = r"C:\Users\3SAJ\AppData\Roaming\Python\Python314\site-packages\nvidia\cudnn\bin"
if os.path.exists(CUBLAS_DIR):
    os.add_dll_directory(CUBLAS_DIR)
if os.path.exists(CUDNN_DIR):
    os.add_dll_directory(CUDNN_DIR)
os.environ["PATH"] = f"{CUBLAS_DIR};{CUDNN_DIR};" + os.environ.get("PATH", "")

def get_duration(filepath):
    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(filepath)
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return float(res.stdout.strip())
    except Exception:
        return 0.0

def solve_pow():
    print("[1/5] Checking and refreshing Bilibili security token...")
    req = urllib.request.Request(VIDEO_URL, headers={"User-Agent": UA})
    sec_token = None
    try:
        urllib.request.urlopen(req)
        print("Direct access succeeded without PoW challenge.")
        return
    except urllib.error.HTTPError as e:
        for k, v in e.headers.items():
            if k.lower() == "set-cookie" and "X-BILI-SEC-TOKEN" in v:
                sec_token = v.split(";")[0].split("=", 1)[1]
                break

    if not sec_token:
        print("No sec_token found in response headers.")
        return

    jwt_token = sec_token.split(",")[1]
    payload_b64 = jwt_token.split(".")[1]
    payload_b64 += "=" * ((4 - len(payload_b64) % 4) % 4)
    payload = json.loads(base64.urlsafe_b64decode(payload_b64))

    q = payload["q"]
    r = payload["r"]

    print(f"Solving PoW challenge (q={q[:10]}...)...")
    found = None
    for i in range(5000000):
        h = hashlib.sha256((q + str(i)).encode("utf-8")).hexdigest()
        if h == r:
            found = i
            break

    if found is None:
        raise RuntimeError("PoW solution not found!")

    post_data = urllib.parse.urlencode({"token": jwt_token, "result": found}).encode()
    check_req = urllib.request.Request(
        "https://security.bilibili.com/th/captcha/cc/check",
        data=post_data,
        headers={
            "User-Agent": UA,
            "Referer": VIDEO_URL,
            "Origin": "https://www.bilibili.com",
            "Content-Type": "application/x-www-form-urlencoded"
        }
    )
    with urllib.request.urlopen(check_req) as resp:
        res = json.loads(resp.read().decode())
        validated_token = res["message"]
        print("PoW solved successfully!")

    orig_content = RAW_COOKIES_FILE.read_text(encoding="utf-8") if RAW_COOKIES_FILE.exists() else "# Netscape\n"
    exp = int(time.time()) + 86400
    sec_line = f".bilibili.com\tTRUE\t/\tFALSE\t{exp}\tX-BILI-SEC-TOKEN\t{validated_token}\n"
    COOKIES_FILE.write_text(orig_content.strip() + "\n" + sec_line, encoding="utf-8")
    print(f"Saved cookies to {COOKIES_FILE}")

def download_video():
    print(f"[2/5] Downloading video clip from 06:27:00 to end into {OUTPUT_MP4}...")
    if OUTPUT_MP4.exists():
        dur = get_duration(OUTPUT_MP4)
        print(f"Existing file duration: {dur:.1f}s ({dur/3600:.2f}h)")
        if dur >= 7200:
            print("Existing file is complete (>= 7200s), skipping download.")
            return
        else:
            print("Existing file was incomplete, re-downloading with robust reconnect...")
            OUTPUT_MP4.unlink(missing_ok=True)

    cmd = [
        "yt-dlp",
        "--cookies", str(COOKIES_FILE),
        "--user-agent", UA,
        "-f", "100024+30280",
        "--download-sections", "*06:27:00-inf",
        "--downloader-args", "ffmpeg_i:-reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 10",
        "--downloader-args", "ffmpeg:-c copy",
        VIDEO_URL,
        "-o", str(OUTPUT_MP4)
    ]
    t0 = time.time()
    subprocess.run(cmd, check=True)
    dur = get_duration(OUTPUT_MP4)
    print(f"Download finished in {time.time()-t0:.1f}s. File duration: {dur:.1f}s ({dur/60:.1f}m). Size: {OUTPUT_MP4.stat().st_size / 1024 / 1024:.2f} MB")

def extract_audio():
    print(f"[3/5] Extracting audio for Whisper to {AUDIO_WAV}...")
    if AUDIO_WAV.exists():
        wav_dur = get_duration(AUDIO_WAV)
        mp4_dur = get_duration(OUTPUT_MP4)
        if abs(wav_dur - mp4_dur) < 2.0 and wav_dur > 7000:
            print(f"Audio file already complete ({wav_dur:.1f}s), skipping extraction.")
            return
        else:
            AUDIO_WAV.unlink(missing_ok=True)

    cmd = [
        "ffmpeg", "-y",
        "-i", str(OUTPUT_MP4),
        "-vn",
        "-ar", "16000",
        "-ac", "1",
        "-c:a", "pcm_s16le",
        str(AUDIO_WAV)
    ]
    t0 = time.time()
    subprocess.run(cmd, check=True)
    print(f"Audio extracted in {time.time()-t0:.1f}s. Size: {AUDIO_WAV.stat().st_size / 1024 / 1024:.2f} MB")

def format_timestamp(seconds: float) -> str:
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis >= 1000:
        seconds += 1
        millis = 0
    secs = int(seconds)
    hours = secs // 3600
    minutes = (secs % 3600) // 60
    s = secs % 60
    return f"{hours:02d}:{minutes:02d}:{s:02d},{millis:03d}"

def write_srt(segments, filepath):
    with open(filepath, "w", encoding="utf-8") as f:
        for idx, seg in enumerate(segments, 1):
            start = format_timestamp(seg["start"])
            end = format_timestamp(seg["end"])
            text = seg["text"].strip()
            f.write(f"{idx}\n{start} --> {end}\n{text}\n\n")

def write_dual_srt(zh_segs, en_segs, filepath):
    merged = []
    for zh in zh_segs:
        mid = (zh["start"] + zh["end"]) / 2
        matching_en = [e["text"].strip() for e in en_segs if e["start"] <= mid <= e["end"]]
        en_txt = " ".join(matching_en) if matching_en else ""
        merged.append({"start": zh["start"], "end": zh["end"], "zh": zh["text"].strip(), "en": en_txt})
    with open(filepath, "w", encoding="utf-8") as f:
        for idx, item in enumerate(merged, 1):
            start = format_timestamp(item["start"])
            end = format_timestamp(item["end"])
            f.write(f"{idx}\n{start} --> {end}\n{item['zh']}\n{item['en']}\n\n")

def generate_subtitles():
    print("[4/5] Transcribing and translating subtitles using faster-whisper on GPU...")
    from faster_whisper import WhisperModel

    device = "cuda"
    compute_type = "float16"
    model_name = "base"
    print(f"Loading faster-whisper '{model_name}' on {device} ({compute_type})...")
    model = WhisperModel(model_name, device=device, compute_type=compute_type)

    # 1. Chinese transcription
    print("Transcribing Chinese audio...")
    t0 = time.time()
    zh_segments_raw, info = model.transcribe(str(AUDIO_WAV), language="zh", beam_size=5)
    zh_segs = []
    for s in zh_segments_raw:
        zh_segs.append({"start": s.start, "end": s.end, "text": s.text})
    print(f"Chinese transcription finished in {time.time()-t0:.1f}s ({len(zh_segs)} segments).")
    write_srt(zh_segs, ZH_SRT)
    print(f"Saved: {ZH_SRT}")

    # 2. English translation
    print("Translating audio to English...")
    t0 = time.time()
    en_segments_raw, _ = model.transcribe(str(AUDIO_WAV), task="translate", beam_size=5)
    en_segs = []
    for s in en_segments_raw:
        en_segs.append({"start": s.start, "end": s.end, "text": s.text})
    print(f"English translation finished in {time.time()-t0:.1f}s ({len(en_segs)} segments).")
    write_srt(en_segs, EN_SRT)
    print(f"Saved: {EN_SRT}")

    # 3. Dual SRT
    write_dual_srt(zh_segs, en_segs, DUAL_SRT)
    print(f"Saved: {DUAL_SRT}")

def mux_subtitles():
    print(f"[5/5] Creating MKV container with embedded soft subtitles at {OUTPUT_MKV}...")
    cmd = [
        "ffmpeg", "-y",
        "-i", str(OUTPUT_MP4),
        "-i", str(ZH_SRT),
        "-i", str(EN_SRT),
        "-i", str(DUAL_SRT),
        "-map", "0:v",
        "-map", "0:a",
        "-map", "1:s",
        "-map", "2:s",
        "-map", "3:s",
        "-c:v", "copy",
        "-c:a", "copy",
        "-c:s", "srt",
        "-metadata:s:s:0", "title=Chinese (Simplified)",
        "-metadata:s:s:0", "language=chi",
        "-metadata:s:s:1", "title=English",
        "-metadata:s:s:1", "language=eng",
        "-metadata:s:s:2", "title=Bilingual (ZH + EN)",
        "-metadata:s:s:2", "language=mul",
        str(OUTPUT_MKV)
    ]
    t0 = time.time()
    subprocess.run(cmd, check=True)
    print(f"Muxing completed in {time.time()-t0:.1f}s. Size: {OUTPUT_MKV.stat().st_size / 1024 / 1024:.2f} MB")

def main():
    solve_pow()
    download_video()
    extract_audio()
    generate_subtitles()
    mux_subtitles()
    print("\n================== ALL TASKS COMPLETED SUCCESSFULLY ==================")
    print(f"1. Video (MP4): {OUTPUT_MP4}")
    print(f"2. Subtitles (Chinese SRT): {ZH_SRT}")
    print(f"3. Subtitles (English SRT): {EN_SRT}")
    print(f"4. Subtitles (Dual ZH+EN SRT): {DUAL_SRT}")
    print(f"5. Video with Embedded Subtitles (MKV): {OUTPUT_MKV}")

if __name__ == "__main__":
    main()
