"""Cut the sprite sheet into individual transparent PNGs and compute collision outlines.

Usage: python3 tools/cut_sprites.py <sheet.png>
Outputs assets/sprites/*.png and assets/sprites/outlines.json (pixel-space outlines).
"""
import json, sys
import numpy as np
from PIL import Image
from scipy import ndimage

SRC = sys.argv[1]
OUT = 'assets/sprites'
PAD = 4
# name, approx center of the part on the sheet, flip horizontally?
PARTS = [
    ('truck', (380, 190), True),      # cream truck: flipped so it faces right
    ('magnet_truck', (1150, 180), True),  # oncoming truck: flipped so it faces left
    ('fridge', (804, 547), False),
    ('wheel', (188, 576), False),
    ('sofa', (1244, 584), False),
    ('box', (517, 580), False),
    ('cat', (1338, 854), False),
    ('tire', (195, 880), False),
    ('plank', (757, 890), False),
]

im = np.array(Image.open(SRC).convert('RGBA'))
alpha = im[:, :, 3]
mask = ndimage.binary_closing(alpha > 40, iterations=2)
lab, n = ndimage.label(mask)
meta = {}
for name, (cx, cy), flip in PARTS:
    # pick the largest component near the hint point
    sl = lab[cy - 40:cy + 40, cx - 40:cx + 40]
    ids, counts = np.unique(sl[sl > 0], return_counts=True)
    cid = ids[np.argmax(counts)]
    comp = lab == cid
    ys, xs = np.nonzero(comp)
    y0, y1, x0, x1 = ys.min() - PAD, ys.max() + PAD + 1, xs.min() - PAD, xs.max() + PAD + 1
    keep = ndimage.binary_dilation(comp, iterations=3)[y0:y1, x0:x1]
    crop = im[y0:y1, x0:x1].copy()
    crop[~keep] = 0
    # drop faint matte noise
    crop[crop[:, :, 3] < 12] = 0
    if flip:
        crop = crop[:, ::-1]
    Image.fromarray(crop).save(f'{OUT}/{name}.png', optimize=True)
    meta[name] = {'w': int(crop.shape[1]), 'h': int(crop.shape[0])}
    print(name, crop.shape[1], crop.shape[0])

json.dump(meta, open(f'{OUT}/sizes.json', 'w'), indent=1)
