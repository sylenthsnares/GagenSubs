/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  JMDict Offline Dictionary Engine                                ║
 * ║                                                                  ║
 * ║  Loads jmdict-lookup.json lazily on first use, provides O(1)    ║
 * ║  lookups by kanji/kana, and includes a deconjugation engine     ║
 * ║  to find base forms of inflected words.                          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ═══════════════════════════════════════════════════════════════════
// §1. State
// ═══════════════════════════════════════════════════════════════════

let _dictData = null;
let _dictLoading = false;
let _dictLoadPromise = null;

// ═══════════════════════════════════════════════════════════════════
// §2. Dictionary Loading
// ═══════════════════════════════════════════════════════════════════

/**
 * Lazily loads the JMDict lookup data from the extension's data directory.
 * Returns the dictionary Map or null if loading fails.
 */
async function loadDictionary() {
    if (_dictData) return _dictData;
    if (_dictLoadPromise) return _dictLoadPromise;

    _dictLoading = true;
    _dictLoadPromise = (async () => {
        try {
            const url = chrome.runtime.getURL("data/jmdict-lookup.json");
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            _dictData = await res.json();
            console.log(`J-SUB DICT: Loaded ${Object.keys(_dictData).length} dictionary keys`);
            return _dictData;
        } catch (e) {
            console.warn("J-SUB DICT: Failed to load offline dictionary:", e);
            return null;
        } finally {
            _dictLoading = false;
        }
    })();

    return _dictLoadPromise;
}

// ═══════════════════════════════════════════════════════════════════
// §3. Deconjugation Engine
// ═══════════════════════════════════════════════════════════════════

/**
 * Common Japanese verb/adjective conjugation suffixes and their base forms.
 * Each rule: [ending to strip, replacement, description]
 *
 * Ordered by specificity — longer endings first to prevent partial matches.
 */
