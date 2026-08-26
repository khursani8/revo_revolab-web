// revolab-web — browser wrapper around the RevolabWeb Edge WebAssembly
// runtime (Revolab's distilled Malay voices).
//
// Same contract as the sanoTTS web runtime it builds on:
//   1. load the espeak-ng G2P wasm module (SaanoG2P) and the acoustic+decoder
//      wasm module (SaanoVoice) — Emscripten MODULARIZE builds, UMD not ESM,
//      so they are injected as classic <script> tags and read off `window`.
//   2. per voice: snt_g2p_set_voice(espeak_voice, g2p_voice_slot) switches the
//      phonemizer, snt_g2p_text_to_ids() phonemizes text into the
//      [BOS,PAD,(id,PAD)*,EOS] id sequence the acoustic model expects.
//   3. snt_voice_synthesize(front_blob, dec_blob, ids, n_ids, length_scale,
//      out_ptr, out_cap) renders the waveform.
//
// Voice weights (front_f32.bin + dec_f32.bin + meta.json) are NOT bundled —
// ~5.6 MB per voice in fp32, fetched + cached lazily on first use.

// Zero-config default: jsDelivr's npm CDN serving THIS package (dist/ runtime + voices/).
// The GitHub repo is private, so a gh CDN path is not an option.
// Swap to https://revolab.ai/static/revolab-web/ once that host exists (bump version).
const DEFAULT_ASSET_BASE = 'https://cdn.jsdelivr.net/npm/@revolab/revolab-web@0.1.0/';

const G2P_SCRIPT = 'snt_g2p.js';
const VOICE_SCRIPT = 'snt_voice.js';
const G2P_GLOBAL = 'SaanoG2P';
const VOICE_GLOBAL = 'SaanoVoice';

const MAX_PHONEME_IDS = 1024;
const DEFAULT_MAX_SECONDS = 20; // output-buffer cap passed to snt_voice_synthesize
const DEFAULT_VOICE = 'angellyn';

// url -> Promise<factoryFn>. Keyed by exact script URL so loading the same
// assetBase twice never injects a duplicate <script> tag, while loading a
// *different* assetBase always actually fetches that url.
const scriptLoadPromises = new Map();

function joinUrl(base, path) {
  return (base.endsWith('/') ? base : base + '/') + path;
}

function loadGlobalScript(url, globalName) {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error(
      `revolab-web: no DOM available to load "${url}" — this package is browser-only ` +
      `(it injects the Emscripten runtime as a <script> tag).`
    ));
  }
  let pending = scriptLoadPromises.get(url);
  if (!pending) {
    pending = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = url;
      el.async = true;
      el.onload = () => {
        const factory = globalThis[globalName];
        if (typeof factory !== 'function') {
          reject(new Error(`revolab-web: loaded "${url}" but window.${globalName} was not a function afterward`));
          return;
        }
        resolve(factory);
      };
      el.onerror = () => reject(new Error(`revolab-web: failed to load script "${url}"`));
      document.head.appendChild(el);
    });
    // A failed load should not poison future load() calls — let a retry retry.
    pending.catch(() => scriptLoadPromises.delete(url));
    scriptLoadPromises.set(url, pending);
  }
  return pending;
}

