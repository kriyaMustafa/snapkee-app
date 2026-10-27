import subprocess
import json

cmd = ['yt-dlp', '--cookies', 'bilibili_cookies.txt', '-J', 'https://www.bilibili.com/video/BV1QCak6RELJ/']
res = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
data = json.loads(res.stdout)
print('Playlist title:', data.get('title'))
entries = data.get('entries', [])
print(f'Total parts: {len(entries)}')
for idx, entry in enumerate(entries):
    dur = int(entry.get('duration') or 0)
    h = dur // 3600
    m = (dur % 3600) // 60
    s = dur % 60
    print(f"Part {idx+1}: {entry.get('title')} | Duration: {dur}s ({h}h{m:02d}m{s:02d}s)")
    print(f"  ID: {entry.get('id')}")
    print(f"  Subtitles: {list(entry.get('subtitles', {}).keys())}")
    print(f"  Automatic captions: {list(entry.get('automatic_captions', {}).keys())}")
