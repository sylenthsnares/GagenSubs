/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  Offline Japanese-to-English Sentence Translation Engine          ║
 * ║                                                                   ║
 * ║  Uses Kuromoji morphological analysis + local JMDict data to      ║
 * ║  produce clause-structure-aware English translations of Japanese  ║
 * ║  sentences entirely offline.                                      ║
 * ║                                                                   ║
 * ║  Key approach:                                                    ║
 * ║    1. Tokenize with Kuromoji (POS + base forms)                   ║
 * ║    2. Split into clauses at clause boundaries                     ║
 * ║    3. Within each clause, identify structural roles               ║
 * ║       (subject, object, verb, modifiers)                          ║
 * ║    4. Reorder from SOV → SVO and compose natural English          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ═══════════════════════════════════════════════════════════════════
// §1. Grammar Reference Maps
// ═══════════════════════════════════════════════════════════════════

/**
 * Particle → structural role mapping.
 * "role" determines where the preceding phrase lands in the English clause.
 */
const PARTICLE_ROLES = {
    "は": { role: "topic",    connector: "" },
    "が": { role: "subject",  connector: "" },
    "を": { role: "object",   connector: "" },
    "に": { role: "indirect", connector: "to" },
    "で": { role: "locative", connector: "at" },
    "と": { role: "comitative", connector: "with" },
    "も": { role: "topic",    connector: "also" },
    "の": { role: "genitive", connector: "'s" },
    "から": { role: "source",  connector: "from" },
    "まで": { role: "limit",   connector: "until" },
    "へ": { role: "direction", connector: "toward" },
    "より": { role: "comparison", connector: "more than" },
    "として": { role: "capacity", connector: "as" },
};

/**
 * Sentence-final particles → punctuation / tone.
 */
const SENTENCE_FINAL = {
    "か": "?",
    "よ": "!",
    "ね": ", right?",
    "な": "...",
    "ぞ": "!",
    "わ": ".",
    "さ": ".",
    "かな": "I wonder.",
    "っけ": " again?",
};

/**
 * Clause-boundary markers that split a sentence into sub-clauses.
 * Each maps to the English connector used to join the clauses.
 */
const CLAUSE_CONNECTORS = {
    "から":   "so",
    "ので":   "since",
    "けど":   "but",
    "けれど": "but",
    "けれども": "but",
    "のに":   "even though",
    "ながら": "while",
    "たら":   "if",
    "ば":     "if",
    "なら":   "if",
    "し":     "and",
    "て":     "and",
    "で":     "and",
    "ても":   "even if",
    "が":     "but",      // conjunction usage (detected contextually)
};

/**
 * Auxiliary verb/suffix chain composition.
 * When a verb is followed by auxiliaries, we compose them in English order.
 * 
 * The key is the surface form (or base form) of the auxiliary.
 * "wrap" is a function: (verbEnglish) => composed English phrase.
 * "position" controls stacking order: "pre" wraps before, "post" wraps after.
 */
