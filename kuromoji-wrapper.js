/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  Kuromoji.js Offline Tokenizer Wrapper                           ║
 * ║                                                                  ║
 * ║  Lazily loads kuromoji dictionary files from extension folder,   ║
 * ║  and provides morphological analysis for word segmentation.    ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

let _kuromojiTokenizer = null;
let _kuromojiLoading = false;
let _kuromojiLoadPromise = null;

/**
 * Lazily loads the Kuromoji morphological analyzer.
 * Returns the tokenizer instance or throws an error.
 */
async function loadKuromoji() {
    if (_kuromojiTokenizer) return _kuromojiTokenizer;
    if (_kuromojiLoadPromise) return _kuromojiLoadPromise;

    _kuromojiLoading = true;
    _kuromojiLoadPromise = new Promise((resolve, reject) => {
        try {
            // Retrieve absolute extension URL to the dictionaries directory
            const dicPath = chrome.runtime.getURL("lib/kuromoji/dict/");
            console.log("J-SUB KUROMOJI: Initializing dict from", dicPath);

            if (typeof kuromoji === "undefined") {
                throw new Error("kuromoji library is not loaded. Ensure lib/kuromoji/kuromoji.js is included in sidepanel.html.");
            }

            kuromoji.builder({ dicPath: dicPath }).build((err, tokenizer) => {
                if (err) {
                    console.error("J-SUB KUROMOJI: Builder error:", err);
                    _kuromojiLoading = false;
                    _kuromojiLoadPromise = null;
                    reject(err);
                } else {
                    console.log("J-SUB KUROMOJI: Tokenizer successfully initialized");
                    _kuromojiTokenizer = tokenizer;
                    _kuromojiLoading = false;
                    resolve(tokenizer);
                }
            });
        } catch (e) {
            console.error("J-SUB KUROMOJI: Exception during initialization:", e);
            _kuromojiLoading = false;
            _kuromojiLoadPromise = null;
            reject(e);
        }
    });

    return _kuromojiLoadPromise;
}

/**
 * Helper to convert Katakana to Hiragana (useful for readings matching).
 */
function katakanaToHiragana(src) {
    return src.replace(/[\u30a1-\u30f6]/g, (match) => {
        const chr = match.charCodeAt(0) - 0x60;
        return String.fromCharCode(chr);
    });
}

/**
 * Tokenizes Japanese text and returns standard formatted tokens.
 *
 * @param {string} text - The raw Japanese text to segment
 * @returns {Promise<Array>} Promise resolving to enriched token objects:
 *   {
 *     text: string (surface form),
 *     baseForm: string (dictionary form),
 *     pos: string (general part of speech),
 *     reading: string (reading in Hiragana),
 *     isWord: boolean (is a clickable vocabulary word)
 *   }
 */
async function analyzeJapaneseText(text) {
    try {
        const tokenizer = await loadKuromoji();
        if (!tokenizer) return [];

        const rawTokens = tokenizer.tokenize(text);
        return rawTokens.map(t => {
            const isPunctuationOrSpace = t.pos === "記号" || /[\s\u3000]/.test(t.surface_form);
            const isParticle = t.pos === "助詞";
            const isAuxiliaryVerb = t.pos === "助動詞";
            
            // Only make content-bearing tokens clickable (exclude particles, auxiliary verbs like だ/です, and punctuation)
            const isWord = !isPunctuationOrSpace && !isParticle && !isAuxiliaryVerb;

            // Normalize base form (use surface if base form is not provided or is '*')
            let base = t.basic_form;
            if (!base || base === "*") {
                base = t.surface_form;
            }

            // Convert reading from Katakana to Hiragana
            let reading = "";
            if (t.reading && t.reading !== "*") {
                reading = katakanaToHiragana(t.reading);
            }

            return {
                text: t.surface_form,
                baseForm: base,
                pos: t.pos,
                posDetail: t.pos_detail_1,
                reading: reading,
                isWord: isWord
            };
        });
    } catch (err) {
        console.error("J-SUB KUROMOJI: Tokenization failed, falling back to empty:", err);
        return [];
    }
}
