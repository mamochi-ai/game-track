"""Cut the sprite sheets into individual transparent PNGs.

Usage: python3 tools/cut_sprites.py
Reads assets/source/sheet*.png and writes assets/sprites/*.png.
"""
import json
import numpy as np
from PIL import Image
from scipy import ndimage

OUT = 'assets/sprites'
PAD = 4
# sheet -> [(name, point inside the part, flip horizontally?)]
SHEETS = {
    'assets/source/sheet.png': [
        ('truck', (380, 190), True),          # cream truck: flipped so it faces right
        ('magnet_truck', (1150, 180), True),  # oncoming truck: flipped so it faces left
        ('fridge', (804, 547), False),
        ('wheel', (188, 576), False),
        ('sofa', (1244, 584), False),
        ('box', (517, 580), False),
        ('cat', (1338, 854), False),
        ('tire', (195, 880), False),
        ('plank', (757, 890), False),
    ],
    'assets/source/sheet2.png': [
        ('worker_push', (256, 210), False),
        ('worker_press', (767, 215), False),
        ('worker_thumb', (1244, 211), False),
        ('crane_body', (308, 549), False),
        ('crane_boom', (960, 531), False),
        ('crane_hook', (1432, 553), False),
        ('fragile_box', (218, 845), False),
        ('shed', (659, 838), False),
        ('magnet_sign', (1008, 760), False),
        ('lift_block', (1309, 900), False),
    ],
    'assets/source/sheet3.png': [
        ('fridge_body', (458, 213), False),
        ('fridge_door_top', (755, 100), False),
        ('fridge_door_bottom', (758, 299), False),
        ('watermelon', (1075, 258), False),
        ('sofa_cushion', (858, 612), False),
        ('cat_body', (1274, 574), False),
        ('cat_arm', (1464, 556), False),
        ('bowling', (156, 866), False),
        ('rubber_ball', (416, 865), False),
        ('shelf', (702, 855), False),
        ('robot', (1014, 922), False),
        ('open_box', (1329, 872), False),
    ],
}

meta = {}
for src, parts in SHEETS.items():
    im = np.array(Image.open(src).convert('RGBA'))
    mask = ndimage.binary_closing(im[:, :, 3] > 40, iterations=2)
    lab, _ = ndimage.label(mask)
    for name, (cx, cy), flip in parts:
        sl = lab[cy - 40:cy + 40, cx - 40:cx + 40]
        ids, counts = np.unique(sl[sl > 0], return_counts=True)
        comp = lab == ids[np.argmax(counts)]
        ys, xs = np.nonzero(comp)
        y0, y1, x0, x1 = ys.min() - PAD, ys.max() + PAD + 1, xs.min() - PAD, xs.max() + PAD + 1
        keep = ndimage.binary_dilation(comp, iterations=3)[y0:y1, x0:x1]
        crop = im[y0:y1, x0:x1].copy()
        crop[~keep] = 0
        crop[crop[:, :, 3] < 12] = 0  # drop faint matte noise
        if flip:
            crop = crop[:, ::-1]
        Image.fromarray(crop).save(f'{OUT}/{name}.png', optimize=True)
        meta[name] = {'w': int(crop.shape[1]), 'h': int(crop.shape[0]), 'sheet': src, 'x0': int(x0), 'y0': int(y0)}
        print(name, crop.shape[1], crop.shape[0])

json.dump(meta, open(f'{OUT}/sizes.json', 'w'), indent=1)
