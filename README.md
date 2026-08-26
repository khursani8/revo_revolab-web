# revolab-web

Browser-native neural Malay text-to-speech — WebAssembly, no server, no
upload. Three Revolab voices (angellyn, sarah, paan), each a 1.39M-parameter
duration/acoustic/decoder stack distilled from a production Revolab speaker,
plus an espeak-ng phonemizer compiled to wasm. All synthesis happens
on-device: after the assets load, you can go offline.

Zero runtime dependencies. `dist/` ships the wasm runtime (~2.7 MB) and
`voices/` the three weight bundles (~5.6 MB each, fp32); weights are
fetched lazily on first use. The default asset/voice base is the jsDelivr
npm CDN, so `load()` works with no configuration once the package is
published. Self-host by copying `dist/` + `voices/` and passing
`assetBase`/`voiceBase`.

## Install

```
npm install @revolab/revolab-web
```

## Usage

```js
import { RevolabWeb, playAudio } from '@revolab/revolab-web';

const tts = await RevolabWeb.load({ assetBase: '/static/revolab-web/' });  // where you copied dist/
const result = await tts.synthesize('Selamat pagi! Saya suara Revolab dalam pelayar anda.', {
  voice: 'angellyn',
  voiceBase: '/static/revolab-web/',   // where you copied voices/
});

console.log(result.samples.length, result.sampleRate); // Float32Array, 22050
playAudio(result);
```

`synthesize()` resolves to:

```ts
{
  samples: Float32Array,   // mono PCM, range [-1, 1]
  sampleRate: number,      // 22050
  phonemeCount: number,    // length of the phoneme-id sequence
  elapsedMs: number,       // wall-clock time in the wasm synth call
}
```

### API

- **`RevolabWeb.load({ assetBase })`** — load the G2P + acoustic/decoder wasm
  modules. Call once. `assetBase` is where you host `dist/` contents.
- **`tts.synthesize(text, { voice, voiceBase, lengthScale, maxSeconds })`** —
  phonemize and render. `lengthScale` overrides the voice's default speaking
  rate; `maxSeconds` caps the output buffer (default 20).
- **`tts.loadVoice(key, { voiceBase })`** — prefetch + cache a voice's
  weights ahead of the first synthesis.
- **`playAudio(result, { audioContext })`** — play a result via WebAudio.
- **`KNOWN_VOICES`** — `[{ key, label, language, flag }]` for building a
  voice picker; synthesis always reads the voice's own `meta.json`.
- **`DEFAULT_ASSET_BASE`** — the Revolab-hosted default for asset/voice
  bases.

Browser-only: the Emscripten glue is injected as `<script>` tags (UMD, not
ESM), so this throws under plain Node without a DOM.

## Voices

| Key | Language | Params | Teacher (HF `Revolab/vits`) |
|---|---|---|---|
| `angellyn` | Malay (`ms`) | 1.39M | angellyn |
| `sarah` | Malay (`ms`) | 1.39M | sarah |
| `paan` | Malay (`ms`) | 1.39M | paan |

Each voice is `meta.json` (~1KB) + `front_f32.bin` (~1.6MB) +
`dec_f32.bin` (~4MB), fetched from `voiceBase` on first use and cached in
memory for the page's lifetime.

## Self-hosting

Copy `dist/` (wasm runtime) and `voices/` (weights) to your CDN or static
dir, then pass `assetBase` / `voiceBase` pointing at them. The source and
self-host layout live in the
[RevolabWeb Edge repo](https://github.com/khursanirevo/revolab-web)
(`demo/` is a ready-made hosted layout).

## Provenance & license

The wasm engines are compiled from the sanoTTS runtime (GPL-3.0), with
Revolab's Malay additions (espeak data + phoneme-table slots for `ms`).
The voice weights are distilled from Revolab's own teachers and follow
Revolab's voice-asset terms. Technology preview: quality is below the
server-side voices and has not passed the production listening gate.