const AUX_COMPOSERS = {
    // ── Tense ────────────────────────────────────────────────────
    "た":     { compose: (v) => `${v}`, tense: "past" },
    "だ":     { compose: (v) => `${v}`, tense: "past" },  // ta-form variant

    // ── Polite ───────────────────────────────────────────────────
    "ます":   { compose: (v) => v, polite: true },
    "ました": { compose: (v) => v, tense: "past", polite: true },
    "ません": { compose: (v) => `don't ${v}`, polite: true },

    // ── Negation ─────────────────────────────────────────────────
    "ない":   { compose: (v) => `don't ${v}`, negative: true },
    "ぬ":     { compose: (v) => `don't ${v}`, negative: true },
    "ん":     { compose: (v) => `don't ${v}`, negative: true },
    "なかった": { compose: (v) => `didn't ${v}`, negative: true, tense: "past" },
    "ませんでした": { compose: (v) => `didn't ${v}`, negative: true, tense: "past", polite: true },

    // ── Desire ───────────────────────────────────────────────────
    "たい":   { compose: (v) => `want to ${v}` },
    "たかった": { compose: (v) => `wanted to ${v}`, tense: "past" },
    "たくない": { compose: (v) => `don't want to ${v}`, negative: true },

    // ── Potential ────────────────────────────────────────────────
    "れる":   { compose: (v) => `can ${v}` },
    "られる": { compose: (v) => `can ${v}` },
    "える":   { compose: (v) => `can ${v}` },

    // ── Passive ──────────────────────────────────────────────────
    "れる_passive":  { compose: (v) => `is ${v}` },
    "られる_passive": { compose: (v) => `is ${v}` },

    // ── Causative ────────────────────────────────────────────────
    "せる":   { compose: (v) => `make ${v}` },
    "させる": { compose: (v) => `make ${v}` },

    // ── Causative-passive ────────────────────────────────────────
    "させられる": { compose: (v) => `is made to ${v}` },

    // ── Progressive ──────────────────────────────────────────────
    "ている": { compose: (v) => `is ${v}ing` },
    "てる":   { compose: (v) => `is ${v}ing` },
    "ていた": { compose: (v) => `was ${v}ing`, tense: "past" },
    "てた":   { compose: (v) => `was ${v}ing`, tense: "past" },

    // ── Attempt / Completion ─────────────────────────────────────
    "てみる": { compose: (v) => `try to ${v}` },
    "てしまう": { compose: (v) => `end up ${v}ing` },
    "ちゃう":  { compose: (v) => `end up ${v}ing` },
    "ちゃった": { compose: (v) => `ended up ${v}ing`, tense: "past" },

    // ── Giving/receiving ─────────────────────────────────────────
    "てくれる": { compose: (v) => `${v} (for me)` },
    "てもらう": { compose: (v) => `get someone to ${v}` },
    "てあげる": { compose: (v) => `${v} (for someone)` },

    // ── Appearance / Hearsay ─────────────────────────────────────
    "そう":   { compose: (v) => `seems like ${v}` },
    "らしい": { compose: (v) => `apparently ${v}` },
    "ようだ": { compose: (v) => `seems to ${v}` },
    "みたい": { compose: (v) => `looks like ${v}` },

    // ── Obligation / Advice ──────────────────────────────────────
    "なきゃ":  { compose: (v) => `must ${v}` },
    "なければ": { compose: (v) => `must ${v}` },
    "なくちゃ": { compose: (v) => `have to ${v}` },
    "べき":    { compose: (v) => `should ${v}` },

    // ── Volitional ───────────────────────────────────────────────
    "よう":   { compose: (v) => `let's ${v}` },
    "おう":   { compose: (v) => `let's ${v}` },
    "ましょう": { compose: (v) => `let's ${v}`, polite: true },

    // ── Imperative ───────────────────────────────────────────────
    "なさい": { compose: (v) => `${v}!`, polite: true },
    "ろ":     { compose: (v) => `${v}!` },

    // ── Copula (sentence-final) ──────────────────────────────────
    "です":   { copula: true, polite: true },
    "だ_copula": { copula: true },
};

/**
 * Common adverbs that should be placed before the verb in English.
 */
const ADVERB_GLOSSES = {
    "とても": "very",
    "すごく": "really",
    "ちょっと": "a little",
    "もう": "already",
    "まだ": "still",
    "もっと": "more",
    "たくさん": "a lot",
    "いつも": "always",
    "よく": "often",
    "あまり": "not much",
    "全然": "not at all",
    "絶対": "definitely",
    "多分": "maybe",
    "きっと": "surely",
    "やっぱり": "as expected",
    "ぜんぜん": "not at all",
    "だんだん": "gradually",
    "すぐ": "soon",
    "ずっと": "the whole time",
    "初めて": "for the first time",
    "本当に": "really",
    "一緒に": "together",
    "一人で": "alone",
};

/**
 * Common pronouns for subject insertion when topic is omitted.
 */
const PRONOUN_MAP = {
    "私": "I", "わたし": "I", "あたし": "I", "僕": "I", "ぼく": "I",
    "俺": "I", "おれ": "I", "うち": "I",
    "あなた": "you", "君": "you", "きみ": "you", "お前": "you", "おまえ": "you",
    "彼": "he", "かれ": "he",
    "彼女": "she", "かのじょ": "she",
    "私たち": "we", "僕たち": "we", "俺たち": "we",
    "彼ら": "they", "あの人": "that person",
    "これ": "this", "それ": "that", "あれ": "that (over there)",
    "ここ": "here", "そこ": "there", "あそこ": "over there",
    "誰": "who", "何": "what", "なに": "what", "どこ": "where",
    "いつ": "when", "なぜ": "why", "どう": "how", "どうして": "why",
    "皆": "everyone", "みんな": "everyone",
    "自分": "oneself",
};

/**
 * Existence / copula verbs that get special handling.
 */
const SPECIAL_VERBS = {
    "ある": "there is",
    "いる": "is",
    "なる": "become",
    "する": "do",
    "できる": "can do",
    "思う": "think",
    "言う": "say",
    "知る": "know",
    "分かる": "understand",
    "見える": "can see",
    "聞こえる": "can hear",
    "欲しい": "want",
    "好き": "like",
    "嫌い": "dislike",
    "必要": "need",
    "大丈夫": "okay",
    "上手": "good at",
    "下手": "bad at",
    "得意": "good at",
    "苦手": "not good at",
};


// ═══════════════════════════════════════════════════════════════════
// §2. Helper Functions
// ═══════════════════════════════════════════════════════════════════

/**
 * Gets a clean, short English definition for a base word from JMDict.
 * Returns the shortest, most common meaning.
 */
