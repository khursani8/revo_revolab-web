#!/usr/bin/env python3
"""Rebuild sanoTTS espeak-data-multi from the piper-tts espeak-ng-data.

The shipped data set is 1.4.2-era (135-phoneme phontab, no Malay). The
teachers were trained with the piper trainer's own espeak build (piper1-gpl
external, 1.52.0 fork), whose data ships in the piper wheel. Phonemization
parity (bit-exact ids) requires serving the trainer's tables, so the whole
core set is rebuilt from there for the languages we ship.

Verified: wasm ids == python PiperVoice ids on all gate sentences
(ms), and amy/en-us regression PASS after rebuild.

Usage:
    python rebuild_espeak_data.py \\
        --src .venv/lib/python3.13/site-packages/piper/espeak-ng-data \\
        --dst /path/to/sanoTTS/mcu/ports/wasm/espeak-data-multi
"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

LANG_DICTS = ["en", "vi", "id", "ne", "hi", "cmn", "ms"]
LANG_VOICE_FILES = [
    "gmw/en", "gmw/en-US",        # en, en-us
    "aav/vi",                      # vi
    "poz/id", "poz/ms",            # id, ms
    "inc/ne", "inc/hi",            # ne, hi
    "sit/cmn",                     # cmn
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, required=True, help="piper espeak-ng-data dir")
    ap.add_argument("--dst", type=Path, required=True, help="espeak-data-multi dir")
    a = ap.parse_args()

    core = ["phontab", "phonindex", "phondata", "intonations"]
    for f in core:
        shutil.copy2(a.src / f, a.dst / f)

    for code in LANG_DICTS:
        d = a.src / f"{code}_dict"
        if not d.exists():
            raise FileNotFoundError(d)
        shutil.copy2(d, a.dst / d.name)

    lang_dst = a.dst / "lang"
    lang_dst.mkdir(exist_ok=True)
    for rel in LANG_VOICE_FILES:
        s = a.src / "lang" / rel
        if not s.exists():
            raise FileNotFoundError(s)
        out = lang_dst / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(s, out)

    n = sum(1 for p in a.dst.rglob("*") if p.is_file())
    total = sum(p.stat().st_size for p in a.dst.rglob("*") if p.is_file())
    print(f"rebuilt: {n} files, {total/1e6:.1f} MB — rebuild g2p wasm next "
          "(bash mcu/ports/wasm/build_g2p.sh)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
