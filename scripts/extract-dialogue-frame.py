#!/usr/bin/env python3
"""Extract a dialogue-box-shaped region from the reference screenshot.

This is intentionally conservative: it detects strong rectangular borders,
crops to the best candidate, and makes pixels outside that candidate
transparent. The source artwork inside the detected frame is not regenerated
or stylistically altered.
"""
from pathlib import Path
import sys
import cv2
import numpy as np
from PIL import Image


def order_points(points):
    pts = np.asarray(points, dtype=np.float32)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    return np.array([
        pts[np.argmin(s)],
        pts[np.argmin(d)],
        pts[np.argmax(s)],
        pts[np.argmax(d)],
    ], dtype=np.float32)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: extract-dialogue-frame.py INPUT.jpg OUTPUT.png")

    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    image = cv2.imread(str(src), cv2.IMREAD_COLOR)
    if image is None:
        raise SystemExit(f"cannot read input: {src}")

    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    image_area = float(w * h)
    candidates = []

    for contour in contours:
        area = cv2.contourArea(contour)
        if area < image_area * 0.05 or area > image_area * 0.98:
            continue
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        x, y, cw, ch = cv2.boundingRect(approx)
        if cw < w * 0.35 or ch < h * 0.08:
            continue
        aspect = cw / max(ch, 1)
        # Dialogue boxes are normally substantially wider than tall.
        if aspect < 1.5:
            continue
        rectangularity = area / float(cw * ch)
        if rectangularity < 0.55:
            continue
        # Prefer large, wide, lower-half candidates.
        center_y = y + ch / 2
        lower_bonus = 1.0 + max(0.0, (center_y / h - 0.45))
        score = area * rectangularity * lower_bonus
        candidates.append((score, approx.reshape(4, 2), (x, y, cw, ch)))

    if candidates:
        _, quad, bbox = max(candidates, key=lambda item: item[0])
        quad = order_points(quad)
        x, y, cw, ch = bbox
    else:
        # Fallback: preserve the lower portion rather than inventing a frame.
        x, y, cw, ch = 0, int(h * 0.55), w, int(h * 0.45)
        quad = np.array([[x, y], [x + cw - 1, y], [x + cw - 1, y + ch - 1], [x, y + ch - 1]], dtype=np.float32)

    pad = max(2, int(min(w, h) * 0.01))
    x0 = max(0, x - pad)
    y0 = max(0, y - pad)
    x1 = min(w, x + cw + pad)
    y1 = min(h, y + ch + pad)

    crop = image[y0:y1, x0:x1]
    local_quad = quad - np.array([x0, y0], dtype=np.float32)
    mask = np.zeros(crop.shape[:2], dtype=np.uint8)
    cv2.fillConvexPoly(mask, np.round(local_quad).astype(np.int32), 255)

    # Slight feathering avoids a harsh one-pixel cut at the frame edge.
    mask = cv2.GaussianBlur(mask, (3, 3), 0)
    rgba = cv2.cvtColor(crop, cv2.COLOR_BGR2RGBA)
    rgba[:, :, 3] = mask

    dst.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba).save(dst, format="PNG", optimize=True)
    print(f"input={src} size={w}x{h}")
    print(f"output={dst} size={rgba.shape[1]}x{rgba.shape[0]}")
    print(f"candidate_count={len(candidates)} bbox={x},{y},{cw},{ch}")


if __name__ == "__main__":
    main()