function getJmdictGloss(baseForm, dict) {
    if (!dict) return null;
    const entries = dict[baseForm];
    if (!entries || entries.length === 0) return null;
    
    const entry = entries[0];
    if (!entry.s || entry.s.length === 0) return null;
    
    // Grab the first sense — JMDict orders glosses by commonality,
    // so the first gloss is usually the most natural translation.
    const glosses = entry.s[0].g || [];
    if (glosses.length === 0) return null;
    
    // Strip parenthetical noise from the first gloss
    const firstGloss = glosses[0].replace(/\s*\(.*?\)\s*/g, "").trim();
    if (!firstGloss) {
        // If first gloss was only parenthetical, try the second
        for (let gi = 1; gi < glosses.length; gi++) {
            const g = glosses[gi].replace(/\s*\(.*?\)\s*/g, "").trim();
            if (g) return g.toLowerCase();
        }
        return null;
    }
    return firstGloss.toLowerCase();
}

/**
 * Gets the part-of-speech category from a JMDict entry.
 */
function getJmdictPos(baseForm, dict) {
    if (!dict) return null;
    const entries = dict[baseForm];
    if (!entries || entries.length === 0) return null;
    const entry = entries[0];
    if (!entry.s || entry.s.length === 0) return null;
    const pos = entry.s[0].pos || [];
    return pos.length > 0 ? pos[0] : null;
}

/**
 * Checks if a token is a "content word" (noun, verb, adjective, adverb)
 * vs. a function word (particle, auxiliary, symbol).
 */
function isContentWord(token) {
    const contentPOS = ["名詞", "動詞", "形容詞", "形容動詞", "副詞", "連体詞", "接続詞", "感動詞"];
    return contentPOS.includes(token.pos);
}

/**
 * Applies tense transformation to a verb gloss.
 */
function applyTense(verbGloss, tense, isNegative) {
    if (!verbGloss) return verbGloss;
    
    if (tense === "past") {
        if (isNegative) {
            // "don't eat" → "didn't eat"
            if (verbGloss.startsWith("don't ")) {
                return "didn't " + verbGloss.slice(6);
            }
            return verbGloss;
        }
        // Simple past: add -ed heuristic or just note it
        // For common verbs we have a small irregular map
        return verbGloss;
    }
    return verbGloss;
}

/**
 * Very simple English past tense for common verbs.
 * Falls back to "verb + ed" for unknowns.
 */
const IRREGULAR_PAST = {
    "eat": "ate", "see": "saw", "go": "went", "come": "came", "do": "did",
    "say": "said", "make": "made", "take": "took", "give": "gave", "get": "got",
    "know": "knew", "think": "thought", "find": "found", "tell": "told",
    "become": "became", "leave": "left", "feel": "felt", "put": "put",
    "bring": "brought", "begin": "began", "keep": "kept", "hold": "held",
    "write": "wrote", "stand": "stood", "hear": "heard", "run": "ran",
    "meet": "met", "read": "read", "buy": "bought", "die": "died",
    "send": "sent", "build": "built", "fall": "fell", "cut": "cut",
    "speak": "spoke", "lose": "lost", "sit": "sat", "catch": "caught",
    "break": "broke", "teach": "taught", "sing": "sang", "drink": "drank",
    "draw": "drew", "understand": "understood", "sleep": "slept",
    "choose": "chose", "wear": "wore", "win": "won", "grow": "grew",
    "throw": "threw", "fly": "flew", "ride": "rode", "drive": "drove",
    "swim": "swam", "forget": "forgot", "sell": "sold", "pay": "paid",
    "hit": "hit", "let": "let", "fight": "fought", "like": "liked",
    "live": "lived", "love": "loved", "want": "wanted", "need": "needed",
    "try": "tried", "use": "used", "play": "played", "call": "called",
    "ask": "asked", "work": "worked", "walk": "walked", "look": "looked",
    "open": "opened", "close": "closed", "stop": "stopped", "start": "started",
    "move": "moved", "turn": "turned", "help": "helped", "talk": "talked",
    "watch": "watched", "wait": "waited", "change": "changed",
    "is": "was", "are": "were", "can": "could",
    "there is": "there was", "exist": "existed",
};

function makePastTense(verb) {
    if (!verb) return verb;
    const lower = verb.toLowerCase();
    if (IRREGULAR_PAST[lower]) return IRREGULAR_PAST[lower];
    // Simple heuristic for regular verbs
    if (lower.endsWith("e")) return lower + "d";
    if (lower.endsWith("y") && !/[aeiou]y$/.test(lower)) return lower.slice(0, -1) + "ied";
    if (/[^aeiou][aeiou][bcdfghlmnprst]$/.test(lower)) return lower + lower.slice(-1) + "ed";
    return lower + "ed";
}


// ═══════════════════════════════════════════════════════════════════
// §3. Clause Builder — Structural Role Accumulator
// ═══════════════════════════════════════════════════════════════════

/**
 * Represents a single clause within a Japanese sentence.
 * Accumulates tokens into structural roles and renders English output.
 */
