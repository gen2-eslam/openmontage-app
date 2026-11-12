"""Kokoro-82M narration (the local voice model HyperFrames uses for `hyperframes tts`).

Reads one JSON job from stdin:
  {"model": ".../kokoro-v1.0.onnx", "voices": ".../voices-v1.0.bin",
   "items": [{"text": "...", "out": ".../vo.wav", "voice": "am_michael", "speed": 1.0, "lang": "en-us"}]}
For every item it writes the WAV plus <out>.words.json (word timings in seconds, same shape as the
Edge TTS add-on) and <out>.srt. Sentences are synthesized one by one, so captions line up with the
real sentence boundaries. One JSON line per finished item goes to stdout.
"""
import inspect
import json
import os
import re
import shutil
import sys
import tempfile

import kokoro_onnx
import numpy as np
import soundfile as sf

LANG_FROM_PREFIX = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "j": "ja", "p": "pt-br", "z": "cmn"}
GAP = 0.22  # pause between sentences, seconds


def espeak_config():
    """espeak-ng on Windows can't read a data folder past 260 chars (same fix as HyperFrames)."""
    if os.name != "nt" or "espeak_config" not in inspect.signature(kokoro_onnx.Kokoro.__init__).parameters:
        return {}
    import espeakng_loader
    from kokoro_onnx.config import EspeakConfig
    source = espeakng_loader.get_data_path()
    if len(source) < 200:
        return {}
    target = os.path.join(tempfile.gettempdir(), "hyperframes-espeak-ng-data")
    if not os.path.isdir(target):
        staging = target + "." + str(os.getpid())
        shutil.copytree(source, staging)
        try:
            os.rename(staging, target)
        except OSError:
            shutil.rmtree(staging, ignore_errors=True)
    return {"espeak_config": EspeakConfig(data_path=target)}


def sentences(text):
    text = re.sub(r"\s+", " ", text).strip()
    parts = re.split(r"(?<=[.!?。！？…])\s+|(?<=[;:])\s+(?=\S{12,})", text)
    out = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        # very long sentences overflow Kokoro's 510-token window → split on commas
        while len(p) > 360:
            cut = max(p.rfind(", ", 0, 360), p.rfind(" ", 0, 360))
            if cut <= 0:
                cut = 360
            out.append(p[:cut + 1].strip())
            p = p[cut + 1:].strip()
        if p:
            out.append(p)
    return out


def synth(model, text, kwargs):
    try:
        return model.create(text, **kwargs)
    except IndexError:
        if len(text) < 2:
            raise
        mid = len(text) // 2
        cut = text.rfind(" ", 0, mid) if text.rfind(" ", 0, mid) > 0 else mid
        a, ra = synth(model, text[:cut], kwargs)
        b, rb = synth(model, text[cut:], kwargs)
        return np.concatenate([a, b]), ra


def trim(samples, rate, db=-45.0):
    """Drop leading/trailing near-silence so sentence timings stay tight."""
    if len(samples) == 0:
        return samples, 0.0
    thr = 10 ** (db / 20)
    idx = np.where(np.abs(samples) > thr)[0]
    if len(idx) == 0:
        return samples, 0.0
    a = max(0, idx[0] - int(0.03 * rate))
    b = min(len(samples), idx[-1] + int(0.06 * rate))
    return samples[a:b], a / rate


def srt_time(t):
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def main():
    job = json.load(sys.stdin)
    model = kokoro_onnx.Kokoro(job["model"], job["voices"], **espeak_config())
    supports_lang = "lang" in inspect.signature(model.create).parameters
    for item in job["items"]:
        voice = item.get("voice") or "af_heart"
        lang = item.get("lang") or LANG_FROM_PREFIX.get(voice[:1], "en-us")
        kwargs = {"voice": voice, "speed": float(item.get("speed") or 1.0)}
        if supports_lang:
            kwargs["lang"] = lang
        try:
            chunks, words, cues, t, rate = [], [], [], 0.0, 24000
            for sent in sentences(item["text"]):
                samples, rate = synth(model, sent, kwargs)
                samples, _ = trim(np.asarray(samples, dtype=np.float32), rate)
                dur = len(samples) / rate
                toks = sent.split(" ")
                weights = [len(w) + 1 for w in toks]
                total = float(sum(weights)) or 1.0
                cur = t
                for w, wt in zip(toks, weights):
                    d = dur * wt / total
                    words.append({"text": w, "start": round(cur, 3), "end": round(cur + d, 3)})
                    cur += d
                cues.append((t, t + dur, sent))
                chunks.append(samples)
                chunks.append(np.zeros(int(GAP * rate), dtype=np.float32))
                t += dur + GAP
            audio = np.concatenate(chunks[:-1]) if chunks else np.zeros(1, dtype=np.float32)
            out = item["out"]
            os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
            sf.write(out, audio, rate)
            with open(out + ".words.json", "w", encoding="utf-8") as f:
                json.dump({"voice": voice, "engine": "kokoro", "words": words}, f, ensure_ascii=False, indent=1)
            with open(os.path.splitext(out)[0] + ".srt", "w", encoding="utf-8") as f:
                for i, (a, b, s) in enumerate(cues, 1):
                    f.write(f"{i}\n{srt_time(a)} --> {srt_time(b)}\n{s}\n\n")
            print(json.dumps({"ok": True, "out": out, "duration": round(len(audio) / rate, 3), "words": len(words)}), flush=True)
        except Exception as e:  # keep going with the other items
            print(json.dumps({"ok": False, "out": item.get("out"), "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
