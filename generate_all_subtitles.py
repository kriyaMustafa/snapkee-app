import os
import sys
import time
from pathlib import Path
import subprocess

BASE_DIR = Path(__file__).parent.resolve()
DOWNLOADS_DIR = BASE_DIR / "Downloads"

OUTPUT_BASENAME = "Cangsheng_Wei_Ju_Wo_Ni_Jianghu_06h27m_to_end"
OUTPUT_MP4 = DOWNLOADS_DIR / f"{OUTPUT_BASENAME}.mp4"
AUDIO_WAV = DOWNLOADS_DIR / f"{OUTPUT_BASENAME}_audio.wav"

ZH_SRT = DOWNLOADS_DIR / f"{OUTPUT_BASENAME}.zh.srt"
EN_SRT = DOWNLOADS_DIR / f"{OUTPUT_BASENAME}.en.srt"
DUAL_SRT = DOWNLOADS_DIR / f"{OUTPUT_BASENAME}.dual.srt"
OUTPUT_MKV = DOWNLOADS_DIR / f"{OUTPUT_BASENAME}_with_subtitles.mkv"

# Setup CUDA DLL directory
CUBLAS_DIR = r"C:\Users\3SAJ\AppData\Roaming\Python\Python314\site-packages\nvidia\cublas\bin"
CUDNN_DIR = r"C:\Users\3SAJ\AppData\Roaming\Python\Python314\site-packages\nvidia\cudnn\bin"
if os.path.exists(CUBLAS_DIR):
    os.add_dll_directory(CUBLAS_DIR)
if os.path.exists(CUDNN_DIR):
    os.add_dll_directory(CUDNN_DIR)
os.environ["PATH"] = f"{CUBLAS_DIR};{CUDNN_DIR};" + os.environ.get("PATH", "")

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

def main():
    from faster_whisper import WhisperModel

    print(f"Loading Whisper model on GPU...")
    model = WhisperModel("base", device="cuda", compute_type="float16")

    # Step 1: Chinese transcription
    print("Transcribing Chinese subtitles for the full 2 hours...")
    t0 = time.time()
    zh_segments_raw, info = model.transcribe(str(AUDIO_WAV), language="zh", beam_size=5)
    zh_segs = []
    for s in zh_segments_raw:
        zh_segs.append({"start": s.start, "end": s.end, "text": s.text})
        if len(zh_segs) % 200 == 0:
            print(f"  Transcribed {len(zh_segs)} Chinese segments ({s.end/60:.1f} min elapsed)...")
    print(f"Chinese transcription completed in {time.time()-t0:.1f}s ({len(zh_segs)} segments total).")
    write_srt(zh_segs, ZH_SRT)
    print(f"Saved: {ZH_SRT}")

    # Step 2: English translation
    print("Translating to English subtitles for the full 2 hours...")
    t0 = time.time()
    en_segments_raw, _ = model.transcribe(str(AUDIO_WAV), task="translate", beam_size=5)
    en_segs = []
    for s in en_segments_raw:
        en_segs.append({"start": s.start, "end": s.end, "text": s.text})
        if len(en_segs) % 200 == 0:
            print(f"  Translated {len(en_segs)} English segments ({s.end/60:.1f} min elapsed)...")
    print(f"English translation completed in {time.time()-t0:.1f}s ({len(en_segs)} segments total).")
    write_srt(en_segs, EN_SRT)
    print(f"Saved: {EN_SRT}")

    # Step 3: Dual subtitles
    print("Creating bilingual (ZH + EN) dual subtitles...")
    write_dual_srt(zh_segs, en_segs, DUAL_SRT)
    print(f"Saved: {DUAL_SRT}")

    # Step 4: Muxing into MKV
    print(f"Muxing subtitles into MKV container...")
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

    print("\n================== PIPELINE COMPLETE ==================")
    print(f"MP4 Video: {OUTPUT_MP4}")
    print(f"Chinese SRT: {ZH_SRT}")
    print(f"English SRT: {EN_SRT}")
    print(f"Bilingual Dual SRT: {DUAL_SRT}")
    print(f"MKV Video with Soft Subtitles: {OUTPUT_MKV}")

if __name__ == "__main__":
    main()