class ClauseBuilder {
    constructor(dict) {
        this.dict = dict;
        
        // Structural slots
        this.topic = null;        // は-marked phrase
        this.subject = null;      // が-marked phrase
        this.object = null;       // を-marked phrase
        this.indirect = null;     // に-marked phrase
        this.locative = null;     // で-marked phrase
        this.comitative = null;   // と-marked phrase
        this.source = null;       // から-marked phrase
        this.limit = null;        // まで-marked phrase
        this.direction = null;    // へ-marked phrase
        this.comparison = null;   // より-marked phrase
        
        this.verb = null;         // Main verb (base gloss)
        this.verbBase = null;     // Original base form
        this.verbSurface = null;  // Original surface form
        this.auxiliaries = [];    // Aux chain collected after verb
        this.adverbs = [];        // Adverbs collected
        this.adjectives = [];     // Pre-nominal adjectives
        this.modifiers = [];      // Other modifiers (genitive chains, etc.)
        this.isCopula = false;    // Is this a copula sentence (X は Y だ/です)
        this.predicate = null;    // Predicate noun/adj for copula
        this.sentenceFinal = "";  // Sentence-final particle punctuation
        this.extraWords = [];     // Words that don't fit a clear role
        this.isQuestion = false;
        this.tense = "present";
        this.isNegative = false;
        this.isPolite = false;
        
        // Accumulator: tokens before the next particle
        this._phraseBuffer = [];
    }
    
    /**
     * Flushes the phrase buffer into a string gloss.
     */
    _flushPhrase() {
        if (this._phraseBuffer.length === 0) return null;
        
        const parts = [];
        for (const token of this._phraseBuffer) {
            const gloss = this._glossToken(token);
            if (gloss) parts.push(gloss);
        }
        this._phraseBuffer = [];
        return parts.length > 0 ? parts.join(" ") : null;
    }
    
    /**
     * Gets the English gloss for a single content token.
     */
    _glossToken(token) {
        const base = token.baseForm || token.text;
        const surface = token.text;
        
        // Check pronoun map
        if (PRONOUN_MAP[base]) return PRONOUN_MAP[base];
        if (PRONOUN_MAP[surface]) return PRONOUN_MAP[surface];
        
        // Check adverb glosses
        if (ADVERB_GLOSSES[base]) return ADVERB_GLOSSES[base];
        if (ADVERB_GLOSSES[surface]) return ADVERB_GLOSSES[surface];
        
        // Check special verbs
        if (SPECIAL_VERBS[base]) return SPECIAL_VERBS[base];
        if (SPECIAL_VERBS[surface]) return SPECIAL_VERBS[surface];
        
        // JMDict lookup
        let gloss = getJmdictGloss(base, this.dict);
        if (!gloss && surface !== base) {
            gloss = getJmdictGloss(surface, this.dict);
        }
        
        if (gloss) return gloss;
        
        // Fallback: return the original Japanese
        return surface;
    }
    
    /**
     * Assigns the phrase buffer contents to a structural role based on particle.
     */
    _assignRole(particleText) {
        const phrase = this._flushPhrase();
        if (!phrase) return;
        
        const roleInfo = PARTICLE_ROLES[particleText];
        if (!roleInfo) {
            this.extraWords.push(phrase);
            return;
        }
        
        switch (roleInfo.role) {
            case "topic":
                if (particleText === "も") {
                    // "also" — treat as subject with "also" marker
                    this.topic = phrase + " also";
                } else {
                    this.topic = phrase;
                }
                break;
            case "subject":
                // が before emotional/stative adjectives (好き、嫌い、欲しい、上手、etc.)
                // marks the OBJECT of the emotion, not the grammatical subject.
                // e.g., 猫が好き = "like cats" (cats = object of liking)
                this._gaPhrase = phrase;
                this.subject = phrase;
                break;
            case "object":
                this.object = phrase;
                break;
            case "indirect":
                this.indirect = { phrase, preposition: roleInfo.connector };
                break;
            case "locative":
                this.locative = { phrase, preposition: roleInfo.connector };
                break;
            case "comitative":
                this.comitative = { phrase, preposition: roleInfo.connector };
                break;
            case "source":
                this.source = { phrase, preposition: roleInfo.connector };
                break;
            case "limit":
                this.limit = { phrase, preposition: roleInfo.connector };
                break;
            case "direction":
                this.direction = { phrase, preposition: roleInfo.connector };
                break;
            case "comparison":
                this.comparison = { phrase, preposition: roleInfo.connector };
                break;
            case "genitive":
                // Genitive chains: push to modifier
                this.modifiers.push(phrase + "'s");
                break;
            default:
                this.extraWords.push(phrase);
        }
    }
    
