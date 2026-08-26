# Building the wasm engines from source

The binaries in `dist/` (`snt_g2p.{js,wasm,data}`, `snt_voice.{js,wasm}`)
are compiled from the [sanoTTS](https://github.com/Ampixa/sanoTTS) runtime
(GPL-3.0) with the Revolab Malay modifications carried in this repo's
patches. This file is the complete reproducible build.

## Prerequisites

- sanoTTS clone: `git clone https://github.com/Ampixa/sanoTTS`
- [Emscripten](https://emscripten.org) (emcc) on PATH
- The `piper-tts` Python package (its bundled `espeak-ng-data` is the data
  source — must match the trainers' espeak build)

## Steps

```bash
cd sanoTTS

# 1. apply the Revolab patches (g2p terminator API + ms/sarah/paan
#    phoneme-table slots 8/9/10, espeak source sync to the piper1-gpl fork)
git apply /path/to/this/repo/0001-g2p-terminator-api-and-ms-slots.patch
git apply /path/to/this/repo/0002-espeak-sources-sync-piper-fork.patch

# 2. rebuild the espeak data set from the piper wheel (adds Malay voice +
#    dictionaries; the shipped 1.4.2-era set has no ms)
python /path/to/this/repo/rebuild_espeak_data.py \
    --src <piper-venv>/lib/python3.13/site-packages/piper/espeak-ng-data \
    --dst mcu/ports/wasm/espeak-data-multi

# 3. build the g2p engine
(cd mcu/ports/wasm && bash build_g2p.sh)      # -> web/snt_g2p.{js,wasm,data}

# 4. build the voice engine (weight-agnostic runtime)
(cd mcu/ports/wasm && bash build_voices.sh)   # -> web/snt_voice.{js,wasm}

# 5. copy the four/five outputs into this repo's dist/
```

Note: if your environment masks GPUs inside a container, `emcc` invocations
must run with a system `python3` available — wrapper shims that intercept
`python3` (e.g. uv guards) break the Emscripten toolchain. Prefixing
`PATH=/usr/bin:/bin:$EMSDK/upstream/emscripten` is the usual fix.

## Verification gates (what CI on this repo should check)

1. **Phoneme-id parity**: ids from the built `snt_g2p.wasm` (voice `ms`,
   slot 8) must equal `PiperVoice.phonemes_to_ids()` from piper-tts on the
   same text — bit-exact. This is the gate the patches exist to pass.
2. **Synthesis sanity**: `RevolabWeb.load()` → `synthesize()` for each
   voice produces >1 s of finite samples.
3. **Waveform correlation vs the PyTorch students** ≥ 0.98 (paper's
   golden-gate threshold; the shipped build measures 1.000000).

## Licence

Engine sources: GPL-3.0 (sanoTTS + espeak-ng). The patches and build files
in this repo inherit GPL-3.0. Voice weights in `voices/` are distilled from
Revolab's own teacher models and follow Revolab's voice-asset terms.
