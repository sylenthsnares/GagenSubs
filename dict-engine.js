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
    // ── Ichidan (一段) Verb Conjugations ──────────────────────────
    // Ichidan verbs drop る and add conjugation suffixes
    ["ている", "る", "te-iru progressive (ichidan stem)"],
    ["ていた", "る", "te-ita past progressive (ichidan stem)"],
    ["てる", "る", "contracted te-iru (ichidan)"],
    ["てた", "る", "contracted te-ita (ichidan)"],
    ["られる", "る", "potential/passive (ichidan)"],
    ["させる", "る", "causative (ichidan)"],
    ["られた", "る", "potential/passive past (ichidan)"],
    ["させた", "る", "causative past (ichidan)"],
    ["ません", "ます", "masu negative"],
    ["ました", "ます", "masu past"],
    ["ている", "る", "progressive"],
    ["なかった", "ない", "negative past"],
    ["なければ", "ない", "negative conditional"],
    ["なくて", "ない", "negative te-form"],

    // ── Godan (五段) Verb Conjugations ────────────────────────────
    // た-form (past tense)
    ["った", "う", "ta-form (u-verb)"],
    ["った", "つ", "ta-form (tsu-verb)"],
    ["った", "る", "ta-form (ru-godan)"],
    ["んだ", "ぬ", "ta-form (nu-verb)"],
    ["んだ", "ぶ", "ta-form (bu-verb)"],
    ["んだ", "む", "ta-form (mu-verb)"],
    ["いた", "く", "ta-form (ku-verb)"],
    ["いだ", "ぐ", "ta-form (gu-verb)"],
    ["した", "す", "ta-form (su-verb)"],

    // て-form
    ["って", "う", "te-form (u-verb)"],
    ["って", "つ", "te-form (tsu-verb)"],
    ["って", "る", "te-form (ru-godan)"],
    ["んで", "ぬ", "te-form (nu-verb)"],
    ["んで", "ぶ", "te-form (bu-verb)"],
    ["んで", "む", "te-form (mu-verb)"],
    ["いて", "く", "te-form (ku-verb)"],
    ["いで", "ぐ", "te-form (gu-verb)"],
    ["して", "す", "te-form (su-verb)"],

    // ない-form (negative)
    ["わない", "う", "nai-form (u-verb)"],
    ["たない", "つ", "nai-form (tsu-verb)"],
    ["らない", "る", "nai-form (ru-godan)"],
    ["なない", "ぬ", "nai-form (nu-verb)"],
    ["ばない", "ぶ", "nai-form (bu-verb)"],
    ["まない", "む", "nai-form (mu-verb)"],
    ["かない", "く", "nai-form (ku-verb)"],
    ["がない", "ぐ", "nai-form (gu-verb)"],
    ["さない", "す", "nai-form (su-verb)"],

    // ます-form (polite)
    ["います", "う", "masu-form (u-verb)"],
    ["ちます", "つ", "masu-form (tsu-verb)"],
    ["ります", "る", "masu-form (ru-godan/ichidan)"],
    ["にます", "ぬ", "masu-form (nu-verb)"],
    ["びます", "ぶ", "masu-form (bu-verb)"],
    ["みます", "む", "masu-form (mu-verb)"],
    ["きます", "く", "masu-form (ku-verb)"],
    ["ぎます", "ぐ", "masu-form (gu-verb)"],
    ["します", "す", "masu-form (su-verb)"],

    // ── Ichidan simple forms ─────────────────────────────────────
    ["ない", "る", "nai-form (ichidan)"],
    ["たい", "る", "tai-form (ichidan desiderative)"],
    ["ます", "る", "masu-form (ichidan)"],
    ["た", "る", "ta-form (ichidan)"],
    ["て", "る", "te-form (ichidan)"],

    // ── い-Adjective Conjugations ────────────────────────────────
    ["くない", "い", "i-adj negative"],
    ["かった", "い", "i-adj past"],
    ["くなかった", "い", "i-adj negative past"],
    ["くて", "い", "i-adj te-form"],
    ["く", "い", "i-adj adverbial"],
    ["さ", "い", "i-adj nominalization"],
];

/**
 * Attempts to deconjugate a word by trying all known suffix rules.
 * Returns an array of possible base forms (may be empty).
 */
function deconjugate(word) {
    const candidates = new Set();

    for (const [ending, replacement] of DECONJ_RULES) {
        if (word.endsWith(ending) && word.length > ending.length) {
            const stem = word.slice(0, -ending.length);
            if (stem.length > 0) {
                candidates.add(stem + replacement);
            }
        }
    }

    return Array.from(candidates);
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