    /**
     * Processes a single Kuromoji token and routes it to the correct slot.
     */
    addToken(token) {
        const surface = token.text;
        const base = token.baseForm || surface;
        const pos = token.pos;
        const posDetail = token.posDetail || "";
        
        // ── Punctuation / Symbols ────────────────────────────────
        if (pos === "記号") {
            return; // Skip punctuation during structural analysis
        }
        
        // ── Sentence-final particles ─────────────────────────────
        if (pos === "助詞" && SENTENCE_FINAL[surface]) {
            // Flush any remaining phrase buffer first
            const remaining = this._flushPhrase();
            if (remaining) this.extraWords.push(remaining);
            
            this.sentenceFinal = SENTENCE_FINAL[surface];
            if (surface === "か") this.isQuestion = true;
            return;
        }
        
        // ── Particles (structural) ───────────────────────────────
        if (pos === "助詞") {
            // Check if this is a clause-boundary particle
            // (handled at a higher level, but の is genitive here)
            if (surface === "の" && posDetail === "連体化") {
                // Genitive: flush buffer as modifier
                const phrase = this._flushPhrase();
                if (phrase) this.modifiers.push(phrase + "'s");
                return;
            }
            
            this._assignRole(surface);
            return;
        }
        
        // ── Auxiliary verbs / suffixes ────────────────────────────
        if (pos === "助動詞") {
            // If we already have a verb, this is part of the aux chain
            if (this.verb !== null) {
                this._processAuxiliary(surface, base);
                return;
            }
            
            // Copula at sentence start or after noun (だ/です without verb)
            if (surface === "です" || surface === "だ" || base === "だ" || base === "です") {
                this.isCopula = true;
                // The predicate is whatever was in the buffer
                const pred = this._flushPhrase();
                if (pred) this.predicate = pred;
                // Check tense from surface form
                if (surface === "でした" || surface === "だった") {
                    this.tense = "past";
                }
                return;
            }
            
            // Negative auxiliary before verb found — treat as modifier
            if (surface === "ない" || surface === "ん") {
                this.isNegative = true;
                return;
            }
            
            // Past tense marker without a verb (e.g., adj + だった)
            if (surface === "た" || base === "た") {
                this.tense = "past";
                return;
            }
            
            // Other auxiliaries without a verb — buffer them
            this._phraseBuffer.push(token);
            return;
        }
        
        // ── Verbs ────────────────────────────────────────────────
        if (pos === "動詞") {
            // Flush any buffered tokens as extra context before the verb
            const remaining = this._flushPhrase();
            if (remaining) {
                // If we don't have a subject or object yet, it might be one
                if (!this.object && !this.topic && !this.subject) {
                    this.extraWords.push(remaining);
                } else {
                    this.extraWords.push(remaining);
                }
            }
            
            // Get the English gloss for this verb
            let verbGloss = null;
            if (SPECIAL_VERBS[base]) {
                verbGloss = SPECIAL_VERBS[base];
            } else {
                verbGloss = getJmdictGloss(base, this.dict);
                if (!verbGloss && surface !== base) {
                    verbGloss = getJmdictGloss(surface, this.dict);
                }
            }
            
            this.verb = verbGloss || base;
            this.verbBase = base;
            this.verbSurface = surface;
            return;
        }
        
        // ── Adjectives ───────────────────────────────────────────
        if (pos === "形容詞" || pos === "形容動詞") {
            let adjGloss = getJmdictGloss(base, this.dict) || getJmdictGloss(surface, this.dict) || surface;
            
            // If no verb yet and this might be the predicate
            // (e.g., "楽しい" at end of clause)
            this._phraseBuffer.push({
                text: surface,
                baseForm: base,
                pos: pos,
                reading: token.reading || "",
                _gloss: adjGloss,
                isWord: true
            });
            return;
        }
        
        // ── Adverbs ──────────────────────────────────────────────
        if (pos === "副詞") {
            const advGloss = ADVERB_GLOSSES[base] || ADVERB_GLOSSES[surface] || 
                            getJmdictGloss(base, this.dict) || surface;
            this.adverbs.push(advGloss);
            return;
        }
        
        // ── Conjunctions ─────────────────────────────────────────
        if (pos === "接続詞") {
            const conjGloss = getJmdictGloss(base, this.dict) || surface;
            this.extraWords.push(conjGloss);
            return;
        }
        
        // ── Interjections ────────────────────────────────────────
        if (pos === "感動詞") {
            const intGloss = getJmdictGloss(base, this.dict) || surface;
            this.extraWords.push(intGloss);
            return;
        }
        
        // ── Everything else (nouns, pre-nominal adj, etc.) ───────
        this._phraseBuffer.push(token);
    }
    
