/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  Offline Japanese-to-English Gloss Translation Engine            ║
 * ║                                                                  ║
 * ║  Uses Kuromoji morphological analysis + local JMDict data to      ║
 * ║  produce an interactive structural gloss of Japanese sentences    ║
 * ║  entirely offline.                                               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ═══════════════════════════════════════════════════════════════════
// §1. Grammar and Particle Gloss Maps
// ═══════════════════════════════════════════════════════════════════

const PARTICLE_GLOSSES = {
    "は": "topic",
    "が": "subject",
    "を": "object",
    "に": "to/at",
    "で": "by/at",
    "と": "with/and",
    "も": "also",
    "の": "of/'s",
    "から": "from",
    "まで": "until",
    "へ": "to",
    "か": "?",
    "ね": "right?",
    "よ": "!",
    "し": "and",
    "や": "and/etc",
    "など": "etc",
};

const AUXILIARY_GLOSSES = {
    "た": "past",
    "だ": "is/be",
    "です": "polite-be",
    "ます": "polite",
    "ますた": "polite-past", // Normalizes/merges with preceding
    "ない": "not",
    "ん": "not", // Contraction
    "たい": "want to",
    "せる": "causative",
    "させる": "causative",
    "れる": "passive/potential",
    "られる": "passive/potential",
    "まい": "probably not",
    "よう": "let's/try",
    "おう": "let's/try",
    "そう": "seems like",
    "らしい": "seems like",
};

const GRAMMAR_CONNECTIONS = {
    "て": "and/then",
    "で": "and/then",
    "たら": "if/when",
    "ば": "if",
    "なら": "if so",
    "から": "because",
    "ので": "since",
    "ながら": "while",
};

// ═══════════════════════════════════════════════════════════════════
// §2. Helper Functions
// ═══════════════════════════════════════════════════════════════════

/**
 * Gets a clean, short English definition for a base word from JMDict.
 */
function getJmdictGloss(baseForm, dict) {
    if (!dict) return null;
    const entries = dict[baseForm];
    if (!entries || entries.length === 0) return null;
    
    const entry = entries[0];
    if (!entry.s || entry.s.length === 0) return null;
    
    // Grab the first sense and join up to 2 meanings
    const glosses = entry.s[0].g || [];
    if (glosses.length === 0) return null;
    
    // Filter out long descriptions, keep it compact
    const shortGlosses = glosses.slice(0, 2).map(g => {
        // Strip parenthetical details if too long
        return g.replace(/\s*\(.*?\)\s*/g, "").trim();
    });
    
    return shortGlosses.join("/");
}

// ═══════════════════════════════════════════════════════════════════
// §3. Core Translation API
// ═══════════════════════════════════════════════════════════════════

/**
 * Translates a Japanese sentence into an offline gloss representation.
 *
 * @param {string} sentence - The Japanese sentence
 * @returns {Promise<string>} An English gloss translation string
 */
async function translateSentenceOffline(sentence) {
    if (!sentence || !sentence.trim()) return "";

    try {
        // 1. Ensure dictionary and tokenizer are loaded
        const dict = typeof getLoadedDictionary === "function" ? getLoadedDictionary() : null;
        let tokens = [];
        try {
            tokens = await analyzeJapaneseText(sentence);
        } catch (err) {
            console.warn("J-SUB OFFLINE TRANS: Kuromoji analysis failed, using fallback:", err);
        }

        if (!tokens || tokens.length === 0) {
            // Fallback: Segment using the sync tokenizer in sidepanel
            if (typeof tokenizeJapanese === "function") {
                try {
                    const regexTokens = tokenizeJapanese(sentence);
                    tokens = regexTokens.map(t => ({
                        text: t.text,
                        baseForm: t.text,
                        pos: t.clickable ? "名詞" : "記号",
                        reading: "",
                        isWord: t.clickable
                    }));
                } catch (e) {
                    console.error("J-SUB: Regex fallback tokenizer failed:", e);
                }
            }
        }

        if (!tokens || tokens.length === 0) {
            return "Unable to parse sentence.";
        }

        const glosses = [];
        let skipNext = false;

        for (let i = 0; i < tokens.length; i++) {
            if (skipNext) {
                skipNext = false;
                continue;
            }

            const token = tokens[i];
            const nextToken = tokens[i + 1];

            // A. Handle punctuation and symbols
            if (token.pos === "記号") {
                // Keep punctuation but normalize to standard full-width/half-width mapping
                const puncMap = { "。": ".", "、": ",", "「": "\"", "」": "\"", "？": "?", "！": "!" };
                const translatedPunc = puncMap[token.text] || "";
                if (translatedPunc) {
                    glosses.push(translatedPunc);
                }
                continue;
            }

            // B. Check for grammar verb/adjective conjugation mergers
            // E.g., Verb + "たい" (desire), Verb + "ない" (negative), Verb + "ます" (polite)
            let suffixGloss = "";
            if (nextToken && (nextToken.pos === "助動詞" || nextToken.posDetail === "接続助詞")) {
                const suffixText = nextToken.text;
                if (AUXILIARY_GLOSSES[suffixText]) {
                    suffixGloss = `[${AUXILIARY_GLOSSES[suffixText]}]`;
                    skipNext = true; // Consume next token
                } else if (GRAMMAR_CONNECTIONS[suffixText]) {
                    suffixGloss = `[${GRAMMAR_CONNECTIONS[suffixText]}]`;
                    skipNext = true;
                }
            }

            // C. Translate Particles
            if (token.pos === "助詞") {
                const particleGloss = PARTICLE_GLOSSES[token.text];
                if (particleGloss) {
                    glosses.push(`(${particleGloss})`);
                }
                continue;
            }

            // D. Translate Auxiliaries directly (if not merged)
            if (token.pos === "助動詞") {
                const auxGloss = AUXILIARY_GLOSSES[token.text];
                if (auxGloss) {
                    glosses.push(`[${auxGloss}]`);
                }
                continue;
            }

            // E. Translate Words (nouns, verbs, adjectives, adverbs, etc.)
            let wordTranslation = null;
            
            // Try matching base form in JMDict
            if (dict) {
                wordTranslation = getJmdictGloss(token.baseForm, dict);
                
                // Fallback to surface form lookup if base form lookup failed
                if (!wordTranslation && token.text !== token.baseForm) {
                    wordTranslation = getJmdictGloss(token.text, dict);
                }
            }

            // Assemble token gloss
            if (wordTranslation) {
                let term = wordTranslation;
                if (suffixGloss) {
                    term = `${term}-${suffixGloss}`;
                }
                glosses.push(term);
            } else {
                // If offline dictionary doesn't have it, print original token or katakana reading
                let fallback = token.text;
                if (suffixGloss) {
                    fallback = `${fallback}-${suffixGloss}`;
                }
                glosses.push(fallback);
            }
        }

        // Clean up formatting of the output string
        let glossOutput = glosses.join(" ")
            .replace(/\s+([.,!?])/g, "$1") // Remove spacing before punctuation
            .replace(/\(\s+/g, "(")
            .replace(/\s+\)/g, ")")
            .trim();

        // Capitalize the first letter for natural feel
        if (glossOutput.length > 0) {
            glossOutput = glossOutput.charAt(0).toUpperCase() + glossOutput.slice(1);
        }

        return glossOutput;
    } catch (e) {
        console.error("J-SUB OFFLINE TRANS: Translation failed:", e);
        return "Translation error (offline)";
    }
}