function toHeap(mod, bytes) {
  const ptr = mod._malloc(bytes.length);
  mod.HEAPU8.set(bytes, ptr);
  return ptr;
}

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`revolab-web: fetch ${url} failed: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`revolab-web: fetch ${url} failed: HTTP ${r.status}`);
  return r.json();
}

/**
 * Known-voice registry for building a voice picker. NOT authoritative — the
 * actual espeak_voice / g2p_voice_slot / length_scale used at synth time
 * always come from that voice's own meta.json, fetched lazily by
 * loadVoice()/synthesize().
 */
export const KNOWN_VOICES = Object.freeze([
  { key: 'angellyn', label: 'angellyn', language: 'Malay', flag: '🇲🇾' },
  { key: 'sarah',    label: 'sarah',    language: 'Malay', flag: '🇲🇾' },
  { key: 'paan',     label: 'paan',     language: 'Malay', flag: '🇲🇾' },
]);

export class RevolabWeb {
  /** @private — use RevolabWeb.load() */
  constructor({ G2P, Voice, assetBase }) {
    this._G2P = G2P;
    this._Voice = Voice;
    this._assetBase = assetBase;
    this._setVoiceFn = null;
    this._voiceBundles = new Map(); // "voiceBase\0key" -> Promise<{meta,front,dec}>
  }

  /**
   * Load the G2P (espeak-ng) and acoustic/decoder WebAssembly modules. Must
   * be called (and awaited) once before synthesize().
   *
   * @param {object} [opts]
   * @param {string} [opts.assetBase] - directory holding snt_g2p.{js,wasm,data}
   *   and snt_voice.{js,wasm}. Defaults to the Revolab-hosted copy; point it
   *   at your own host (or this package's dist/) to self-host.
   * @returns {Promise<RevolabWeb>}
   */
  static async load({ assetBase = DEFAULT_ASSET_BASE } = {}) {
    if (!assetBase.endsWith('/')) assetBase += '/';

    const [g2pFactory, voiceFactory] = await Promise.all([
      loadGlobalScript(joinUrl(assetBase, G2P_SCRIPT), G2P_GLOBAL),
      loadGlobalScript(joinUrl(assetBase, VOICE_SCRIPT), VOICE_GLOBAL),
    ]);

    const locateFile = (path) => joinUrl(assetBase, path);
    const [G2P, Voice] = await Promise.all([
      g2pFactory({ locateFile }),
      voiceFactory({ locateFile }),
    ]);

    if (typeof G2P._snt_g2p_init !== 'function') {
      throw new Error('revolab-web: snt_g2p.wasm did not export _snt_g2p_init — wrong/stale build at assetBase?');
    }
    const rc = G2P._snt_g2p_init();
    if (rc !== 0) {
      throw new Error(`revolab-web: snt_g2p_init() failed, rc=${rc}`);
    }

    return new RevolabWeb({ G2P, Voice, assetBase });
  }

  _setG2PVoice(espeakVoice, slot) {
    if (!this._setVoiceFn) {
      this._setVoiceFn = this._G2P.cwrap('snt_g2p_set_voice', 'number', ['string', 'number']);
    }
    const rc = this._setVoiceFn(espeakVoice, slot);
    if (rc !== 0) {
      throw new Error(`revolab-web: snt_g2p_set_voice("${espeakVoice}", ${slot}) failed, rc=${rc}`);
    }
  }

  _g2pIds(text) {
    const G2P = this._G2P;
    const nBytes = G2P.lengthBytesUTF8(text) + 1;
    const textPtr = G2P._malloc(nBytes);
    const idsPtr = G2P._malloc(MAX_PHONEME_IDS * 4);
    try {
      G2P.stringToUTF8(text, textPtr, nBytes);
      const n = G2P._snt_g2p_text_to_ids(textPtr, idsPtr, MAX_PHONEME_IDS);
      if (n <= 0) {
        throw new Error(`revolab-web: phonemizer returned ${n} for text ${JSON.stringify(text)}`);
      }
      return new Int32Array(G2P.HEAP32.buffer, idsPtr, n).slice();
    } finally {
      G2P._free(textPtr);
      G2P._free(idsPtr);
    }
  }

  /**
   * Fetch (and cache) a voice's weight bundle: meta.json + front_f32.bin +
   * dec_f32.bin. Safe to call ahead of synthesize() to prefetch while the
   * user is still typing or picking a voice.
   *
   * @param {string} key - voice key, e.g. "angellyn"
   * @param {object} [opts]
   * @param {string} [opts.voiceBase] - directory holding voices/<key>/.
   * @returns {Promise<{meta: object, front: Uint8Array, dec: Uint8Array}>}
   */
  loadVoice(key, { voiceBase = DEFAULT_ASSET_BASE } = {}) {
    if (!voiceBase.endsWith('/')) voiceBase += '/';
    const cacheKey = voiceBase + ' ' + key;
    let pending = this._voiceBundles.get(cacheKey);
    if (!pending) {
      const dir = joinUrl(voiceBase, `voices/${key}/`);
      pending = (async () => {
        const [meta, front, dec] = await Promise.all([
          fetchJson(dir + 'meta.json'),
          fetchBytes(dir + 'front_f32.bin'),
          fetchBytes(dir + 'dec_f32.bin'),
        ]);
        return { meta, front, dec };
      })();
      // A transient network failure shouldn't permanently poison this voice.
      pending.catch(() => this._voiceBundles.delete(cacheKey));
      this._voiceBundles.set(cacheKey, pending);
    }
    return pending;
  }

  /**
   * Synthesize Malay speech, entirely on-device.
   *
   * @param {string} text
   * @param {object} [opts]
   * @param {string} [opts.voice] - voice key (default "angellyn")
   * @param {string} [opts.voiceBase] - see loadVoice()
   * @param {number} [opts.lengthScale] - override the voice's default
   *   length_scale from meta.json (speaking rate; larger = slower)
   * @param {number} [opts.maxSeconds] - output buffer cap in seconds (default 20)
   * @returns {Promise<{samples: Float32Array, sampleRate: number, phonemeCount: number, elapsedMs: number}>}
   */
  async synthesize(text, { voice = DEFAULT_VOICE, voiceBase = DEFAULT_ASSET_BASE, lengthScale, maxSeconds = DEFAULT_MAX_SECONDS } = {}) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('revolab-web: synthesize() requires a non-empty string');
    }
    const bundle = await this.loadVoice(voice, { voiceBase });
    const sampleRate = bundle.meta.sample_rate || 22050;
    const scale = lengthScale !== undefined ? lengthScale : bundle.meta.length_scale;

    this._setG2PVoice(bundle.meta.espeak_voice, bundle.meta.g2p_voice_slot);
    const ids = this._g2pIds(text);

    const Voice = this._Voice;
    const outCap = Math.round(sampleRate * maxSeconds);
    const frontPtr = toHeap(Voice, bundle.front);
    const decPtr = toHeap(Voice, bundle.dec);
    const idsPtr = toHeap(Voice, new Uint8Array(ids.buffer, 0, ids.length * 4));
    const outPtr = Voice._malloc(outCap * 4);
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      const n = Voice._snt_voice_synthesize(frontPtr, decPtr, idsPtr, ids.length, scale, outPtr, outCap);
      if (n < 0) {
        throw new Error(`revolab-web: snt_voice_synthesize() returned ${n} for voice "${voice}"`);
      }
      const samples = new Float32Array(n);
      samples.set(Voice.HEAPF32.subarray(outPtr >> 2, (outPtr >> 2) + n));
      const elapsedMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      return { samples, sampleRate, phonemeCount: ids.length, elapsedMs };
    } finally {
      Voice._free(frontPtr);
      Voice._free(decPtr);
      Voice._free(idsPtr);
      Voice._free(outPtr);
    }
  }
}

/**
 * Play a synthesize() result via WebAudio.
 *
 * @param {{samples: Float32Array, sampleRate: number}} result
 * @param {object} [opts]
 * @param {AudioContext} [opts.audioContext] - reuse an existing context
 * @returns {AudioBufferSourceNode} already-started source node
 */
export function playAudio({ samples, sampleRate }, { audioContext } = {}) {
  const AudioCtor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AudioCtor) {
    throw new Error('revolab-web: playAudio() requires a browser WebAudio API (window.AudioContext)');
  }
  const ctx = audioContext || new AudioCtor();
  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.getChannelData(0).set(samples);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
  return source;
}

export { DEFAULT_ASSET_BASE, DEFAULT_VOICE };
