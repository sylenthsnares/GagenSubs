# GagenSubs — J-Sub Explainer Engine

A Chrome extension that extracts Japanese subtitles from Netflix, translates them in real-time, and provides an interactive dictionary for language learners.

## Features

- 📺 **Real-time subtitle extraction** — Automatically intercepts Japanese subtitles from Netflix
- 🔄 **Batch translation** — Translates all subtitles using DeepL (primary) or Gemini (fallback)
- 📖 **Offline dictionary** — 460,000+ word offline JMDict dictionary with deconjugation engine
- ⭐ **Vocabulary saving** — Save words you're learning with mastery tracking
- 🃏 **Flashcard reader** — Review saved vocabulary with spaced-repetition flashcards
- 🔍 **Smart highlighting** — Tracks the currently playing subtitle with fuzzy matching

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer mode** (toggle in the top-right)
4. Click **Load unpacked** and select this project folder
5. Navigate to Netflix and play a show with Japanese subtitles
6. Click the extension icon to open the side panel

## Setup

Open the side panel and click **⚙ Settings** to configure:

- **DeepL API Key** (Primary translator) — Get a free key at [deepl.com/pro-api](https://www.deepl.com/pro-api)
- **Gemini API Key** (Fallback translator + extended dictionary) — Get one at [aistudio.google.com](https://aistudio.google.com/apikey)

At least one API key is required for translations. The offline dictionary works without any keys.

## Rebuilding the Dictionary (Optional)

The dictionary (`data/jmdict-lookup.json`) is included and ready to use. If you want to rebuild it with a newer version:

```bash
node tools/build-dict.js
```

## License

The source code of this extension is provided as-is for educational and personal use.

### JMDict Dictionary Data

The offline dictionary data (`data/jmdict-lookup.json`) is derived from the [JMdict](https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project) dictionary project, which is the property of the [Electronic Dictionary Research and Development Group (EDRDG)](https://www.edrdg.org/), and is used in conformance with the Group's [licence](https://www.edrdg.org/edrdg/licence.html).

JMdict is licensed under the [Creative Commons Attribution-ShareAlike 4.0 International License (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/).

The JSON conversion is based on [jmdict-simplified](https://github.com/scriptin/jmdict-simplified) by Dmitry Shpika.
