---
name: edge-tts
description: Free voiceover with Microsoft Edge neural voices — Arabic dialects (Egyptian, Saudi, Gulf, Levantine, Iraqi, Maghrebi), English and 70+ languages, with word timings for captions. No API key.
---

# Edge TTS (free narration)

Installed by OpenMontage Studio. Use it whenever the user has no paid TTS key, asks for
Arabic dialect narration, or wants word-timed captions. It needs internet.

## Three ways to call it

1. **OpenMontage tool** (preferred inside pipelines): `edge_tts` in the tool registry
   (also picked by `tts_selector`).
   ```python
   from tools.tool_registry import registry
   registry.discover()
   r = registry.get("edge_tts").execute({
       "text": "ازيكم يا جماعة، النهارده هنتكلم عن ...",
       "dialect": "egyptian", "gender": "male", "rate": "+5%",
       "output_path": "projects/<id>/assets/audio/narration.mp3",
   })
   ```
2. **MCP tools** (server `openmontage-studio`): `tts_synthesize`, `tts_list_voices`, `tts_arabic_dialects`.
3. **CLI**: `python -m tools.audio.edge_tts synth --dialect egyptian --gender female --text-file script.txt --out projects/<id>/assets/audio/narration.mp3`

## Outputs
- `narration.mp3`
- `narration.mp3.words.json` — `{"words":[{"text","start","end"}]}` in seconds → karaoke captions in Remotion/HyperFrames
- `narration.srt`

## Voices
| Dialect | Female | Male |
|---|---|---|
| Egyptian مصري | ar-EG-SalmaNeural | ar-EG-ShakirNeural |
| Saudi سعودي | ar-SA-ZariyahNeural | ar-SA-HamedNeural |
| Emirati إماراتي | ar-AE-FatimaNeural | ar-AE-HamdanNeural |
| Kuwaiti / Qatari / Bahraini / Omani | ar-KW-NouraNeural / ar-QA-AmalNeural / ar-BH-LailaNeural / ar-OM-AyshaNeural | ar-KW-FahedNeural / ar-QA-MoazNeural / ar-BH-AliNeural / ar-OM-AbdullahNeural |
| Levantine: Jordanian / Lebanese / Syrian | ar-JO-SanaNeural / ar-LB-LaylaNeural / ar-SY-AmanyNeural | ar-JO-TaimNeural / ar-LB-RamiNeural / ar-SY-LaithNeural |
| Iraqi / Yemeni | ar-IQ-RanaNeural / ar-YE-MaryamNeural | ar-IQ-BasselNeural / ar-YE-SalehNeural |
| Maghrebi: Moroccan / Algerian / Tunisian / Libyan | ar-MA-MounaNeural / ar-DZ-AminaNeural / ar-TN-ReemNeural / ar-LY-ImanNeural | ar-MA-JamalNeural / ar-DZ-IsmaelNeural / ar-TN-HediNeural / ar-LY-OmarNeural |
| Arabic + English mixed in one line | en-US-AvaMultilingualNeural | en-US-AndrewMultilingualNeural |

Run `tts_list_voices` (or `voices --lang xx`) for any other language before choosing — never guess a voice name.

## Quality rules
- **Write the script in the dialect you want** (Egyptian spelling for ar-EG). The voice only gives the accent; MSA text read by ar-EG still sounds formal.
- Spell English brand names the way they should sound, or use a Multilingual voice for code-switched lines.
- Keep sentences short; add commas where you want breaths. Use `rate` (−10%…+15%) for pacing, not pitch.
- Generate per scene/section (one file per script section) so timing maps cleanly onto the scene plan.
- Always listen-check (or transcribe back) names and numbers before compose.
- Online service, not an official commercial API: mention this in the proposal when the user's project is for a paying client.
