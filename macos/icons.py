#!/usr/bin/env python3
"""Draw the extension's and the Windows app's icons from the Mac icon: its chain, cut out of a disc in its colours.

Run it after changing AppIcon.icon, and commit what it writes. It needs rsvg-convert (`brew install librsvg`)."""
import json
import pathlib
import re
import struct
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
ICON = ROOT / 'macos/AppIcon.icon'
EXTENSION = ROOT / 'extension'
WINDOWS = ROOT / 'windows/LinkReuse/LinkReuse.ico'


def art():
    """The chain is a hole in the disc, so a browser that draws toolbar icons in one colour still shows it."""
    chain = re.search(r' d="([^"]+)"', (ICON / 'Assets/chain.svg').read_text()).group(1)
    gradient = json.loads((ICON / 'icon.json').read_text())['fill']['linear-gradient']
    top, bottom = ('#' + ''.join(f'{round(float(part) * 255):02x}' for part in colour.split(':')[1].split(',')[:3])
                   for colour in gradient)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <linearGradient id="green" x2="0" y2="1">
    <stop stop-color="{top}"/>
    <stop offset="1" stop-color="{bottom}"/>
  </linearGradient>
  <mask id="chain">
    <rect width="1024" height="1024" fill="#fff"/>
    <path transform="translate(512 512) scale(1.2) translate(-512 -512)" d="{chain}"/>
  </mask>
  <circle cx="512" cy="512" r="496" fill="url(#green)" mask="url(#chain)"/>
</svg>'''


def png(size):
    drawn = subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size)], input=art().encode(),
                           stdout=subprocess.PIPE, check=True)
    return drawn.stdout


def main():
    icons = json.loads((EXTENSION / 'manifest.json').read_text())['icons']
    for size, path in icons.items(): (EXTENSION / path).write_bytes(png(size))
    # A Windows icon file: a directory of frames, then the frames themselves, each a PNG.
    frames = {size: png(size) for size in [16, 20, 24, 32, 40, 48, 64, 256]}
    directory, offset = b'', 6 + 16 * len(frames)
    for size, frame in frames.items():
        directory += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(frame), offset)
        offset += len(frame)
    WINDOWS.write_bytes(struct.pack('<HHH', 0, 1, len(frames)) + directory + b''.join(frames.values()))


if __name__ == '__main__': main()