    /**
     * Processes an auxiliary verb/suffix and integrates it into the verb chain.
     */
    _processAuxiliary(surface, base) {
        // Check compound auxiliaries first (longer matches)
        const compounds = ["させられる", "ませんでした", "なかった", "たくない", "たかった",
                          "てしまう", "てくれる", "てもらう", "てあげる", "ている",
                          "ていた", "ちゃった", "ましょう", "なきゃ", "なくちゃ",
                          "なければ", "なさい"];
        
        // Build the current aux chain text to check compounds
        const currentAuxText = this.auxiliaries.map(a => a.surface).join("") + surface;
        
        for (const compound of compounds) {
            if (currentAuxText.endsWith(compound) && AUX_COMPOSERS[compound]) {
                // Remove individual auxiliaries that form this compound
                const compStart = currentAuxText.length - compound.length;
                let consumed = 0;
                const newAux = [];
                for (const a of this.auxiliaries) {
                    consumed += a.surface.length;
                    if (consumed <= compStart) {
                        newAux.push(a);
                    }
                }
                this.auxiliaries = newAux;
                
                const info = AUX_COMPOSERS[compound];
                this.auxiliaries.push({ surface: compound, info });
                if (info.tense) this.tense = info.tense;
                if (info.negative) this.isNegative = true;
                if (info.polite) this.isPolite = true;
                return;
            }
        }
        
        // Simple auxiliary lookup
        if (AUX_COMPOSERS[surface]) {
            const info = AUX_COMPOSERS[surface];
            this.auxiliaries.push({ surface, info });
            if (info.tense) this.tense = info.tense;
            if (info.negative) this.isNegative = true;
            if (info.polite) this.isPolite = true;
            return;
        }
        
        if (AUX_COMPOSERS[base]) {
            const info = AUX_COMPOSERS[base];
            this.auxiliaries.push({ surface, info });
            if (info.tense) this.tense = info.tense;
            if (info.negative) this.isNegative = true;
            if (info.polite) this.isPolite = true;
            return;
        }
        
        // Copula check
        if (surface === "です" || surface === "だ" || base === "です" || base === "だ") {
            this.isCopula = true;
            if (surface === "でした" || surface === "だった") {
                this.tense = "past";
            }
            return;
        }
        
        // Past tense marker
        if (surface === "た" || base === "た") {
            this.tense = "past";
            this.auxiliaries.push({ surface, info: { tense: "past" } });
            return;
        }
        
        // Unknown auxiliary — skip silently
    }
    
    /**
     * Composes the verb phrase by applying auxiliary chain in order.
     */
    _composeVerbPhrase() {
        if (!this.verb) return null;
        
        let verbGloss = this.verb;
        let hasTenseFromAux = false;
        let hasNegativeFromAux = false;
        
        // Apply auxiliaries in order (innermost first)
        for (const aux of this.auxiliaries) {
            if (!aux.info) continue;
            
            if (aux.info.copula) {
                this.isCopula = true;
                continue;
            }
            
            if (aux.info.compose) {
                verbGloss = aux.info.compose(verbGloss);
                if (aux.info.tense) hasTenseFromAux = true;
                if (aux.info.negative) hasNegativeFromAux = true;
            }
        }
        
        // Apply past tense if flagged and not already handled by aux
        if (this.tense === "past" && !hasTenseFromAux && !hasNegativeFromAux) {
            verbGloss = makePastTense(verbGloss);
        }
        
        return verbGloss;
    }
    
