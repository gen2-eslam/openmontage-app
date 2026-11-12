# OpenMontage Studio

تطبيق ديسكتوب (Electron) لويندوز وماك ولينكس بيجمع:

- **محرك OpenMontage المفتوح المصدر** (AGPL-3.0): 12 بايبلاين، والأدوات والسكيلز، والـ checkpoints.
- **واجهة على طريقة TopView**: سايدبار، وهوم فيها composer، وكانفاس لا نهائي فيه كروت (Brief ← Script ← Scenes ← Final render)، وإنسبكتور، وتايملاين، وبلاير.
- **أي AI Agent على طريقة HyperFrames Studio**: Claude Code وCodex وGemini CLI وCursor Agent وOpenCode وCopilot CLI وQwen Code، أو أي CLI تضيفه بنفسك.

## إزاي بيشتغل

```
أنت (Chat + تحديد عناصر على الكانفاس)
   │  prompt + "المستخدم بيشاور على: Scene sc2 → assets/images/sc2.png"
   ▼
Agent CLI  (claude -p … / codex exec --json … / gemini -p …)   ← cwd = فولدر OpenMontage
   │  بيقرا AGENT_GUIDE.md والسكيلز وبيشغّل أدوات Python
   ▼
projects/<id>/  project.json · checkpoint_*.json · artifacts/ · assets/ · renders/
   │  fs.watch + backlot.state (نفس منطق لوحة Backlot)
   ▼
الكانفاس والتايملاين بيتحدثوا لايف
```

- كل رسالة بتتبعت للإيجنت في وضع headless، والـ output بيتحول لأحداث موحدة (نص، أدوات، نتايج، تكلفة)، والسيشن بيكمل لكل مشروع (`--resume`).
- **Approval gates**: لما stage تبقى `awaiting_human` بيظهر بانر فيه Approve / Request changes.
- **تعديلات صغيرة**: من الإنسبكتور تقدر تعدّل نص السكريبت ووصف المشهد مباشرة في `artifacts/*.json`، أو تدوس على أكشن سريع (Regenerate، More cinematic، Animate، 9:16، Captions) فيتبعت للإيجنت ومعاه العنصر المحدد.
- **Custom agent**: من صفحة Agents ← Add custom agent: الأمر، والـ args بـ `{prompt}`، والـ resume بـ `{session}`، وفلاجات الموافقة التلقائية، وصيغة الـ output.


## نسخة كاملة بدون تثبيت (Bundled)

التطبيق بيتبني ومعاه كل حاجة جواه. اليوزر **مش محتاج يثبت أي حاجة غير الإيجنت بتاعه**.

| جوه التطبيق (`Resources/bundle`) | المصدر |
|---|---|
| Python 3.12 محمول | python-build-standalone |
| Node.js 22 (node / npm / npx) | nodejs.org |
| ffmpeg + ffprobe | ffmpeg-static / ffprobe-static |
| OpenMontage (آخر commit) ومعاه `remotion-composer/node_modules` وChrome headless | GitHub |
| كل الـ Python wheels (requirements وpiper-tts) | PyPI |

- **البناء**: `npm run bundle` بيعمل `vendor/<os>-<arch>/`، وبعدين `./build.sh mac`. الـ `build:*` بيعمل الـ bundle لوحده. لازم تبني على كل نظام لوحده (الـ wheels والبرامج بتختلف حسب النظام).
- **أول تشغيل**: الإنجن بيتنسخ لـ `~/OpenMontage`، والـ venv بيتعمل من الـ wheels اللي جوه التطبيق (offline، حوالي دقيقة). الأدوات اللي جوه التطبيق بتتحط أول الـ PATH، فالإيجنت بيستخدمها تلقائي.
- **التحديثات**: التطبيق بيشيك على GitHub وقت التشغيل وكل 6 ساعات. التحديث بينزّل آخر نسخة ويطبقها من غير ما يلمس `projects/` و`.env` و`.venv`، ولو الـ requirements اتغيرت بيحدّث الباكدجات. وفي كمان شيك على تحديثات الإيجنتس (`claude update` أو `npm i -g`) من الإعدادات.


## الإدخال بالصوت (Speech-to-Text)

