"""
Generates assets/topo-background.png -- a black background with topographic
contour lines in a red-to-gold gradient (ISU Cardinal #C8102E to Gold
#F1BE48), used as the site-wide backdrop (see style.css). The "terrain" is a
smooth height field built from a handful of random sine waves at different
frequencies/phases (a simple, dependency-free stand-in for Perlin noise),
then matplotlib's contour() draws real elevation-style contour lines over
it -- the same technique used for actual topographic maps.

Re-run to get a different pattern (change the RNG seed below).
"""

import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
from PIL import Image

ASSETS_DIR = os.path.dirname(os.path.abspath(__file__)) + "/assets"
OUTPUT_PNG = os.path.join(ASSETS_DIR, "_topo-background-tmp.png")
OUTPUT_JPG = os.path.join(ASSETS_DIR, "topo-background.jpg")
JPEG_QUALITY = 90

SEED = 7
SIZE = 500
NUM_WAVES = 5
LEVELS = 14
FIGSIZE = (19.2, 10.8)  # 16:9, scales cleanly to any wide viewport
DPI = 150
BG_COLOR = "#050505"


def build_height_field():
    rng = np.random.default_rng(SEED)
    x = np.linspace(0, 1, SIZE)
    y = np.linspace(0, 1, SIZE)
    xx, yy = np.meshgrid(x, y)

    z = np.zeros_like(xx)
    for _ in range(NUM_WAVES):
        # Low frequencies only -- fewer, bigger "hills" means fewer, more
        # widely-spaced contour rings instead of a dense tangle of small ones.
        fx = rng.uniform(0.6, 1.8)
        fy = rng.uniform(0.6, 1.8)
        phase = rng.uniform(0, 2 * np.pi)
        amp = rng.uniform(0.4, 1.0)
        z += amp * np.sin(2 * np.pi * fx * xx + phase) * np.cos(2 * np.pi * fy * yy + phase)

    z = (z - z.min()) / (z.max() - z.min())
    return xx, yy, z


def main():
    os.makedirs(ASSETS_DIR, exist_ok=True)
    xx, yy, z = build_height_field()

    # Muted, darker red-gold (not the vibrant full-saturation brand colors)
    # -- this is a background decoration, not a foreground UI element, so it
    # needs to stay subtle rather than compete with the page content.
    cmap = LinearSegmentedColormap.from_list("isu_cardinal_gold_muted", ["#6b1420", "#8a6a2e"])

    fig, ax = plt.subplots(figsize=FIGSIZE, dpi=DPI)
    fig.patch.set_facecolor(BG_COLOR)
    ax.set_facecolor(BG_COLOR)
    ax.contour(xx, yy, z, levels=np.linspace(0, 1, LEVELS), cmap=cmap, linewidths=0.9, alpha=0.55)
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    fig.savefig(OUTPUT_PNG, facecolor=BG_COLOR)
    plt.close(fig)

    # JPEG compresses this (thin lines over a mostly-flat background) at a
    # fraction of the PNG's size with no visible quality loss -- matters
    # since this loads on every page as the site-wide background.
    Image.open(OUTPUT_PNG).convert("RGB").save(OUTPUT_JPG, quality=JPEG_QUALITY, optimize=True)
    os.remove(OUTPUT_PNG)
    print(f"Wrote {OUTPUT_JPG} ({os.path.getsize(OUTPUT_JPG) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
