import subprocess
import json

cmd = ['yt-dlp', '--cookies', 'bilibili_cookies.txt', '-J', 'https://www.bilibili.com/video/BV1QCak6RELJ?p=1']
res = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8')
data = json.loads(res.stdout)
chapters = data.get('chapters') or []
print(f"Total chapters: {len(chapters)}")
for ch in chapters:
    start = ch.get('start_time')
    end = ch.get('end_time')
    title = ch.get('title')
    print(f"  {title}: {int(start//3600)}:{int((start%3600)//60):02d}:{int(start%60):02d} -> {int(end//3600)}:{int((end%3600)//60):02d}:{int(end%60):02d}")