const DECONJ_RULES = [
    // ── 3-character endings ──────────────────────────────────────
    ["ていた", "る", "te-ita past progressive (ichidan stem)"],
    ["られた", "る", "potential/passive past (ichidan)"],
    ["させた", "る", "causative past (ichidan)"],
    ["ければ", "ない", "negative conditional"],
    ["なくて", "ない", "negative te-form"],
    ["かった", "い", "i-adj past"],
    ["たれる", "つ", "passive (tsu-verb)"],
    ["られる", "る", "passive (ru-verb/ichidan)"],
    ["なれる", "ぬ", "passive (nu-verb)"],
    ["ばれる", "ぶ", "passive (bu-verb)"],
    ["まれる", "む", "passive (mu-verb)"],
    ["かれる", "く", "passive (ku-verb)"],
    ["がれる", "ぐ", "passive (gu-verb)"],
    ["される", "す", "passive (su-verb)"],
    ["われる", "う", "passive (u-verb)"],
    ["たせる", "つ", "causative (tsu-verb)"],
    ["らせる", "る", "causative (ru-verb)"],
    ["なせる", "ぬ", "causative (nu-verb)"],
    ["ばせる", "ぶ", "causative (bu-verb)"],
    ["ませる", "む", "causative (mu-verb)"],
    ["かせる", "く", "causative (ku-verb)"],
    ["がせる", "ぐ", "causative (gu-verb)"],
    ["させる", "る", "causative (ichidan/su-verb)"],
    ["わせる", "う", "causative (u-verb)"],
    ["ちたい", "つ", "desiderative (tsu-verb)"],
    ["りたい", "る", "desiderative (ru-verb)"],
    ["にたい", "ぬ", "desiderative (nu-verb)"],
    ["びたい", "ぶ", "desiderative (bu-verb)"],
    ["みたい", "む", "desiderative (mu-verb)"],
    ["きたい", "く", "desiderative (ku-verb)"],
    ["ぎたい", "ぐ", "desiderative (gu-verb)"],
    ["したい", "す", "desiderative (su-verb)"],
    ["いたい", "う", "desiderative (u-verb)"],

    // ── 2-character endings ──────────────────────────────────────
    ["ている", "る", "te-iru progressive (ichidan stem)"],
    ["なかった", "ない", "negative past"],
    ["くない", "い", "i-adj negative"],
    ["くて", "い", "i-adj te-form"],
    ["ました", "ます", "masu past"],
    ["ません", "ます", "masu negative"],
    ["わない", "う", "nai-form (u-verb)"],
    ["たない", "つ", "nai-form (tsu-verb)"],
    ["らない", "る", "nai-form (ru-godan)"],
    ["なない", "ぬ", "nai-form (nu-verb)"],
    ["ばない", "ぶ", "nai-form (bu-verb)"],
    ["まない", "む", "nai-form (mu-verb)"],
    ["かない", "く", "nai-form (ku-verb)"],
    ["がない", "ぐ", "nai-form (gu-verb)"],
    ["さない", "す", "nai-form (su-verb)"],
    ["います", "う", "masu-form (u-verb)"],
    ["ちます", "つ", "masu-form (tsu-verb)"],
    ["ります", "る", "masu-form (ru-godan/ichidan)"],
    ["にます", "ぬ", "masu-form (nu-verb)"],
    ["びます", "ぶ", "masu-form (bu-verb)"],
    ["みます", "む", "masu-form (mu-verb)"],
    ["きます", "く", "masu-form (ku-verb)"],
    ["ぎます", "ぐ", "masu-form (gu-verb)"],
    ["します", "す", "masu-form (su-verb)"],
    ["った", "う", "ta-form (u-verb)"],
    ["った", "つ", "ta-form (tsu-verb)"],
    ["った", "る", "ta-form (ru-godan)"],
    ["った", "く", "ta-form (irregular iku)"],
    ["んだ", "ぬ", "ta-form (nu-verb)"],
    ["んだ", "ぶ", "ta-form (bu-verb)"],
    ["んだ", "む", "ta-form (mu-verb)"],
    ["いた", "く", "ta-form (ku-verb)"],
    ["いだ", "ぐ", "ta-form (gu-verb)"],
    ["した", "す", "ta-form (su-verb)"],
    ["した", "する", "ta-form (suru-verb)"],
    ["って", "う", "te-form (u-verb)"],
    ["って", "つ", "te-form (tsu-verb)"],
    ["って", "る", "te-form (ru-godan)"],
    ["って", "く", "te-form (irregular iku)"],
    ["んで", "ぬ", "te-form (nu-verb)"],
    ["んで", "ぶ", "te-form (bu-verb)"],
    ["んで", "む", "te-form (mu-verb)"],
    ["いて", "く", "te-form (ku-verb)"],
    ["いで", "ぐ", "te-form (gu-verb)"],
    ["して", "す", "te-form (su-verb)"],
    ["して", "する", "te-form (suru-verb)"],
    ["たい", "る", "tai-form (ichidan desiderative)"],
    ["てる", "る", "contracted te-iru (ichidan)"],
    ["てた", "る", "contracted te-ita (ichidan)"],
    ["える", "う", "potential (u-verb)"],
    ["てる", "つ", "potential (tsu-verb)"],
    ["れる", "る", "potential (ru-verb)"],
    ["ねる", "ぬ", "potential (nu-verb)"],
    ["べる", "ぶ", "potential (bu-verb)"],
    ["める", "む", "potential (mu-verb)"],
    ["ける", "く", "potential (ku-verb)"],
    ["げる", "ぐ", "potential (gu-verb)"],
    ["せる", "す", "potential (su-verb)"],

    // ── 1-character endings ──────────────────────────────────────
    ["ない", "る", "nai-form (ichidan)"],
    ["ます", "る", "masu-form (ichidan)"],
    ["た", "る", "ta-form (ichidan)"],
    ["て", "る", "te-form (ichidan)"],
    ["く", "い", "i-adj adverbial"],
    ["さ", "い", "i-adj nominalization"],
];

// Ensure specificity ordering (longest endings matched first)
DECONJ_RULES.sort((a, b) => b[0].length - a[0].length);

/**
 * Recursively deconjugates a word by trying suffix rules up to 3 levels deep.
 * Returns an array of possible base forms (unique).
 */