- زرار 🎤 في أي مكان بتكتب فيه للإيجنت (الشات والهوم)، أو `⌘/Ctrl+Shift+M`. تدوس، تتكلم، تدوس تاني والكلام بيتكتب. `Esc` بيلغي.
- **محلي ومجاني وoffline**: `faster-whisper` بموديل `small` جوه التطبيق (عربي مصري مع مصطلحات إنجليزي). OpenMontage كمان بيستخدمه في الترجمة.
- **Cloud اختياري**: Groq (`whisper-large-v3-turbo`)، أو OpenAI (`gpt-4o-mini-transcribe`، ولو مش متاح بيرجع لـ `whisper-1`)، أو ElevenLabs Scribe. المفاتيح بتتحفظ في `.env`.
- الإعدادات (Settings ← Voice input): المحرك، واللغة (تلقائي/عربي/إنجليزي)، وحجم الموديل (tiny لحد large-v3)، والإرسال التلقائي.
- الموديل اللي بيدخل في الـ bundle بيتحدد بـ `OM_BUNDLE_STT_MODEL=small` (أو `none` عشان متضيفوش).


## Add-ons: Edge TTS (فويس أوفر مجاني)

- أصوات Microsoft Neural من غير API key (محتاج إنترنت): **16 لهجة عربي** (مصري، سعودي، إماراتي، كويتي، قطري، بحريني، عماني، يمني، أردني، لبناني، سوري، عراقي، مغربي، جزائري، تونسي، ليبي)، وإنجليزي، و70+ لغة.
- بيطلع ملف MP3، ومعاه `.words.json` (توقيت كل كلمة) و`.srt` عشان الترجمة المتحركة.
- بيتثبت لوحده في الإنجن على 3 أشكال:
  1. **أداة OpenMontage**: `tools/audio/edge_tts.py` (الـ registry والـ `tts_selector` بيلاقوها لوحدهم).
  2. **Skill**: `.claude/skills/edge-tts` و`.agents/skills/edge-tts`.
  3. **MCP server** اسمه `openmontage-studio` وفيه `tts_synthesize` و`tts_list_voices` و`tts_arabic_dialects`. Claude Code بيستخدمه عن طريق `--mcp-config`، وCodex عن طريق `-c mcp_servers…`، وGemini وQwen وCursor وOpenCode عن طريق ملفات الإعدادات في فولدر الإنجن.
- من Settings ← Add-ons تقدر تجرب أي لهجة وتسمعها.

## التشغيل للتطوير

```bash
npm install
npm start
```

أول مرة هتفتح شاشة **Setup**: بتعمل clone لـ OpenMontage في `~/OpenMontage`، وبتعمل venv، وبتنزّل requirements وremotion وpiper، وبتعمل `.env`. لو عندك نسخة جاهزة استخدم "Use existing folder".

المتطلبات: Git، وPython 3.10+، وNode 18+ (و22+ لو هتستخدم HyperFrames runtime)، وFFmpeg، وإيجنت واحد على الأقل متثبت ومتسجل الدخول فيه.

## بناء الـ installers

| النظام | الأمر | الناتج |
|---|---|---|
| macOS | `./build.sh mac` | `dist/*.dmg` (arm64 + x64) |
| Linux | `./build.sh linux` | `dist/*.AppImage` + `dist/*.deb` |
| Windows | `.\build.ps1` | `dist/*Setup*.exe` (NSIS) |

> ابنِ كل نظام على نفسه (أو على CI) عشان `node-pty` (التيرمينال الاختياري) يتعمله compile صح. لو `node-pty` مش موجود، التطبيق بيشتغل عادي من غير التيرمينال الداخلي.

## هيكل المشروع

```
src/
├── main.js              # Electron main: window، بروتوكول om:// للميديا (Range)، IPC، sessions، terminal، Backlot
├── preload.js           # window.om API الآمن
├── main/
│   ├── util.js          # PATH من الـ login shell، والـ spawn الآمن على ويندوز (.cmd)، والـ Store
│   ├── agents.js        # presets الإيجنتس، والـ custom agents، والـ stream parsers
│   ├── openmontage.js   # setup، والـ deps، والـ .env، والبايبلاينز، والسكيلز
│   └── projects.js      # state عن طريق backlot.state (Python) مع fallback بـ Node، وwatch، وpatch
└── renderer/
    ├── index.html  styles.css  lib.js
    ├── app.js           # Sidebar والـ Home والـ Projects والـ Agents والـ Pipelines والـ Skills والـ Settings والـ Setup
    └── workspace.js     # Chat والـ Canvas والـ Inspector والـ Timeline والـ Player
```

## ملاحظات

- الترخيص **AGPL-3.0** زي OpenMontage. لو هتوزعه لازم الكود يفضل مفتوح.
- الواجهة **مستوحاة** من layout وألوان TopView (dark #101010، والـ accent البنفسجي #731dfb). مفيش كود ولا لوجو ولا أصول منقولة منهم.
- "Auto-approve" مفعّل افتراضيًا، لأن الإنتاج headless محتاج الإيجنت يشغّل أدوات Python وffmpeg من غير ما يقف يسأل. تقدر تقفله من Settings.
