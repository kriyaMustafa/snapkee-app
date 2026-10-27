import urllib.request
import json

cookie = open("bilibili_cookies.txt").read().strip().split("\n")[-1].split("\t")[-1]
cid = "42376236405"
bvid = "BV1QCak6RELJ"

url = f"https://api.bilibili.com/x/player/v2?bvid={bvid}&cid={cid}"
req = urllib.request.Request(url, headers={
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Referer": f"https://www.bilibili.com/video/{bvid}/",
    "Cookie": f"X-BILI-SEC-TOKEN={cookie}"
})

try:
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
        print("Player v2 response code:", data.get("code"))
        subtitle_data = data.get("data", {}).get("subtitle", {})
        print("Subtitle data:", json.dumps(subtitle_data, indent=2, ensure_ascii=False))
except Exception as e:
    print("Error:", e)
