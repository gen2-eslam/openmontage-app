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


## المعاينة والتصدير (HyperFrames)

- **المعاينة**: البلاير في التايملاين هو `<hyperframes-player>` (Apache-2.0)، بصوت وترجمة. لو الإيجنت عمل composition بتاعة HyperFrames (فولدر فيه `hyperframes.json` و`index.html`) بيتعرض هو. لو لأ، التطبيق بيبني **Draft cut** لوحده في `projects/<id>/.studio/draft/` من المشاهد (صورة أو فيديو، ولو مفيش بيعمل كارت عنوان متحرك)، ومن الفويس أوفر والمزيكا والترجمة اللي متزامنة مع توقيت الكلمات.
- الـ runtime بيتحقن محليًا من preview server على `127.0.0.1`، فالمعاينة شغالة من غير إنترنت.
- **مشهد لوحده**: دبل كليك على المشهد في التايملاين، أو "Play scene" من الإنسبكتور، بيشغّله لوحده (range).
- **التصدير**: زرار Export بيطلع فيديو كامل MP4 أو مشهد لوحده أو GIF، بجودة Fast أو Standard أو High، ومعاه شريط تقدم وزرار إلغاء. الملف بيتحفظ في `projects/<id>/renders/` وبيظهر على الكانفاس.
  - لو المصدر Draft: المشهد بيترندر لوحده.
  - لو المصدر composition بتاعة الإيجنت: بيترندر الفيلم كله وبعدين المشهد بيتقص بـ ffmpeg.
- **الفويس أوفر الناقص**: لو الـ `asset_manifest` فيه ملفات narration مش موجودة على الديسك، بيظهر بانر "Generate free"، وبيولّدها بـ Edge TTS في نفس المسارات وبالمحتوى بتاع السكريبت، ويبلّغ الإيجنت.
- محتاج Node 22+ (موجود في الـ bundle) وchrome-headless-shell (موجود في الـ bundle، ولو مش موجود بيتنزّل أول مرة تصدّر فيها).

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

## اختيار الموديل + أسئلة الإيجنت بالاختيارات

- **الموديل**: جنب اسم الإيجنت في الشات فيه زرار الموديل (Default / Opus / Sonnet / Haiku / النسخ المثبتة لكلود، Gemini 2.5 Pro/Flash…). تقدر تكتب أي اسم موديل في **Custom** (مثلاً لـ Codex أو OpenCode). الاختيار بيتحفظ لكل مشروع ولكل إيجنت، وبيتبعت للـ CLI كـ `--model` أو `-m`. **Default** معناها إعداد الـ CLI نفسه.
- **الأسئلة**: لما الإيجنت يحتاج قرار، بيسأل بصيغة `<studio-question>` فيظهر السؤال كـ كارت وتحته الاختيارات. اضغط اختيار وهيتبعت على طول، أو اختار أكتر من حاجة في الأسئلة متعددة الاختيار واضغط **Send answers**، أو اكتب إجابتك بنفسك. الأسئلة العادية اللي فيها A) / B) / 1. / 2. في آخر الرد بتتحول لكروت هي كمان.

## أدوات HyperFrames جوه البرنامج

زرار **HyperFrames tools** فوق في أي مشروع، وكل حاجة شغالة محليًا ومجانًا:
- **Voice**: صوت Kokoro-82M، نفس الموديل اللي HyperFrames بيستخدمه في `hyperframes tts`. فيه 54 صوت (إنجليزي أمريكي وبريطاني، إسباني، فرنسي، إيطالي، هندي، برتغالي، ياباني، صيني)، بيشتغل أوفلاين، وبيحفظ توقيت الكلمات للكابشن. **مفيهوش عربي**، فالعربي بيفضل على Edge TTS باللهجات. أول مرة بينزّل حوالي 340MB (لو عملت `npm run bundle` بيبقى جوه الباندل).
- **Captions**: `hyperframes transcribe` لأي صوت أو فيديو، وبيطلع `.srt` و `.words.json`.
- **Blocks**: كتالوج فيه 448 بلوك وكومبوننت (ستايلات كابشن، ترانزيشن، تايتل كاردز، شارتات، واجهات). بتضيف اللي عايزه للمشروع والإيجنت بيحطه في الفيديو.
- **Media**: شيل الخلفية من صورة أو فيديو (PNG أو WebM شفاف)، واكتشف البيت والـ BPM في المزيكا.
- **Website**: صوّر موقع حقيقي (سكرينشوتس، لوجوهات، ألوان) عشان الفيديو يعرض المنتج الحقيقي.
- **Review**: `hyperframes check` (أخطاء الكومبوزيشن، ومعاه زرار تبعتها للإيجنت يصلحها) و snapshot لفريمات أساسية.

**إصلاح الفويس أوفر الناقص**: البانر بقى فيه اختيار المحرك: Auto أو Kokoro أو Edge. الـ Auto بيستخدم Kokoro للإنجليزي والباقي، و Edge للسطور العربي.

**للإيجنتس**: سكيلز HyperFrames (hyperframes و hyperframes-cli و media-use) بتتنسخ لكل الإيجنتس، وأمر `hyperframes` بيبقى موجود في الـ PATH بتاعهم (أوفلاين ومن غير telemetry). يعني الإيجنت يقدر يستخدم كل أوامر HyperFrames المحلية بنفسه.

**التايم لاين**: زرار ⌄ بيصغّره لشريط رفيع فيه play والوقت، وزرار ⌃ بيرجّعه. وتقدر تسحب الحافة اللي فوق التايم لاين عشان تكبّره أو تصغّره، أو تعمل دبل كليك عليها.