    /**
     * Renders this clause as an English string in SVO order.
     */
    render() {
        const parts = [];
        
        // Flush any remaining buffer
        const remaining = this._flushPhrase();
        if (remaining) {
            // If we have no verb and no predicate, this might be the predicate itself
            if (!this.verb && !this.predicate) {
                this.predicate = remaining;
                // If no copula was explicitly found but we have topic + predicate, imply copula
                if (this.topic || this.subject) {
                    this.isCopula = true;
                }
            } else {
                this.extraWords.push(remaining);
            }
        }
        
        // ── Interjections / conjunctions at start ────────────────
        // (These are in extraWords from addToken)
        
        // ── Subject (SVO position 1) ─────────────────────────────
        const subj = this.topic || this.subject;
        if (subj) {
            parts.push(subj);
        }
        
        // ── Check for が + emotional adjective pattern ─────────────
        // e.g., 猫が好き → "like cats" not "cat is like"
        const EMOTION_ADJECTIVES = ["like", "dislike", "want", "good at", "bad at", "not good at",
                                     "fond of", "hate", "need", "scary", "frightening"];
        if (this._gaPhrase && this.predicate && !this.verb) {
            const predLower = (this.predicate || "").toLowerCase();
            if (EMOTION_ADJECTIVES.some(ea => predLower.includes(ea))) {
                // Rewrite: "(topic) like(s) (ga-phrase)"
                // If topic exists, use it as subject; otherwise omit subject
                parts.length = 0; // Clear any previous pushes
                if (this.topic) {
                    parts.push(this.topic);
                }
                let emotionVerb = this.predicate;
                if (this.tense === "past") emotionVerb = makePastTense(emotionVerb);
                if (this.isNegative) emotionVerb = "don't " + emotionVerb;
                parts.push(emotionVerb);
                parts.push(this._gaPhrase);
                this._addPrepPhrases(parts);
                if (this.extraWords.length > 0) parts.push(...this.extraWords);
                return this._finalize(parts);
            }
        }

        // ── Copula pattern: "Subject is Predicate" ───────────────
        if (this.isCopula && !this.verb) {
            let copulaVerb = this.tense === "past" ? "was" : "is";
            if (this.isNegative) {
                copulaVerb = this.tense === "past" ? "wasn't" : "isn't";
            }
            
            // Adverbs before copula
            if (this.adverbs.length > 0) {
                parts.push(copulaVerb);
                parts.push(this.adverbs.join(" "));
            } else {
                parts.push(copulaVerb);
            }
            
            if (this.predicate) {
                // Insert "a/an" before bare noun predicates, but NOT adjectives
                let pred = this.predicate;
                const ADJ_INDICATORS = ["ful", "ous", "ive", "ant", "ent", "ble", "ish", "ary",
                    "ical", "less", "like", "good", "bad", "big", "small", "old", "new",
                    "difficult", "interesting", "beautiful", "important", "different",
                    "possible", "available", "necessary", "happy", "sad", "angry",
                    "cold", "hot", "warm", "cool", "nice", "pretty", "cute",
                    "fast", "slow", "easy", "hard", "funny", "quiet", "loud",
                    "delicious", "busy", "free", "expensive", "cheap"];
                const isAdj = ADJ_INDICATORS.some(suffix => pred.toLowerCase().endsWith(suffix)
                    || pred.toLowerCase() === suffix);
                if (pred && !pred.includes(" ") && /^[a-z]/.test(pred) && !isAdj) {
                    const article = /^[aeiou]/i.test(pred) ? "an" : "a";
                    pred = `${article} ${pred}`;
                }
                parts.push(pred);
            }
            
            // Prepositional phrases
            this._addPrepPhrases(parts);
            
            // Extra words
            if (this.extraWords.length > 0) parts.push(...this.extraWords);
            
            return this._finalize(parts);
        }
        
        // ── Verb phrase (SVO position 2) ─────────────────────────
        if (this.verb) {
            // Adverbs before the verb
            if (this.adverbs.length > 0) {
                parts.push(this.adverbs.join(" "));
            }
            
            let verbPhrase = this._composeVerbPhrase();
            
            // If no aux handled tense, and tense is past, apply it
            if (this.tense === "past" && verbPhrase === this.verb) {
                verbPhrase = makePastTense(verbPhrase);
            }
            
            parts.push(verbPhrase);
            
            // ── Object (SVO position 3) ──────────────────────────
            if (this.object) {
                parts.push(this.object);
            }
        } else if (!this.isCopula) {
            // No verb or copula — might be a fragment
            if (this.adverbs.length > 0) parts.push(this.adverbs.join(" "));
            if (this.predicate) parts.push(this.predicate);
            if (this.object) parts.push(this.object);
        }
        
        // ── Prepositional phrases ────────────────────────────────
        this._addPrepPhrases(parts);
        
        // ── Extra / unassigned words ─────────────────────────────
        if (this.extraWords.length > 0) {
            parts.push(...this.extraWords);
        }
        
        return this._finalize(parts);
    }
    
    /**
     * Adds prepositional phrases (indirect, locative, etc.) to the parts array.
     */
    _addPrepPhrases(parts) {
        if (this.indirect) {
            parts.push(`${this.indirect.preposition} ${this.indirect.phrase}`);
        }
        if (this.locative) {
            parts.push(`${this.locative.preposition} ${this.locative.phrase}`);
        }
        if (this.comitative) {
            parts.push(`${this.comitative.preposition} ${this.comitative.phrase}`);
        }
        if (this.source) {
            parts.push(`${this.source.preposition} ${this.source.phrase}`);
        }
        if (this.limit) {
            parts.push(`${this.limit.preposition} ${this.limit.phrase}`);
        }
        if (this.direction) {
            parts.push(`${this.direction.preposition} ${this.direction.phrase}`);
        }
        if (this.comparison) {
            parts.push(`${this.comparison.preposition} ${this.comparison.phrase}`);
        }
    }
    
    /**
     * Final formatting: capitalize, add punctuation, clean spacing.
     */
    _finalize(parts) {
        let result = parts.filter(p => p && p.trim()).join(" ");
        
        // Clean up double spaces, bad spacing
        result = result.replace(/\s+/g, " ").trim();
        
        // Add sentence-final punctuation
        if (this.isQuestion && !result.endsWith("?")) {
            result += "?";
        } else if (this.sentenceFinal) {
            // Remove existing trailing punctuation before adding new
            result = result.replace(/[.!?]+$/, "");
            result += this.sentenceFinal;
        }
        
        return result;
    }
}


// ═══════════════════════════════════════════════════════════════════
// §4. Clause Splitter
// ═══════════════════════════════════════════════════════════════════

/**
 * Splits a token array into clause segments at clause boundaries.
 * Returns array of { tokens: [...], connector: "but"|"so"|etc. }
 */
