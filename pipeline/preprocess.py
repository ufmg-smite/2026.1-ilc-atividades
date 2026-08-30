"""Make a phone photo of a notebook legible to a small vision model.

The scans in dados/exports/dcc638-atividade3_export are the hard case: some are upside down,
most are low-contrast, several have the facing page bleeding through. Cheap
classical steps fix most of that and cost nothing at inference time.

Order matters: flatten the lighting first (so contrast stretching doesn't
amplify a shadow), then deskew on clean ink, then stretch, then downscale to
the model's input budget.
"""
from PIL import Image, ImageFilter, ImageOps
import numpy as np

MAX_DIM = 1600          # vision models see no more detail above this, and RAM is tight
DESKEW_RANGE = 5.0      # degrees; phone photos are rarely worse than this
DESKEW_STEP = 0.5


def flatten_lighting(img, radius=45):
    """Divide out the slow background gradient: kills shelf shadows and most
    of the bleed-through from the previous page, keeps the ink."""
    bg = img.filter(ImageFilter.GaussianBlur(radius))
    a = np.asarray(img, dtype=np.float32)
    b = np.asarray(bg, dtype=np.float32)
    out = np.clip(a / np.maximum(b, 1.0) * 255.0, 0, 255)
    return Image.fromarray(out.astype(np.uint8))


def _row_variance(arr):
    """Text lines make horizontal ink bands; the true angle maximises the
    variance of the row-sum profile."""
    return float(np.var(arr.sum(axis=1)))


def find_skew(img):
    small = img.copy()
    small.thumbnail((800, 800))
    ink = 255 - np.asarray(small, dtype=np.float32)
    ink[ink < 40] = 0                      # ignore paper texture
    base = Image.fromarray(ink.astype(np.uint8))
    best, best_angle = -1.0, 0.0
    a = -DESKEW_RANGE
    while a <= DESKEW_RANGE + 1e-9:
        rot = base.rotate(a, resample=Image.BILINEAR, fillcolor=0)
        v = _row_variance(np.asarray(rot, dtype=np.float32))
        if v > best:
            best, best_angle = v, a
        a += DESKEW_STEP
    return best_angle


def prepare(src_path, dst_path, rotate=0):
    """Full pass. `rotate` is an extra clockwise rotation in degrees, used on
    the second attempt when the model reports the page was upside down."""
    img = Image.open(src_path)
    img = ImageOps.exif_transpose(img)
    img = img.convert("L")
    if rotate:
        img = img.rotate(-rotate, expand=True, fillcolor=255)

    img = flatten_lighting(img)
    angle = find_skew(img)
    if abs(angle) >= DESKEW_STEP:
        img = img.rotate(angle, resample=Image.BICUBIC, expand=True, fillcolor=255)

    img = ImageOps.autocontrast(img, cutoff=(1, 12))
    if max(img.size) > MAX_DIM:
        img.thumbnail((MAX_DIM, MAX_DIM), Image.LANCZOS)
    # WebP keeps a 1600px grayscale page around 60 KB — a full class of scans
    # then fits comfortably inside the Supabase free tier.
    if str(dst_path).lower().endswith(".webp"):
        img.save(dst_path, "WEBP", quality=82, method=4)
    else:
        img.save(dst_path, optimize=True)
    return {"skew": round(angle, 2), "size": img.size, "rotate": rotate}
