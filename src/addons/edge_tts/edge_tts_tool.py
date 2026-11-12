"""Microsoft Edge neural text-to-speech (free, no API key) — OpenMontage Studio add-on.

Installed by OpenMontage Studio into tools/audio/edge_tts.py so the registry and the
tts_selector discover it like any other provider. Also usable from the command line:

    python -m tools.audio.edge_tts voices --lang ar
    python -m tools.audio.edge_tts synth --voice ar-EG-SalmaNeural --text "..." --out narration.mp3

Outputs: the MP3, plus <out>.words.json (word timings, seconds) and <out>.srt — ready for
Remotion/HyperFrames karaoke captions.

Note: uses Microsoft's online read-aloud service (needs internet). Free, but not an
official commercial API — for client work prefer a licensed provider if terms matter.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

try:  # the module must import even outside OpenMontage (MCP server, CLI tests)
    from tools.base_tool import (
        BaseTool, Determinism, ExecutionMode, ResourceProfile, RetryPolicy,
        ToolResult, ToolRuntime, ToolStability, ToolStatus, ToolTier,
    )
except Exception:  # pragma: no cover
    BaseTool = object  # type: ignore

# Curated Arabic dialect voices (female, male). The voice gives the regional accent;
# write the TEXT in that dialect too (e.g. Egyptian spelling for ar-EG) for natural results.
ARABIC_DIALECTS: dict[str, dict[str, Any]] = {
    "egyptian":  {"locale": "ar-EG", "label": "Egyptian (مصري)",     "voices": ["ar-EG-SalmaNeural", "ar-EG-ShakirNeural"]},
    "saudi":     {"locale": "ar-SA", "label": "Saudi (سعودي)",       "voices": ["ar-SA-ZariyahNeural", "ar-SA-HamedNeural"]},
    "emirati":   {"locale": "ar-AE", "label": "Emirati (إماراتي)",   "voices": ["ar-AE-FatimaNeural", "ar-AE-HamdanNeural"]},
    "kuwaiti":   {"locale": "ar-KW", "label": "Kuwaiti (كويتي)",     "voices": ["ar-KW-NouraNeural", "ar-KW-FahedNeural"]},
    "qatari":    {"locale": "ar-QA", "label": "Qatari (قطري)",       "voices": ["ar-QA-AmalNeural", "ar-QA-MoazNeural"]},
    "bahraini":  {"locale": "ar-BH", "label": "Bahraini (بحريني)",   "voices": ["ar-BH-LailaNeural", "ar-BH-AliNeural"]},
    "omani":     {"locale": "ar-OM", "label": "Omani (عماني)",       "voices": ["ar-OM-AyshaNeural", "ar-OM-AbdullahNeural"]},
    "yemeni":    {"locale": "ar-YE", "label": "Yemeni (يمني)",       "voices": ["ar-YE-MaryamNeural", "ar-YE-SalehNeural"]},
    "jordanian": {"locale": "ar-JO", "label": "Jordanian (أردني)",   "voices": ["ar-JO-SanaNeural", "ar-JO-TaimNeural"]},
    "lebanese":  {"locale": "ar-LB", "label": "Lebanese (لبناني)",   "voices": ["ar-LB-LaylaNeural", "ar-LB-RamiNeural"]},
    "syrian":    {"locale": "ar-SY", "label": "Syrian (سوري)",       "voices": ["ar-SY-AmanyNeural", "ar-SY-LaithNeural"]},
    "iraqi":     {"locale": "ar-IQ", "label": "Iraqi (عراقي)",       "voices": ["ar-IQ-RanaNeural", "ar-IQ-BasselNeural"]},
    "moroccan":  {"locale": "ar-MA", "label": "Moroccan (مغربي)",    "voices": ["ar-MA-MounaNeural", "ar-MA-JamalNeural"]},
    "algerian":  {"locale": "ar-DZ", "label": "Algerian (جزائري)",   "voices": ["ar-DZ-AminaNeural", "ar-DZ-IsmaelNeural"]},
    "tunisian":  {"locale": "ar-TN", "label": "Tunisian (تونسي)",    "voices": ["ar-TN-ReemNeural", "ar-TN-HediNeural"]},
    "libyan":    {"locale": "ar-LY", "label": "Libyan (ليبي)",       "voices": ["ar-LY-ImanNeural", "ar-LY-OmarNeural"]},
}
DEFAULT_VOICE = "ar-EG-SalmaNeural"
# Multilingual voices read Arabic + English in one take (good for code-switched scripts).
MULTILINGUAL = ["en-US-AvaMultilingualNeural", "en-US-AndrewMultilingualNeural", "en-US-EmmaMultilingualNeural", "en-US-BrianMultilingualNeural"]


def _pct(v: Any, default: str = "+0%") -> str:
    if v is None or v == "":
        return default
    if isinstance(v, (int, float)):  # 1.1 → +10%, 0.9 → -10%; 15 → +15%
        n = round((v - 1) * 100) if abs(v) <= 3 else round(v)
        return f"{n:+d}%"
    s = str(v).strip()
    return s if s[0] in "+-" else "+" + s


def _hz(v: Any) -> str:
    if v is None or v == "":
        return "+0Hz"
    if isinstance(v, (int, float)):
        return f"{int(v):+d}Hz"
    s = str(v).strip()
    s = s if s.endswith("Hz") else s + "Hz"
    return s if s[0] in "+-" else "+" + s


async def _synth(text: str, voice: str, out: Path, rate: str, pitch: str, volume: str) -> dict[str, Any]:
    import edge_tts  # lazy: optional dependency

    out.parent.mkdir(parents=True, exist_ok=True)
    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume, boundary="WordBoundary")
    sub = edge_tts.SubMaker()
    words: list[dict[str, Any]] = []
    with open(out, "wb") as f:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                sub.feed(chunk)
                start = chunk["offset"] / 1e7
                words.append({"text": chunk["text"], "start": round(start, 3), "end": round(start + chunk["duration"] / 1e7, 3)})
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError("No audio received from Edge TTS")
    words_path = out.with_suffix(out.suffix + ".words.json")
    srt_path = out.with_suffix(".srt")
    words_path.write_text(json.dumps({"voice": voice, "words": words}, ensure_ascii=False, indent=1), encoding="utf-8")
    srt_path.write_text(sub.get_srt(), encoding="utf-8")
    return {
        "output": str(out), "format": "mp3", "voice": voice,
        "duration_seconds": words[-1]["end"] if words else None,
        "word_timestamps": str(words_path), "srt": str(srt_path), "word_count": len(words),
    }


def synthesize(text: str, voice: str = DEFAULT_VOICE, output_path: str | Path = "tts_output.mp3",
               rate: Any = None, pitch: Any = None, volume: Any = None, dialect: str | None = None,
               gender: str | None = None) -> dict[str, Any]:
    """Synchronous helper used by the tool, the CLI and the MCP server."""
    if dialect and (not voice or voice == DEFAULT_VOICE):
        d = ARABIC_DIALECTS.get(dialect.lower())
        if d:
            voice = d["voices"][1 if (gender or "").lower().startswith("m") else 0]
    out = Path(output_path)
    if out.suffix.lower() != ".mp3":
        out = out.with_suffix(".mp3")
    return asyncio.run(_synth(text, voice or DEFAULT_VOICE, out, _pct(rate), _hz(pitch), _pct(volume)))


def list_voices(lang: str | None = None, gender: str | None = None) -> list[dict[str, str]]:
    import edge_tts

    voices = asyncio.run(edge_tts.list_voices())
    out = []
    for v in voices:
        if lang and not v["Locale"].lower().startswith(lang.lower()):
            continue
        if gender and v.get("Gender", "").lower() != gender.lower():
            continue
        out.append({"voice": v["ShortName"], "locale": v["Locale"], "gender": v.get("Gender", ""),
                    "styles": ", ".join((v.get("VoiceTag") or {}).get("VoicePersonalities", []) or [])})
    return out


if BaseTool is not object:

    class EdgeTTS(BaseTool):
        name = "edge_tts"
        version = "0.1.0"
        tier = ToolTier.VOICE
        capability = "tts"
        provider = "edge"
        stability = ToolStability.BETA
        execution_mode = ExecutionMode.SYNC
        determinism = Determinism.DETERMINISTIC
        runtime = ToolRuntime.API

        dependencies = ["python:edge_tts"]
        install_instructions = "pip install edge-tts   (no API key needed; requires internet)"
        agent_skills = ["edge-tts"]
        capabilities = ["text_to_speech", "word_timestamps", "multilingual", "arabic_dialects"]
        supports = {"voice_cloning": False, "multilingual": True, "offline": False, "native_audio": True, "word_timestamps": True}
        best_for = [
            "free narration with no API key",
            "Arabic dialect voiceover (Egyptian, Saudi, Gulf, Levantine, Maghrebi)",
            "300+ neural voices in 70+ languages",
            "word-timed captions (words.json + srt)",
        ]
        not_good_for = ["offline-only workflows", "voice cloning", "emotion/style direction"]

        input_schema = {
            "type": "object",
            "required": ["text"],
            "properties": {
                "text": {"type": "string", "description": "What to say. Write it in the target dialect for dialect voices."},
                "voice": {"type": "string", "default": DEFAULT_VOICE, "description": "Edge voice ShortName, e.g. ar-EG-SalmaNeural, ar-SA-HamedNeural, en-US-AndrewMultilingualNeural"},
                "dialect": {"type": "string", "enum": sorted(ARABIC_DIALECTS), "description": "Pick an Arabic dialect instead of a voice name"},
                "gender": {"type": "string", "enum": ["female", "male"], "default": "female"},
                "rate": {"type": ["string", "number"], "description": "'+10%' / '-5%' or a multiplier like 1.1"},
                "pitch": {"type": ["string", "number"], "description": "'+2Hz' / '-3Hz'"},
                "volume": {"type": ["string", "number"]},
                "output_path": {"type": "string"},
            },
        }
        resource_profile = ResourceProfile(cpu_cores=1, ram_mb=128, vram_mb=0, disk_mb=50, network_required=True)
        retry_policy = RetryPolicy(max_retries=2, retryable_errors=["ConnectionError", "TimeoutError", "NoAudioReceived"])
        idempotency_key_fields = ["text", "voice", "dialect", "gender", "rate", "pitch", "volume"]
        side_effects = ["writes mp3 + .words.json + .srt next to output_path"]
        user_visible_verification = ["Listen to the narration; check dialect and pronunciation of names/brands"]

        def get_status(self) -> ToolStatus:
            try:
                import edge_tts  # noqa: F401
                return ToolStatus.AVAILABLE
            except Exception:
                return ToolStatus.UNAVAILABLE

        def estimate_cost(self, inputs: dict[str, Any]) -> float:
            return 0.0

        def execute(self, inputs: dict[str, Any]) -> ToolResult:
            if self.get_status() != ToolStatus.AVAILABLE:
                return ToolResult(success=False, error="edge-tts not installed. " + self.install_instructions)
            start = time.time()
            try:
                data = synthesize(
                    inputs["text"], inputs.get("voice") or DEFAULT_VOICE, inputs.get("output_path", "tts_output.mp3"),
                    inputs.get("rate"), inputs.get("pitch"), inputs.get("volume"), inputs.get("dialect"), inputs.get("gender"),
                )
            except Exception as exc:
                return ToolResult(success=False, error=f"Edge TTS failed: {exc}")
            data.update({"provider": self.provider, "text_length": len(inputs["text"])})
            return ToolResult(success=True, data=data, artifacts=[data["output"], data["word_timestamps"], data["srt"]],
                              model=data["voice"], cost_usd=0.0, duration_seconds=round(time.time() - start, 2))


def _cli(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="edge_tts", description="Free Microsoft neural TTS (OpenMontage Studio add-on)")
    sp = p.add_subparsers(dest="cmd", required=True)
    v = sp.add_parser("voices"); v.add_argument("--lang"); v.add_argument("--gender")
    sp.add_parser("dialects")
    s = sp.add_parser("synth")
    s.add_argument("--text"); s.add_argument("--text-file"); s.add_argument("--voice", default=DEFAULT_VOICE)
    s.add_argument("--dialect"); s.add_argument("--gender"); s.add_argument("--rate"); s.add_argument("--pitch")
    s.add_argument("--volume"); s.add_argument("--out", default="tts_output.mp3")
    a = p.parse_args(argv)
    if a.cmd == "voices":
        print(json.dumps(list_voices(a.lang, a.gender), ensure_ascii=False, indent=1))
    elif a.cmd == "dialects":
        print(json.dumps(ARABIC_DIALECTS, ensure_ascii=False, indent=1))
    else:
        text = Path(a.text_file).read_text(encoding="utf-8") if a.text_file else a.text
        if not text:
            p.error("--text or --text-file is required")
        print(json.dumps(synthesize(text, a.voice, a.out, a.rate, a.pitch, a.volume, a.dialect, a.gender), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
