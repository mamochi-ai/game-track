"""Bundle the game into single-file HTML pages.

    python3 tools/build.py

dist/index.html     standalone page (everything inlined, sprites as WebP data URIs). Works from any
                    static host or opened directly as a file.
dist/artifact.html  same content as a page fragment for claude.ai Artifacts (the host adds the
                    document skeleton).
"""
import base64
import io
import json
import os
import re

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPRITES = ['truck', 'magnet_truck', 'wheel', 'tire', 'box', 'sofa', 'plank', 'fridge_body', 'fridge_door_top', 'fridge_door_bottom',
           'watermelon', 'sofa_cushion', 'cat_body', 'cat_arm', 'bowling', 'rubber_ball', 'shelf', 'robot', 'open_box', 'fragile_box',
           'lift_block', 'magnet_sign', 'worker_push', 'worker_press', 'worker_thumb', 'crane_body', 'crane_boom', 'crane_hook']
SCRIPTS = ['js/outlines.js', 'js/config.js', 'js/physics.js', 'js/layout.js', 'js/render.js', 'js/audio.js', 'js/main.js']
FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
         '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
         '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Dela+Gothic+One'
         '&family=Zen+Maru+Gothic:wght@500;700&display=swap">')


def read(path):
    with open(os.path.join(ROOT, path), encoding='utf-8') as f:
        return f.read()


def block(html, name):
    m = re.search(r'<!--BUILD:%s-->(.*?)<!--/BUILD:%s-->' % (name, name), html, re.S)
    return m.group(1).strip()


def inline_js(src):
    # keep "</script>" sequences inside code from closing the tag
    return '<script>\n' + src.replace('</script', '<\\/script') + '\n</script>'


def main():
    html = read('index.html')
    body = block(html, 'BODY')
    css = read('css/style.css')
    sprites = {}
    for n in SPRITES:
        # WebP keeps the alpha channel at about a sixth of the PNG size (Safari 14+)
        buf = io.BytesIO()
        Image.open(os.path.join(ROOT, 'assets/sprites/%s.png' % n)).save(buf, 'WEBP', quality=88, alpha_quality=95, method=6)
        sprites[n] = 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode()
    app_js = '\n'.join(inline_js(read(p)) for p in ['js/vendor/planck.min.js'] + SCRIPTS)
    sprite_js = inline_js('window.SPRITES = ' + json.dumps(sprites) + ';')

    os.makedirs(os.path.join(ROOT, 'dist'), exist_ok=True)

    standalone = (
        '<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">\n'
        '<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="mobile-web-app-capable" content="yes">\n'
        '<meta name="theme-color" content="#2b2a33">\n<title>一便でいけます。</title>\n'
        + FONTS + '\n<style>\n' + css + '\n</style>\n</head>\n<body>\n' + body + '\n'
        + sprite_js + '\n' + app_js + '\n</body>\n</html>\n')
    with open(os.path.join(ROOT, 'dist/index.html'), 'w', encoding='utf-8') as f:
        f.write(standalone)

    artifact = (
        '<title>一便でいけます。</title>\n' + FONTS + '\n<style>\n' + css + '\n</style>\n' + body + '\n'
        + sprite_js + '\n' + app_js + '\n')
    with open(os.path.join(ROOT, 'dist/artifact.html'), 'w', encoding='utf-8') as f:
        f.write(artifact)

    for n in ('index.html', 'artifact.html'):
        print('dist/%s  %.0f KB' % (n, os.path.getsize(os.path.join(ROOT, 'dist', n)) / 1024))


if __name__ == '__main__':
    main()
