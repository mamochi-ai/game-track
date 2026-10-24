"""Render a scene dump from tools/sim.js to PNG (debug aid). python3 tools/snap.py in.json out.png"""
import json, math, sys
from PIL import Image, ImageDraw
d = json.load(open(sys.argv[1]))
PPM = int(sys.argv[3]) if len(sys.argv) > 3 else 90
W, H = 900, 640
img = Image.new('RGBA', (W, H), (200, 220, 235, 255))
cx = d['cx']; base_y = 40 - d.get('gy', 0) * PPM
def sc(x, y):
    return (W/2 + (x-cx)*PPM, H - base_y - y*PPM)
dr = ImageDraw.Draw(img)
gy = sc(0, 0)[1]
dr.rectangle((0, gy, W, H), fill=(90, 90, 95, 255))
cache = {}
for it in d['items']:
    s = cache.get(it['sprite']) or Image.open(f"assets/sprites/{it['sprite']}.png")
    cache[it['sprite']] = s
    im = s.resize((max(1, int(it['w']*PPM)), max(1, int(it['h']*PPM))), Image.LANCZOS)
    im = im.rotate(math.degrees(it['a']), expand=True, resample=Image.BICUBIC)
    x, y = sc(it['x'], it['y'])
    img.alpha_composite(im, (int(x - im.width/2), int(y - im.height/2)))
for b in d['belts']:
    dr.line([sc(b[0], b[1]), sc(b[2], b[3])], fill=(230, 80, 20, 255), width=4)
for poly in d.get('polys', []):
    dr.polygon([sc(x, y) for x, y in poly], outline=(255, 0, 255, 255))
img.save(sys.argv[2])
