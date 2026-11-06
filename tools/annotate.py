"""Дорисовывает к рендеру диорамы заголовок, плашки щитов и подписи.
Запуск: python tools/annotate.py <имя>  →  renders/<имя>.png"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

NAME = sys.argv[1] if len(sys.argv) > 1 else "borovaya"
info = json.load(open(f"renders/{NAME}-labels.json", encoding="utf-8"))
img = Image.open(f"renders/{NAME}-raw.png").convert("RGBA")
W, H = img.size
ov = Image.new("RGBA", img.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)

def font(size, bold=False):
    for p in (["tools/fonts/GolosText-SemiBold.ttf"] if bold else ["tools/fonts/GolosText-Regular.ttf"]) + \
             ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if os.path.exists(p): return ImageFont.truetype(p, size)
    return ImageFont.load_default()
def hexa(h, a=255): h = h.lstrip("#"); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (a,)
INK, MUTED, BROWN = hexa("#1f2a2e"), hexa("#5b6a70"), hexa("#8a5a36")

def pill(x, y, text, sub=None, color=None, anchor_up=True):
    f1, f2 = font(22, True), font(17)
    w = max(d.textlength(text, font=f1), d.textlength(sub, font=f2) if sub else 0) + 28
    h = 38 + (22 if sub else 0)
    bx, by = x - w / 2, y - h - 26
    d.line([(x, y), (x, by + h)], fill=INK, width=2)
    d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=INK)
    d.rounded_rectangle([bx, by, bx + w, by + h], 10, fill=(255, 255, 255, 235), outline=hexa(color) if color else INK, width=3 if color else 1)
    d.text((bx + 14, by + 8), text, font=f1, fill=INK)
    if sub: d.text((bx + 14, by + 36), sub, font=f2, fill=MUTED)

for L in info["labels"]:
    x, y = L["px"]
    if not (40 < x < W - 40 and 120 < y < H - 20): continue
    if L["kind"] == "shield": pill(*(L.get("px_top") or L["px"]), L["text"], L["sub"], L["color"])
    elif L["kind"] == "station": pill(x, y, L["text"], "вестибюль")
    elif L["kind"] == "hall": pill(x, y, "Станция " + L["text"], "глубина ≈ " + L["sub"].lstrip("−"))
    elif L["kind"] == "shaft": pill(x, y, L["text"])

# заголовок
line = info["line"].split(",")[0].replace(" (коричневая)", "").upper()
d.text((48, 40), line + " · 2-Й УЧАСТОК", font=font(20, True), fill=BROWN)
st = next((L["text"] for L in info["labels"] if L["kind"] == "hall"), "")
d.text((48, 70), ("Станция " + st) if st else "Проходка", font=font(46, True), fill=INK)
y = 132
for s in info["shields"]:
    u = " м" if s["unit"] == "m" else " колец"
    r = s["ring"]; nxt = next((x for x in s["stations"] if x[1] > r), None)
    inside = next((x for x in s["stations"] if x[1] <= r <= x[2]), None)
    tail = ("проходит «%s»" % inside[0]) if inside else ("до «%s» %s%s" % (nxt[0], f"{round(nxt[1] - r):,}".replace(",", " "), u) if nxt else "проходка завершена")
    d.ellipse([50, y + 7, 64, y + 21], fill=hexa(s["color"]))
    d.text((74, y), "«%s»: %s%s, %s" % (s["name"], f"{round(r):,}".replace(",", " "), u, tail), font=font(21), fill=INK)
    y += 32
d.text((W - 48, H - 30), "t.me/podzemnik_spb · дома и улицы © OpenStreetMap · глубина и тоннели утрированы в 1,5 раза · на " +
       ".".join(reversed(info["updated"].split("-"))), font=font(15), fill=MUTED, anchor="rs")
Image.alpha_composite(img, ov).convert("RGB").save(f"renders/{NAME}.png", optimize=True)
print("saved", f"renders/{NAME}.png")
