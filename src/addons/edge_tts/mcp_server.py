"""OpenMontage Studio MCP server: free Edge TTS voiceover (Arabic dialects + 70 languages).

Launched by OpenMontage Studio for every agent (Claude Code, Codex, Gemini, Cursor, OpenCode).
Args: <OpenMontage repo> <projects root> (or env OM_ROOT / OPENMONTAGE_PROJECTS_DIR).
"""

from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path

# argv: mcp_server.py <openmontage_root> <projects_dir>  (env vars as fallback)
ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OM_ROOT") or Path.cwd())
PROJECTS = Path(sys.argv[2] if len(sys.argv) > 2 else os.environ.get("OPENMONTAGE_PROJECTS_DIR") or ROOT / "projects")
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))

try:
    from tools.audio.edge_tts import ARABIC_DIALECTS, DEFAULT_VOICE, MULTILINGUAL, list_voices, synthesize
except Exception:  # running outside the engine: use the copy shipped with the app
    from edge_tts_tool import ARABIC_DIALECTS, DEFAULT_VOICE, MULTILINGUAL, list_voices, synthesize  # type: ignore

try:  # mcp >= 2
    from mcp.server.mcpserver import MCPServer as _Server
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server

mcp = _Server("openmontage-studio")


def _out_path(project_id: str | None, filename: str | None, output_path: str | None) -> Path:
    if output_path:
        p = Path(output_path)
        return p if p.is_absolute() else ROOT / p
    name = re.sub(r"[^\w.-]+", "_", filename or f"voiceover_{int(time.time())}.mp3")
    if project_id:
        if not re.fullmatch(r"[\w.-]+", project_id):
            raise ValueError("invalid project_id")
        return PROJECTS / project_id / "assets" / "audio" / name
    return ROOT / "tts_output" / name


@mcp.tool()
def tts_synthesize(text: str, voice: str = "", dialect: str = "", gender: str = "female", rate: str = "+0%",
                   pitch: str = "+0Hz", project_id: str = "", filename: str = "", output_path: str = "") -> dict:
    """Generate a voiceover MP3 for free with Microsoft Edge neural voices (no API key, needs internet).

    Pick either `voice` (e.g. ar-EG-SalmaNeural, ar-SA-HamedNeural, en-US-AndrewMultilingualNeural)
    or an Arabic `dialect` (egyptian, saudi, emirati, kuwaiti, qatari, bahraini, omani, yemeni,
    jordanian, lebanese, syrian, iraqi, moroccan, algerian, tunisian, libyan) plus `gender`.
    Write the text in the same dialect for natural results. Use rate like "+10%" and pitch like "-2Hz".
    With `project_id` the file is saved to projects/<id>/assets/audio/<filename>.
    Also writes <file>.words.json (word timings in seconds) and <file>.srt for captions.
    """
    out = _out_path(project_id or None, filename or None, output_path or None)
    return synthesize(text, voice or DEFAULT_VOICE, out, rate, pitch, None, dialect or None, gender)


@mcp.tool()
def tts_list_voices(language: str = "ar", gender: str = "") -> list[dict]:
    """List available Edge TTS voices for a language/locale prefix (e.g. 'ar', 'ar-EG', 'en', 'fr')."""
    return list_voices(language or None, gender or None)


@mcp.tool()
def tts_arabic_dialects() -> dict:
    """Curated Arabic dialect → (female, male) voice map, plus multilingual voices for Arabic/English mixed scripts."""
    return {"dialects": ARABIC_DIALECTS, "multilingual_voices": MULTILINGUAL, "default": DEFAULT_VOICE}


if __name__ == "__main__":
    mcp.run()