function deconjugate(word) {
    const candidates = new Set();

    function helper(w, depth) {
        if (depth > 3) return;
        for (const [ending, replacement] of DECONJ_RULES) {
            if (w.endsWith(ending) && w.length > ending.length) {
                const stem = w.slice(0, -ending.length);
                if (stem.length > 0) {
                    const base = stem + replacement;
                    if (!candidates.has(base)) {
                        candidates.add(base);
                        helper(base, depth + 1);
                    }
                }
            }
        }
    }

    helper(word, 0);
    return Array.from(candidates);
}

/**
 * Fast check if a word (or deconjugated candidate) exists in JMDict.
 */
function checkWordInDict(word, dict) {
    if (!dict) return null;
    if (dict[word]) return word;
    const baseForms = deconjugate(word);
    for (const base of baseForms) {
        if (dict[base]) return base;
    }
    return null;
}

/**
 * Segments a Japanese text string using a dictionary-guided Forward Maximum Matching algorithm.
 */
function segmentWithDict(text, dict) {
    const tokens = [];
    let i = 0;
    const len = text.length;

    // Anchor regexes to current match position
    const REGEX_SPACE = /^[\s\u3000]+/;
    const REGEX_OTHER = /^[^\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\uFF66-\uFF9F\s\u3000]+/;
    const REGEX_KANJI = /^[\u4E00-\u9FFF\u3400-\u4DBF]+[\u3040-\u309F]{0,6}/;
    const REGEX_KATAKANA = /^[\u30A0-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]+/;
    const REGEX_HIRAGANA_WORD = /^[\u3040-\u309F]{2,}/;
    const REGEX_HIRAGANA_CHAR = /^[\u3040-\u309F]/;

    while (i < len) {
        const rem = text.slice(i);

        // 1. Whitespace
        const spaceMatch = rem.match(REGEX_SPACE);
        if (spaceMatch) {
            tokens.push({ text: spaceMatch[0], clickable: false });
            i += spaceMatch[0].length;
            continue;
        }

        // 2. Non-Japanese (Latin, symbols, punctuation)
        const otherMatch = rem.match(REGEX_OTHER);
        if (otherMatch) {
            tokens.push({ text: otherMatch[0], clickable: false });
            i += otherMatch[0].length;
            continue;
        }

        // 3. Try Dictionary-Guided Matching (lengths 10 down to 1)
        let matchedLength = 0;
        const maxCheckLen = Math.min(10, rem.length);

        for (let L = maxCheckLen; L >= 1; L--) {
            const cand = rem.slice(0, L);

            // Skip single hiragana as they are usually particles or matched in fallback
            if (L === 1 && /^[\u3040-\u309F]$/.test(cand)) {
                continue;
            }

            if (checkWordInDict(cand, dict)) {
                matchedLength = L;
                tokens.push({ text: cand, clickable: true });
                i += L;
                break;
            }
        }

        if (matchedLength > 0) {
            continue;
        }

        // 4. Fallback: match using standard character type heuristics
        const kanjiMatch = rem.match(REGEX_KANJI);
        if (kanjiMatch) {
            tokens.push({ text: kanjiMatch[0], clickable: true });
            i += kanjiMatch[0].length;
            continue;
        }

        const katakanaMatch = rem.match(REGEX_KATAKANA);
        if (katakanaMatch) {
            tokens.push({ text: katakanaMatch[0], clickable: true });
            i += katakanaMatch[0].length;
            continue;
        }

        const hiraganaWordMatch = rem.match(REGEX_HIRAGANA_WORD);
        if (hiraganaWordMatch) {
            tokens.push({ text: hiraganaWordMatch[0], clickable: true });
            i += hiraganaWordMatch[0].length;
            continue;
        }

        const hiraganaCharMatch = rem.match(REGEX_HIRAGANA_CHAR);
        if (hiraganaCharMatch) {
            tokens.push({ text: hiraganaCharMatch[0], clickable: false });
            i += hiraganaCharMatch[0].length;
            continue;
        }

        // Hard fallback: just consume 1 character to avoid infinite loop
        tokens.push({ text: rem[0], clickable: false });
        i += 1;
    }

    return tokens;
}

