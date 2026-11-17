"""Decode PNGs written by Squeeze with Pillow and compare against expected RGBA8 pixels.

Usage: python3 -I scripts/pillow_check.py DIR
DIR holds pairs NAME.png + NAME.rgba (raw 8-bit RGBA). Prints one line per mismatch and
exits 1 if any; exits 3 if Pillow is not installed.
"""

import os
import sys

try:
    from PIL import Image
except ImportError:
    print("SKIP: Pillow not installed")
    sys.exit(3)

d = sys.argv[1]
bad = 0
count = 0
for name in sorted(os.listdir(d)):
    if not name.endswith(".png"):
        continue
    base = name[:-4]
    with open(os.path.join(d, base + ".rgba"), "rb") as f:
        want = f.read()
    with Image.open(os.path.join(d, name)) as im:
        im.load()
        got = im.convert("RGBA").tobytes()
    count += 1
    if len(got) != len(want):
        print(f"{name}: size differs")
        bad += 1
        continue
    for i in range(0, len(want), 4):
        if want[i + 3] != got[i + 3] or (want[i + 3] != 0 and want[i : i + 3] != got[i : i + 3]):
            print(f"{name}: pixel {i // 4} differs: want {tuple(want[i:i+4])} got {tuple(got[i:i+4])}")
            bad += 1
            break
print(f"Pillow decoded {count} Squeeze PNGs, {bad} mismatches")
sys.exit(1 if bad else 0)
