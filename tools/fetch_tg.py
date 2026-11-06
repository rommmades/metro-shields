"""Скачивает публичную ленту канала t.me/podzemnik_spb (веб-версия t.me/s/...) целиком:
номер поста, дата, текст, ссылки на фото. Результат: data/tg/podzemnik.json"""
import html, json, os, re, sys, time, urllib.request

CH = sys.argv[1] if len(sys.argv) > 1 else "podzemnik_spb"
UA = {"User-Agent": "Mozilla/5.0 (metro-shields research)"}
posts, before, seen = {}, None, 0
for page in range(400):
    url = f"https://t.me/s/{CH}" + (f"?before={before}" if before else "")
    for a in range(4):
        try: t = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read().decode("utf-8"); break
        except Exception as ex: print("retry", url, ex); time.sleep(5 * (a + 1))
    else: break
    blocks = re.split(r'<div class="tgme_widget_message_wrap', t)[1:]
    ids = []
    for b in blocks:
        m = re.search(r'data-post="[^/]+/(\d+)"', b)
        if not m: continue
        pid = int(m.group(1)); ids.append(pid)
        d = re.search(r'<time datetime="([^"]+)"', b)
        tx = re.search(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', b, re.S)
        text = ""
        if tx:
            text = re.sub(r"<br\s*/?>", "\n", tx.group(1)); text = html.unescape(re.sub(r"<[^>]+>", "", text)).strip()
        photos = re.findall(r"background-image:url\('([^']+)'\)", b)
        links = [l for l in re.findall(r'href="(https?://[^"]+)"', b) if "t.me/" not in l]
        posts[pid] = {"id": pid, "date": d.group(1) if d else None, "text": text, "photos": [p for p in photos if "telesco" in p or "cdn" in p], "links": links}
    if not ids: break
    nb = min(ids)
    if before is not None and nb >= before: break
    before = nb; print("page", page, "before", before, "total", len(posts)); time.sleep(1.5)
    if nb <= 1: break
os.makedirs("data/tg", exist_ok=True)
json.dump(sorted(posts.values(), key=lambda p: p["id"]), open("data/tg/podzemnik.json", "w"), ensure_ascii=False, indent=0)
print("posts", len(posts))
