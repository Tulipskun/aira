"""Audit a character image folder against the framing standard.

Each image must show one character with the whole face inside the picture, the
face roughly in the middle, and the face taking a reasonable share of the frame.
The judgement comes from gemini-3.5-flash-lite, the same reader the image build
uses, so a set can be checked without regenerating it.

    python scripts/verify_images.py isla rem        # audit two folders
    python scripts/verify_images.py --all           # audit every folder

Exit status is 1 when any image fails, so a broken set cannot pass unnoticed.
"""
from __future__ import annotations

import asyncio
import json
import pathlib
import sys

from google.genai import types

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from aira import gemini  # noqa: E402  (reuses the configured API keys)

MODEL = "models/gemini-3.5-flash-lite"
IMAGES = pathlib.Path(__file__).resolve().parent.parent / "images"
EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
BATCH = 5
MIN_FACE_RATIO = 0.18   # smaller than this the picture is a scene, not a portrait
MAX_FACE_RATIO = 0.75   # larger than this the face is cropped tighter than a bust
MAX_OFFSET = 0.24       # face centre may sit this far from the middle

SCHEMA = {"type": "array", "items": {"type": "object", "properties": {
    "index": {"type": "integer"},
    "face_visible": {"type": "boolean"},
    "face_box": {"type": "array", "items": {"type": "integer"}},
    "single_character": {"type": "boolean"},
}, "required": ["index", "face_visible", "face_box", "single_character"]}}
QUESTION = (
    "For each image in order: face_visible = one clear anime face fills a usable part of "
    "the picture; face_box = x0,y0,x1,y1 of that face (chin to hairline, ear to ear) "
    "normalised to 0-1000, or 0,0,0,0 when there is no face; single_character = exactly one "
    "character is the subject. Answer as the JSON array only."
)


async def judge(client, paths: list[pathlib.Path]) -> list[dict]:
    parts = [types.Part.from_text(text=QUESTION)]
    for index, path in enumerate(paths):
        parts.append(types.Part.from_text(text="IMAGE index=" + str(index + 1)))
        mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
        parts.append(types.Part.from_bytes(data=path.read_bytes(), mime_type=mime))
    for attempt in range(3):
        try:
            response = await client.aio.models.generate_content(
                model=MODEL, contents=parts,
                config=types.GenerateContentConfig(response_mime_type="application/json",
                                                   response_schema=SCHEMA))
            return json.loads(response.text)
        except Exception as exc:
            if attempt == 2:
                print(f"! reader failed for {len(paths)} images: {exc}"[:160])
                return []
            await asyncio.sleep(4)
    return []


def problems(row: dict) -> list[str]:
    box = row.get("face_box") or [0, 0, 0, 0]
    if not row.get("face_visible") or len(box) != 4 or max(box) <= 0:
        return ["no face"]
    found = []
    x0, y0, x1, y1 = box
    if x0 <= 6 or y0 <= 6 or x1 >= 994 or y1 >= 994:
        found.append("face cut by the edge")
    width, height = (x1 - x0) / 1000, (y1 - y0) / 1000
    if max(width, height) < MIN_FACE_RATIO:
        found.append("face too small")
    if max(width, height) > MAX_FACE_RATIO:
        found.append("face cropped too tight")
    offset = max(abs((x0 + x1) / 2 - 500) / 1000, abs((y0 + y1) / 2 - 470) / 1000)
    if offset > MAX_OFFSET:
        found.append("face off centre")
    if not row.get("single_character"):
        found.append("more than one person")
    return found


async def audit(client, slug: str) -> list[tuple[str, list[str]]]:
    folder = IMAGES / slug
    if not folder.is_dir():
        print(f"{slug}: no folder")
        return []
    paths = sorted(p for p in folder.iterdir() if p.suffix.lower() in EXTENSIONS)
    failures: list[tuple[str, list[str]]] = []
    for start in range(0, len(paths), BATCH):
        chunk = paths[start:start + BATCH]
        for item in await judge(client, chunk):
            index = int(item.get("index", 0)) - 1
            if 0 <= index < len(chunk):
                found = problems(item)
                if found:
                    failures.append((chunk[index].name, found))
    print(f"{slug}: {len(paths)} images, {len(failures)} below the standard")
    for name, found in failures:
        print("   ", name, "->", ", ".join(found))
    return failures


async def main() -> int:
    wanted = sys.argv[1:]
    if not wanted or wanted == ["--all"]:
        wanted = sorted(p.name for p in IMAGES.iterdir() if p.is_dir())
    client = gemini._live_client("gemini1")
    total = []
    for slug in wanted:
        total.extend(await audit(client, slug))
    return 1 if total else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