function splitIntoClauses(tokens) {
    const clauses = [];
    let currentTokens = [];
    
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const surface = token.text;
        const pos = token.pos;
        const posDetail = token.posDetail || "";
        
        // Check for clause-boundary particles
        // But be careful: が can be subject marker OR conjunction
        // から can be "from" or "because"
        
        let isClauseBoundary = false;
        let connector = "";
        
        if (pos === "助詞" || pos === "助動詞") {
            // Check if this is a conjunction-type particle
            if (posDetail === "接続助詞" && CLAUSE_CONNECTORS[surface]) {
                isClauseBoundary = true;
                connector = CLAUSE_CONNECTORS[surface];
            }
            
            // が as conjunction (after verb/adj, not after noun)
            if (surface === "が" && posDetail === "接続助詞") {
                isClauseBoundary = true;
                connector = "but";
            }
            
            // て/で form as clause connector (after verb)
            if ((surface === "て" || surface === "で") && posDetail === "接続助詞") {
                isClauseBoundary = true;
                connector = "and";
            }
            
            // けど, けれど etc.
            if (surface === "けど" || surface === "けれど" || surface === "けれども") {
                isClauseBoundary = true;
                connector = "but";
            }
            
            // から as "because" (接続助詞), not "from" (格助詞)
            if (surface === "から" && posDetail === "接続助詞") {
                isClauseBoundary = true;
                connector = "so";
            }
        }
        
        if (isClauseBoundary && currentTokens.length > 0) {
            clauses.push({ tokens: currentTokens, connector: connector });
            currentTokens = [];
        } else {
            currentTokens.push(token);
        }
    }
    
    // Last clause (no trailing connector)
    if (currentTokens.length > 0) {
        clauses.push({ tokens: currentTokens, connector: "" });
    }
    
    return clauses;
}


// ═══════════════════════════════════════════════════════════════════
// §5. Core Translation API
// ═══════════════════════════════════════════════════════════════════

/**
 * Translates a Japanese sentence into English using clause-structure-aware
 * offline translation.
 *
 * @param {string} sentence - The Japanese sentence
 * @returns {Promise<string>} An English translation string
 */
async function translateSentenceOffline(sentence) {
    if (!sentence || !sentence.trim()) return "";

    try {
        // 1. Load dictionary
        const dict = typeof getLoadedDictionary === "function" ? getLoadedDictionary() : null;
        
        // 2. Morphological analysis with Kuromoji
        let tokens = [];
        try {
            tokens = await analyzeJapaneseText(sentence);
        } catch (err) {
            console.warn("J-SUB OFFLINE TRANS: Kuromoji analysis failed, using fallback:", err);
        }

        if (!tokens || tokens.length === 0) {
            // Fallback: basic regex tokenizer
            if (typeof tokenizeJapanese === "function") {
                try {
                    const regexTokens = tokenizeJapanese(sentence);
                    tokens = regexTokens.map(t => ({
                        text: t.text,
                        baseForm: t.text,
                        pos: t.clickable ? "名詞" : "記号",
                        posDetail: "",
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

        // 3. Split into clauses
        const clauseSegments = splitIntoClauses(tokens);
        
        // 4. Build and render each clause
        const clauseTranslations = [];
        
        for (let ci = 0; ci < clauseSegments.length; ci++) {
            const segment = clauseSegments[ci];
            const builder = new ClauseBuilder(dict);
            
            for (const token of segment.tokens) {
                builder.addToken(token);
            }
            
            let clauseText = builder.render();
            
            if (clauseText && clauseText.trim()) {
                clauseTranslations.push({
                    text: clauseText,
                    connector: segment.connector
                });
            }
        }
        
        if (clauseTranslations.length === 0) {
            return "Unable to translate.";
        }
        
        // 5. Join clauses with connectors
        let result = "";
        for (let i = 0; i < clauseTranslations.length; i++) {
            const clause = clauseTranslations[i];
            
            if (i === 0) {
                result = clause.text;
            } else {
                // The connector belongs to the PREVIOUS clause
                // (it was at the boundary between prev and this)
                const prevConnector = clauseTranslations[i - 1].connector;
                if (prevConnector) {
                    result += `, ${prevConnector} ${clause.text.charAt(0).toLowerCase() + clause.text.slice(1)}`;
                } else {
                    result += ` ${clause.text}`;
                }
            }
        }
        
        // 6. Final cleanup and capitalization
        result = result
            .replace(/\s+/g, " ")
            .replace(/\s+([.,!?])/g, "$1")
            .replace(/\(\s+/g, "(")
            .replace(/\s+\)/g, ")")
            .trim();
        
        // Capitalize first letter
        if (result.length > 0) {
            result = result.charAt(0).toUpperCase() + result.slice(1);
        }
        
        // Ensure sentence ends with punctuation
        if (result.length > 0 && !/[.!?]$/.test(result)) {
            result += ".";
        }

        return result;
    } catch (e) {
        console.error("J-SUB OFFLINE TRANS: Translation failed:", e);
        return "Translation error (offline)";
    }
}