// ═══════════════════════════════════════════════════════════════════
// §4. Lookup API
// ═══════════════════════════════════════════════════════════════════

/**
 * Looks up a Japanese word in the offline dictionary.
 * Tries the exact form first, then attempts deconjugation.
 *
 * @param {string} word - The Japanese word to look up
 * @returns {object|null} - { word, entries: [...] } or null if not found
 *
 * Each entry in entries:
 *   { k: [kanji], r: [readings], s: [{ pos: [...], g: [...] }] }
 */
async function lookupWord(word) {
    const dict = await loadDictionary();
    if (!dict) return null;

    // ── Try exact match first ────────────────────────────────────
    if (dict[word]) {
        return { word, entries: dict[word], exact: true };
    }

    // ── Try deconjugation ────────────────────────────────────────
    const baseForms = deconjugate(word);
    for (const base of baseForms) {
        if (dict[base]) {
            return { word: base, originalForm: word, entries: dict[base], exact: false };
        }
    }

    // ── Try removing trailing particles ──────────────────────────
    // Sometimes tokenizer groups particles with the word
    const particles = ["は", "が", "を", "に", "で", "と", "も", "の", "へ", "か", "よ", "ね"];
    for (const p of particles) {
        if (word.endsWith(p) && word.length > 1) {
            const stripped = word.slice(0, -1);
            if (dict[stripped]) {
                return { word: stripped, originalForm: word, entries: dict[stripped], exact: false };
            }
            // Try deconjugation on the stripped form too
            const strippedBases = deconjugate(stripped);
            for (const base of strippedBases) {
                if (dict[base]) {
                    return { word: base, originalForm: word, entries: dict[base], exact: false };
                }
            }
        }
    }

    return null;
}

/**
 * Formats a dictionary result into an HTML string for display in the tooltip.
 */
function formatDictResult(result) {
    if (!result || !result.entries || result.entries.length === 0) return null;

    const entry = result.entries[0]; // Use the first (most relevant) entry
    const kanji = entry.k?.join("、") || "";
    const readings = entry.r?.join("、") || "";
    const headword = kanji || readings;

    let html = `<div class="dict-entry">`;

    // Header: word + reading
    html += `<div class="dict-header">`;
    html += `<span class="dict-word">📖 ${escapeHtml(headword)}</span>`;
    if (kanji && readings) {
        html += `<span class="dict-reading">【${escapeHtml(readings)}】</span>`;
    }
    html += `</div>`;

    // Deconjugation notice
    if (!result.exact && result.originalForm) {
        html += `<div class="dict-deconj">⟵ from: ${escapeHtml(result.originalForm)}</div>`;
    }

    // Senses
    for (let i = 0; i < Math.min(entry.s.length, 3); i++) {
        const sense = entry.s[i];
        html += `<div class="dict-sense">`;
        if (sense.pos?.length > 0) {
            html += `<span class="dict-pos">${escapeHtml(sense.pos.join(", "))}</span>`;
        }
        html += `<span class="dict-gloss">${i + 1}. ${escapeHtml(sense.g.join("; "))}</span>`;
        html += `</div>`;
    }

    html += `</div>`;
    return html;
}

/**
 * Returns a compact data object for saving a word from a dict result.
 */
function extractWordData(result) {
    if (!result || !result.entries || result.entries.length === 0) return null;

    const entry = result.entries[0];
    const kanji = entry.k?.[0] || "";
    const reading = entry.r?.[0] || "";
    const senses = entry.s || [];
    const firstSense = senses[0] || {};

    return {
        word: kanji || reading,
        reading: reading,
        meaning: (firstSense.g || []).join("; "),
        pos: (firstSense.pos || []).join(", "),
        allSenses: senses.map(s => ({
            pos: (s.pos || []).join(", "),
            meaning: (s.g || []).join("; ")
        }))
    };
}

/**
 * Synchronously returns the loaded dictionary if available, otherwise null.
 */
function getLoadedDictionary() {
    return _dictData;
}
