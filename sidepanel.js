/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  J-Sub Explainer Engine — Side Panel Controller v4               ║
 * ║                                                                  ║
 * ║  §1.  State & Configuration                                    ║
 * ║  §2.  Initialization & Event Listeners                          ║
 * ║  §3.  Tab Navigation                                            ║
 * ║  §4.  Japanese Text Tokenization                                ║
 * ║  §5.  Subtitle Rendering                                        ║
 * ║  §6.  Batch Translation Engine (DeepL + Gemini)                 ║
 * ║  §7.  Fuzzy Subtitle Highlighting (Dice Coefficient)            ║
 * ║  §8.  Interactive Word Dictionary (Offline + Gemini Tooltips)   ║
 * ║  §9.  Vocabulary Panel                                          ║
 * ║  §10. Flashcard Reader                                          ║
 * ║  §11. Utility Functions                                         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ═══════════════════════════════════════════════════════════════════
// §1. State & Configuration
// ═══════════════════════════════════════════════════════════════════

/** Translation progress tracking */
let totalSubs = 0;
let processedSubs = 0;
let isProcessingQueue = false;

/** Full subtitle array (used for context in dictionary lookups) */
let currentSubtitles = [];

/** Highlighting state — tracks the last highlighted index to prevent jitter */
let lastHighlightedIndex = -1;
let scrollDebounceTimer = null;

/** Tooltip state */
let activeTooltip = null;
let currentTooltipWordData = null; // Holds dict data for save button
let currentTooltipForWord = null;  // Tracks which word the tooltip is for
let _lookupInProgress = false;     // Prevents double-trigger on rapid clicks

/** Current active tab */
let activeTab = "subtitles";

/** Flashcard reader state */
let readerCards = [];
let readerIndex = 0;
let readerFlipped = false;

// ═══════════════════════════════════════════════════════════════════
// §2. Initialization & Event Listeners
// ═══════════════════════════════════════════════════════════════════

// ── Load cached subtitles ────────────────────
chrome.storage.local.get(["cachedSubtitles"], (result) => {
    if (result.cachedSubtitles?.length > 0) {
        renderSubtitles(result.cachedSubtitles);
    }
});

// ── Listen for live updates from the content script (via background relay) ──
try {
    chrome.runtime.onMessage.addListener((msg) => {
        try {
            if (msg.action === "PRELOAD_SUBTITLES") {
                renderSubtitles(msg.subtitles);
            } else if (msg.action === "ACTIVE_SUBTITLE") {
                highlightActiveSubtitle(msg.text);
            }
        } catch (e) {
            // Context invalidated mid-callback — safe to ignore
        }
    });
} catch (e) {
    console.warn("J-SUB: Failed to register message listener (context invalidated).");
}

// ── Toggle Settings Panel Visibility ─────────────────────────────
document.getElementById("settings-toggle").addEventListener("click", () => {
    const panel = document.getElementById("settings-panel");
    const toggle = document.getElementById("settings-toggle");
    const isCollapsed = panel.classList.toggle("collapsed");
    toggle.textContent = isCollapsed ? "⚙ Status" : "⚙ Hide";
});

// ── Preload the dictionary and Kuromoji tokenizer in background ──
updateProgress("Loading offline resources...", 5);
Promise.all([
    loadDictionary(),
    loadKuromoji()
]).then(() => {
    console.log("J-SUB: Offline dictionary & Kuromoji tokenizer preloaded");
    updateProgress("Offline resources loaded ✓", 100);
    setTimeout(() => {
        if (currentSubtitles.length === 0) {
            updateProgress("Waiting for subtitles…", 0);
        }
    }, 2000);
}).catch((err) => {
    console.error("J-SUB: Failed to preload offline resources:", err);
    const errText = err && (err.message || err.statusText || String(err));
    updateProgress(`⚠ Error loading resources: ${errText}`, 0);
});

// ── Initialize tab system ────────────────────────────────────────
initTabs();
updateVocabBadge();

// ═══════════════════════════════════════════════════════════════════
// §3. Tab Navigation
// ═══════════════════════════════════════════════════════════════════

function initTabs() {
    const tabButtons = document.querySelectorAll(".tab-btn");
    const indicator = document.getElementById("tab-indicator");

    // Set initial indicator position
    requestAnimationFrame(() => {
        updateIndicator(tabButtons[0]);
    });

    tabButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
            const tabName = btn.dataset.tab;
            switchTab(tabName);
        });
    });
}

function switchTab(tabName) {
    activeTab = tabName;

    // Update tab buttons
    document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tabName);
        if (btn.dataset.tab === tabName) {
            updateIndicator(btn);
        }
    });

    // Update panels
    document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.id === `panel-${tabName}`);
    });

    // Refresh panel content when switching to it
    if (tabName === "vocabulary") {
        renderVocabList();
    } else if (tabName === "reader") {
        initReader();
    }
}

function updateIndicator(btn) {
    const indicator = document.getElementById("tab-indicator");
    indicator.style.width = `${btn.offsetWidth}px`;
    indicator.style.left = `${btn.offsetLeft}px`;
}

// ═══════════════════════════════════════════════════════════════════
// §4. Japanese Text Tokenization
// ═══════════════════════════════════════════════════════════════════

/**
 * Splits Japanese text into meaningful tokens for interactive display.
 *
 * Token types:
 *   - Kanji + okurigana (e.g. 食べる, 走った) → clickable
 *   - Katakana sequences (e.g. コンピュータ) → clickable
 *   - Multi-char hiragana (e.g. ありがとう)  → clickable
 *   - Single hiragana (particles: は, が, を) → NOT clickable
 *   - Punctuation, spaces, other chars         → NOT clickable
 *
 * @param {string} text - The Japanese sentence to tokenize
 * @returns {Array<{text: string, clickable: boolean}>}
 */
function tokenizeJapanese(text) {
    // Check if the dictionary is loaded and accessible
    const dict = typeof getLoadedDictionary === "function" ? getLoadedDictionary() : null;
    if (dict) {
        try {
            return segmentWithDict(text, dict);
        } catch (err) {
            console.warn("J-SUB: segmentWithDict error, falling back to regex tokenizer:", err);
        }
    }

    const tokens = [];

    // Regex alternations ordered by priority (most specific first)
    const TOKEN_REGEX = new RegExp(
        // Group 1: Kanji compound + up to 6 trailing hiragana (okurigana)
        "([\\u4E00-\\u9FFF\\u3400-\\u4DBF]+[\\u3040-\\u309F]{0,6})" +
        // Group 2: Katakana sequence (full-width + half-width)
        "|([\\u30A0-\\u30FF\\u31F0-\\u31FF\\uFF66-\\uFF9F]+)" +
        // Group 3: Multi-character hiragana word (2+ chars)
        "|([\\u3040-\\u309F]{2,})" +
        // Group 4: Single hiragana character (particle — non-clickable)
        "|([\\u3040-\\u309F])" +
        // Group 5: Whitespace
        "|([\\s\\u3000]+)" +
        // Group 6: Anything else (punctuation, Latin, numbers, symbols)
        "|([^\\u4E00-\\u9FFF\\u3400-\\u4DBF\\u3040-\\u309F\\u30A0-\\u30FF\\u31F0-\\u31FF\\uFF66-\\uFF9F\\s\\u3000]+)",
        "g"
    );

    let match;
    while ((match = TOKEN_REGEX.exec(text)) !== null) {
        const [full, kanji, katakana, hiraganaWord, hiraganaChar, space, other] = match;
        // Kanji compounds, katakana words, and multi-char hiragana are clickable
        const clickable = !!(kanji || katakana || hiraganaWord);
        tokens.push({ text: full, clickable });
    }

    return tokens;
}

/**
 * Renders a tokenized Japanese sentence as interactive HTML.
 * Clickable tokens become <span class="jp-token"> with data attributes
 * for the word text and parent sentence index.
 */
function renderTokenizedText(text, sentenceIndex) {
    const tokens = tokenizeJapanese(text);
    return tokens
        .map((token) => {
            if (token.clickable) {
                return `<span class="jp-token" data-word="${escapeHtml(token.text)}" data-sentence="${sentenceIndex}">${escapeHtml(token.text)}</span>`;
            }
            return `<span class="jp-separator">${escapeHtml(token.text)}</span>`;
        })
        .join("");
}

// ═══════════════════════════════════════════════════════════════════
// §5. Subtitle Rendering
// ═══════════════════════════════════════════════════════════════════

/**
 * Renders the full subtitle transcript into the side panel UI.
 * Each subtitle becomes a sentence box with tokenized Japanese text
 * and a translation placeholder.
 *
 * @param {Array<{text: string}>} subs - Array of subtitle objects
 */
/**
 * Renders the full subtitle transcript into the side panel UI.
 * Each subtitle becomes a sentence box with tokenized Japanese text
 * and a local gloss translation.
 *
 * @param {Array<{text: string}>} subs - Array of subtitle objects
 */
async function renderSubtitles(subs) {
    currentSubtitles = subs;
    totalSubs = subs.length;
    lastHighlightedIndex = -1;

    const container = document.getElementById("transcript-container");
    container.innerHTML = `<div class="empty-state"><div class="spinner"></div><p>Processing subtitles offline...</p></div>`;

    updateProgress("Analyzing subtitles...", 15);
    
    // Ensure offline dictionary and kuromoji are preloaded before tokenizing
    try {
        await Promise.all([loadDictionary(), loadKuromoji()]);
    } catch (e) {
        console.error("J-SUB: Resource preloading failed before render:", e);
    }

    updateProgress("Generating offline gloss translations...", 50);

    const resumeFrom = lastHighlightedIndex >= 0 ? lastHighlightedIndex : 0;
    
    // Render and translate all subtitle boxes in parallel
    const boxesHtmlPromises = subs.map(async (sub, i) => {
        let tokensHtml = "";
        let translation = "";
        
        try {
            // 1. Morphological analysis with Kuromoji
            const tokens = await analyzeJapaneseText(sub.text);
            if (tokens && tokens.length > 0) {
                tokensHtml = tokens.map((token) => {
                    if (token.isWord) {
                        return `<span class="jp-token" data-word="${escapeHtml(token.text)}" data-base="${escapeHtml(token.baseForm)}" data-pos="${escapeHtml(token.pos)}" data-reading="${escapeHtml(token.reading)}" data-sentence="${i}">${escapeHtml(token.text)}</span>`;
                    }
                    return `<span class="jp-separator">${escapeHtml(token.text)}</span>`;
                }).join("");
            } else {
                // Fallback to basic tokenizer if kuromoji fails
                tokensHtml = renderTokenizedText(sub.text, i);
            }
        } catch (err) {
            console.error(`J-SUB: Tokenization error for subtitle ${i}:`, err);
            tokensHtml = renderTokenizedText(sub.text, i);
        }

        try {
            // 2. Offline gloss translation
            translation = await translateSentenceOffline(sub.text);
        } catch (err) {
            console.error(`J-SUB: Translation error for subtitle ${i}:`, err);
            translation = "Translation error";
        }

        return `
            <div class="sentence-box" id="sub-box-${i}">
                <div class="jp-text" id="jp-${i}">${tokensHtml}</div>
                <div class="en-translation" id="trans-${i}">${escapeHtml(translation)}</div>
            </div>
        `;
    });

    try {
        const boxesHtml = await Promise.all(boxesHtmlPromises);
        container.innerHTML = boxesHtml.join("");
    } catch (e) {
        console.error("J-SUB: Failed to compile subtitle boxes HTML:", e);
        container.innerHTML = `<div class="empty-state"><p>⚠ Error loading subtitles</p></div>`;
        return;
    }

    // Attach click handlers to all clickable tokens
    container.querySelectorAll(".jp-token").forEach((span) => {
        span.addEventListener("click", handleTokenClick);
    });

    // Attach click handlers to sentence boxes to toggle translation visibility
    container.querySelectorAll(".sentence-box").forEach((box) => {
        box.addEventListener("click", () => {
            box.classList.toggle("show-translation");
        });
    });

    updateProgress("✓ Episode parsed offline", 100);
    
    // Jump/Scroll to playback position
    if (resumeFrom < subs.length) {
        highlightActiveSubtitle(subs[resumeFrom].text);
    }
}

// ═══════════════════════════════════════════════════════════════════
// §7. Fuzzy Subtitle Highlighting (Dice Coefficient)
// ═══════════════════════════════════════════════════════════════════

/**
 * Normalizes text for fuzzy comparison.
 */
function normalizeForMatch(text) {
    if (!text) return "";
    return (
        text
            .replace(/[\u200B\u200C\u200D\uFEFF\u00A0\u2060\u2028\u2029]/g, "")
            .replace(/[\s\u3000]+/g, "")
            .replace(/[。、！？「」『』（）【】〈〉《》・…―─ー～〜♪♫]/g, "")
            .replace(/[.,!?'"()\[\]{}\-–—:;/\\#@&%$^*+=|<>~`]/g, "")
            .normalize("NFKC")
            .toLowerCase()
    );
}

/**
 * Dice Coefficient — a bigram-based similarity metric.
 */
function diceCoefficient(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;

    const bigramsA = new Map();
    for (let i = 0; i < a.length - 1; i++) {
        const bg = a.substring(i, i + 2);
        bigramsA.set(bg, (bigramsA.get(bg) || 0) + 1);
    }

    let intersections = 0;
    for (let i = 0; i < b.length - 1; i++) {
        const bg = b.substring(i, i + 2);
        const count = bigramsA.get(bg) || 0;
        if (count > 0) {
            bigramsA.set(bg, count - 1);
            intersections++;
        }
    }

    return (2.0 * intersections) / (a.length - 1 + (b.length - 1));
}

/**
 * Finds and highlights the sentence box that best matches the
 * currently on-screen subtitle text.
 */
function highlightActiveSubtitle(activeText) {
    if (!activeText?.trim()) return;

    const normalizedActive = normalizeForMatch(activeText);
    if (!normalizedActive) return;

    const boxes = document.querySelectorAll(".sentence-box");
    let bestIndex = -1;
    let bestScore = 0;

    boxes.forEach((box, index) => {
        const jpEl = box.querySelector(".jp-text");
        if (!jpEl) return;

        const jpNorm = normalizeForMatch(jpEl.textContent);
        if (!jpNorm) return;

        let score = 0;

        if (jpNorm === normalizedActive) {
            score = 1.0;
        } else if (
            normalizedActive.includes(jpNorm) ||
            jpNorm.includes(normalizedActive)
        ) {
            const ratio = Math.min(jpNorm.length, normalizedActive.length) /
                          Math.max(jpNorm.length, normalizedActive.length);
            score = 0.85 + ratio * 0.10;
        } else {
            score = diceCoefficient(normalizedActive, jpNorm);
        }

        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    });

    const THRESHOLD = 0.55;

    boxes.forEach((box, index) => {
        if (index === bestIndex && bestScore >= THRESHOLD) {
            if (!box.classList.contains("is-active")) {
                box.classList.add("is-active");
            }

            if (lastHighlightedIndex !== index) {
                lastHighlightedIndex = index;

                // Only auto-scroll if the user hasn't manually scrolled away
                // (the FAB button handles manual return-to-active)
                if (!_userHasScrolledAway) {
                    clearTimeout(scrollDebounceTimer);
                    scrollDebounceTimer = setTimeout(() => {
                        box.scrollIntoView({ behavior: "smooth", block: "center" });
                    }, 150);
                }

                // Update the scroll-to-active button visibility
                updateScrollToActiveButton();
            }
        } else {
            box.classList.remove("is-active");
        }
    });
}

// ═══════════════════════════════════════════════════════════════════
// §8. Interactive Word Dictionary (Offline + Gemini Tooltips)
// ═══════════════════════════════════════════════════════════════════

/**
 * Handles a click on a Japanese token.
 * Performs a completely offline lookup in the JMDict dictionary.
 */
async function handleTokenClick(event) {
    event.stopPropagation();

    const span = event.currentTarget;
    const word = span.dataset.word;
    const baseForm = span.dataset.base || null;
    const pos = span.dataset.pos || "";
    const reading = span.dataset.reading || "";
    const sentenceIndex = parseInt(span.dataset.sentence, 10);
    const sentence = currentSubtitles[sentenceIndex]?.text || "";

    if (!word) return;

    // Guard: prevent double-trigger while a lookup is in progress
    if (_lookupInProgress) return;

    // Toggle: if clicking the same word that's already showing, dismiss
    if (currentTooltipForWord === word && activeTooltip) {
        dismissTooltip();
        return;
    }

    _lookupInProgress = true;

    // Show loading state
    showTooltip(
        span,
        `<div class="tooltip-loading">` +
            `<div class="spinner"></div>` +
            `Looking up <strong>${escapeHtml(word)}</strong>…` +
            `</div>`,
        null, null
    );

    try {
        // ── Try offline dictionary first with baseForm optimization ──
        const dictResult = await lookupWord(word, baseForm);

        if (dictResult) {
            _lookupInProgress = false; // Release guard
            const html = formatDictResult(dictResult);
            const wordData = extractWordData(dictResult);
            wordData.sentence = sentence;
            currentTooltipWordData = wordData;
            const saved = await isWordSaved(wordData.word);
            showTooltip(span, html, wordData, saved);
            return;
        }

        // ── Fallback: Word not in dictionary, construct a metadata tooltip ──
        _lookupInProgress = false; // Release guard
        
        let html = `<div class="dict-entry">`;
        html += `<div class="dict-header">`;
        html += `<span class="dict-word">📖 ${escapeHtml(word)}</span>`;
        if (reading) {
            html += `<span class="dict-reading">【${escapeHtml(reading)}】</span>`;
        }
        html += `</div>`;
        html += `<div class="dict-sense">`;
        if (pos) {
            html += `<span class="dict-pos">${escapeHtml(pos)}</span>`;
        }
        html += `<span class="dict-gloss">Offline definition unavailable.</span>`;
        html += `</div>`;
        html += `</div>`;

        // Dummy word data to allow saving anyway if they want to translate manually later
        const wordData = {
            word: word,
            reading: reading,
            meaning: "Offline definition unavailable",
            pos: pos,
            sentence: sentence
        };
        
        currentTooltipWordData = wordData;
        const saved = await isWordSaved(word.word);
        showTooltip(span, html, wordData, saved);
    } catch (e) {
        _lookupInProgress = false;
        showTooltip(span, "⚠ Offline lookup failed.", null, null);
        console.error("J-SUB: Offline dictionary lookup failed:", e);
    }
}

/**
 * Creates and positions a floating tooltip anchored to a token element.
 * Now includes a save button when wordData is provided.
 */
function showTooltip(anchor, contentHtml, wordData, isSaved) {
    dismissTooltip();

    const tooltip = document.createElement("div");
    tooltip.className = "word-tooltip";
    tooltip.dataset.forWord = anchor.dataset.word || "";

    let innerHtml =
        `<button class="tooltip-close" aria-label="Close">✕</button>` +
        `<div class="tooltip-content">${contentHtml}</div>`;

    // Add save button if we have word data
    if (wordData) {
        const savedClass = isSaved ? " is-saved" : "";
        const savedText = isSaved ? "✓ Saved" : "⭐ Save Word";
        innerHtml += `<div class="tooltip-actions">` +
            `<button class="tooltip-save-btn${savedClass}" id="tooltip-save-btn">${savedText}</button>` +
            `</div>`;
    }

    tooltip.innerHTML = innerHtml;
    document.body.appendChild(tooltip);
    activeTooltip = tooltip;
    currentTooltipForWord = anchor.dataset.word || null;

    // Position the tooltip below the anchor element
    const anchorRect = anchor.getBoundingClientRect();
    const GAP = 8;

    requestAnimationFrame(() => {
        const tooltipRect = tooltip.getBoundingClientRect();

        let top = anchorRect.bottom + GAP;
        let left =
            anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;

        const MARGIN = 8;

        if (left < MARGIN) left = MARGIN;
        if (left + tooltipRect.width > window.innerWidth - MARGIN) {
            left = window.innerWidth - tooltipRect.width - MARGIN;
        }

        if (top + tooltipRect.height > window.innerHeight - MARGIN) {
            top = anchorRect.top - tooltipRect.height - GAP;
        }

        tooltip.style.top = `${top}px`;
        tooltip.style.left = `${left}px`;

        tooltip.classList.add("visible");
    });

    // Close button handler
    tooltip.querySelector(".tooltip-close").addEventListener("click", (e) => {
        e.stopPropagation();
        dismissTooltip();
    });

    // Save button handler
    const saveBtn = tooltip.querySelector("#tooltip-save-btn");
    if (saveBtn && wordData) {
        saveBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (saveBtn.classList.contains("is-saved")) return;

            const success = await saveWord(wordData);
            if (success) {
                saveBtn.textContent = "✓ Saved";
                saveBtn.classList.add("is-saved");
                saveBtn.style.animation = "card-save-pop 0.3s ease";
                updateVocabBadge();

                // Mark token as saved
                const token = document.querySelector(`.jp-token[data-word="${CSS.escape(wordData.word)}"]`);
                if (token) token.classList.add("is-saved");
            }
        });
    }

    // Click outside to dismiss
    setTimeout(() => {
        document.addEventListener("click", handleOutsideClick);
    }, 100);

    // Highlight the looked-up token
    anchor.classList.add("is-looked-up");
}

/**
 * Removes the active tooltip and cleans up event listeners.
 *
 * IMPORTANT: Captures the tooltip reference BEFORE the setTimeout
 * to prevent a race condition where the delayed removal kills a
 * replacement tooltip that was created in the interim.
 */
function dismissTooltip() {
    if (activeTooltip) {
        const tooltipToRemove = activeTooltip; // Capture reference!
        tooltipToRemove.classList.remove("visible");
        activeTooltip = null; // Clear immediately so new tooltip can take over
        setTimeout(() => {
            tooltipToRemove.remove(); // Remove the captured old tooltip, not the new one
        }, 200);
    }
    currentTooltipWordData = null;
    currentTooltipForWord = null;
    document.removeEventListener("click", handleOutsideClick);
    document.querySelectorAll(".jp-token.is-looked-up").forEach((el) => {
        el.classList.remove("is-looked-up");
    });
}

/**
 * Click-outside handler.
 */
function handleOutsideClick(e) {
    if (
        activeTooltip &&
        !activeTooltip.contains(e.target) &&
        !e.target.classList.contains("jp-token")
    ) {
        dismissTooltip();
    }
}

// ═══════════════════════════════════════════════════════════════════
// §9. Vocabulary Panel
// ═══════════════════════════════════════════════════════════════════

/**
 * Updates the vocab badge count in the tab bar.
 */
async function updateVocabBadge() {
    const words = await getSavedWords();
    const badge = document.getElementById("vocab-badge");
    if (words.length > 0) {
        badge.textContent = words.length;
        badge.style.display = "inline";
    } else {
        badge.style.display = "none";
    }
}

/**
 * Renders the full vocabulary list with stats, search, and cards.
 */
async function renderVocabList() {
    const words = await getSavedWords();
    const stats = await getWordStats();

    // ── Update Stats ─────────────────────────────────────────────
    document.getElementById("stat-total").textContent = stats.total;
    document.getElementById("stat-mastered").textContent =
        (stats.mastery[3] || 0) + (stats.mastery[4] || 0);
    document.getElementById("stat-today").textContent = stats.reviewedToday;

    // ── Mastery Bar ──────────────────────────────────────────────
    const masteryBar = document.getElementById("mastery-bar");
    if (stats.total > 0) {
        const colors = ["var(--mastery-new)", "var(--mastery-learning)", "var(--mastery-familiar)", "var(--mastery-known)", "var(--mastery-mastered)"];
        masteryBar.innerHTML = colors.map((color, i) => {
            const count = stats.mastery[i] || 0;
            const pct = (count / stats.total) * 100;
            return `<div class="mastery-segment" style="flex:${pct};background:${color}" title="${MASTERY_LEVELS[i].label}: ${count}"></div>`;
        }).join("");
    } else {
        masteryBar.innerHTML = `<div class="mastery-segment" style="flex:100;background:var(--border-default)"></div>`;
    }

    // ── Render Word List ─────────────────────────────────────────
    renderFilteredWordList(words);
}

/**
 * Renders the word list with current search/sort filters applied.
 */
function renderFilteredWordList(allWords) {
    const searchQuery = (document.getElementById("vocab-search")?.value || "").toLowerCase().trim();
    const sortMode = document.getElementById("vocab-sort")?.value || "newest";

    // Filter
    let words = allWords;
    if (searchQuery) {
        words = words.filter(w =>
            w.word.toLowerCase().includes(searchQuery) ||
            (w.reading || "").toLowerCase().includes(searchQuery) ||
            (w.meaning || "").toLowerCase().includes(searchQuery)
        );
    }

    // Sort
    switch (sortMode) {
        case "newest":
            words.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
            break;
        case "oldest":
            words.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
            break;
        case "alpha":
            words.sort((a, b) => a.word.localeCompare(b.word, "ja"));
            break;
        case "mastery-asc":
            words.sort((a, b) => (a.mastery || 0) - (b.mastery || 0));
            break;
        case "mastery-desc":
            words.sort((a, b) => (b.mastery || 0) - (a.mastery || 0));
            break;
    }

    const container = document.getElementById("vocab-list");

    if (words.length === 0) {
        container.innerHTML = `
            <div class="vocab-empty">
                <div class="icon">📚</div>
                <p>${searchQuery ? "No words match your search." : "No words saved yet. Click a word in the subtitles and hit ⭐ Save Word!"}</p>
            </div>`;
        return;
    }

    container.innerHTML = words.map((w, i) => {
        const mastery = MASTERY_LEVELS[w.mastery || 0];
        const date = w.savedAt ? new Date(w.savedAt).toLocaleDateString() : "";
        const reviews = w.reviewCount || 0;

        return `
            <div class="word-card" data-word-index="${i}" data-word="${escapeHtml(w.word)}" style="animation-delay:${i * 0.03}s">
                <div class="word-card-header">
                    <span class="word-card-word">${escapeHtml(w.word)}</span>
                    <span class="word-card-mastery" style="background:${mastery.color}22;color:${mastery.color};border:1px solid ${mastery.color}44">
                        ${mastery.emoji} ${mastery.label}
                    </span>
                </div>
                ${w.reading ? `<div class="word-card-reading">${escapeHtml(w.reading)}</div>` : ""}
                <div class="word-card-meaning">${escapeHtml(w.meaning || "")}</div>
                ${w.pos ? `<div class="word-card-pos">${escapeHtml(w.pos)}</div>` : ""}
                <div class="word-card-detail">
                    ${w.sentence ? `<div class="word-card-sentence">「${escapeHtml(w.sentence)}」</div>` : ""}
                    <div class="word-card-meta">
                        <span>Saved ${date} · ${reviews} reviews</span>
                        <button class="word-card-delete" data-delete-word="${escapeHtml(w.word)}">🗑 Delete</button>
                    </div>
                </div>
            </div>`;
    }).join("");

    // ── Attach event listeners ───────────────────────────────────
    container.querySelectorAll(".word-card").forEach((card) => {
        card.addEventListener("click", (e) => {
            if (e.target.classList.contains("word-card-delete")) return;
            card.classList.toggle("expanded");
        });
    });

    container.querySelectorAll(".word-card-delete").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const word = btn.dataset.deleteWord;
            const card = btn.closest(".word-card");

            card.style.animation = "word-delete 0.3s ease forwards";
            setTimeout(async () => {
                await removeWord(word);
                renderVocabList();
                updateVocabBadge();
            }, 300);
        });
    });
}

// ── Search & Sort event listeners ────────────────────────────────
document.getElementById("vocab-search")?.addEventListener("input", async () => {
    const words = await getSavedWords();
    renderFilteredWordList(words);
});

document.getElementById("vocab-sort")?.addEventListener("change", async () => {
    const words = await getSavedWords();
    renderFilteredWordList(words);
});

// ── Export Button ────────────────────────────────────────────────
document.getElementById("export-btn")?.addEventListener("click", async () => {
    const json = await exportWords();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gagensubs-vocab-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
});

// ── Import Button ────────────────────────────────────────────────
document.getElementById("import-btn")?.addEventListener("click", () => {
    document.getElementById("import-file-input").click();
});

document.getElementById("import-file-input")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const result = await importWords(text);
        alert(`Imported ${result.imported} words (${result.skipped} duplicates skipped)`);
        renderVocabList();
        updateVocabBadge();
    } catch (err) {
        alert("Import failed: " + err.message);
    }

    e.target.value = ""; // Reset file input
});

// ═══════════════════════════════════════════════════════════════════
// §10. Flashcard Reader
// ═══════════════════════════════════════════════════════════════════

/**
 * Initializes the flashcard reader panel.
 */
async function initReader() {
    const container = document.getElementById("reader-content");
    const words = await getSavedWords();

    if (words.length === 0) {
        container.innerHTML = `
            <div class="reader-empty">
                <div class="icon">📖</div>
                <p>Save some words from the subtitles first, then come back here to review them with flashcards!</p>
            </div>`;
        return;
    }

    readerCards = [...words];
    readerIndex = 0;
    readerFlipped = false;

    renderReader();
}

/**
 * Renders the current flashcard and all reader controls.
 */
function renderReader() {
    const container = document.getElementById("reader-content");

    if (readerCards.length === 0) {
        container.innerHTML = `
            <div class="reader-empty">
                <div class="icon">🎉</div>
                <p>No cards match your filter. Try a different filter or save more words!</p>
            </div>`;
        return;
    }

    const card = readerCards[readerIndex];
    const mastery = MASTERY_LEVELS[card.mastery || 0];
    const progressPct = ((readerIndex + 1) / readerCards.length) * 100;

    container.innerHTML = `
        <!-- Controls -->
        <div class="reader-controls">
            <select class="reader-filter" id="reader-filter">
                <option value="all">All Words</option>
                <option value="0">🆕 New Only</option>
                <option value="1">📖 Learning</option>
                <option value="2">💡 Familiar</option>
                <option value="01">🆕📖 New + Learning</option>
            </select>
            <button class="reader-shuffle-btn" id="reader-shuffle">🔀 Shuffle</button>
        </div>

        <!-- Progress -->
        <div class="reader-progress">
            <div class="reader-progress-text">${readerIndex + 1} / ${readerCards.length}</div>
            <div class="reader-progress-track">
                <div class="reader-progress-bar" style="width:${progressPct}%"></div>
            </div>
        </div>

        <!-- Flashcard -->
        <div class="flashcard-container">
            <div class="flashcard ${readerFlipped ? "is-flipped" : ""}" id="flashcard">
                <div class="flashcard-face flashcard-front">
                    <div class="flashcard-kanji">${escapeHtml(card.word)}</div>
                    <div class="flashcard-hint">tap to reveal</div>
                </div>
                <div class="flashcard-face flashcard-back">
                    <div class="flashcard-back-reading">${escapeHtml(card.reading || "")}</div>
                    <div class="flashcard-back-meaning">${escapeHtml(card.meaning || "")}</div>
                    ${card.pos ? `<div class="flashcard-back-pos">${escapeHtml(card.pos)}</div>` : ""}
                </div>
            </div>
        </div>

        <!-- Rating Buttons (visible only when flipped) -->
        <div class="reader-rating" id="reader-rating" style="${readerFlipped ? "" : "opacity:0.2;pointer-events:none"}">
            <button class="rating-btn rate-again" data-rate="again">
                <span class="rating-emoji">❌</span>Again
            </button>
            <button class="rating-btn rate-hard" data-rate="hard">
                <span class="rating-emoji">🤔</span>Hard
            </button>
            <button class="rating-btn rate-good" data-rate="good">
                <span class="rating-emoji">👍</span>Good
            </button>
            <button class="rating-btn rate-easy" data-rate="easy">
                <span class="rating-emoji">🎯</span>Easy
            </button>
        </div>

        <!-- Navigation -->
        <div class="reader-nav">
            <button class="nav-btn" id="reader-prev" ${readerIndex === 0 ? "disabled" : ""}>← Prev</button>
            <button class="nav-btn" id="reader-next" ${readerIndex >= readerCards.length - 1 ? "disabled" : ""}>Next →</button>
        </div>
    `;

    // ── Attach Event Listeners ───────────────────────────────────

    // Flip card
    document.getElementById("flashcard").addEventListener("click", () => {
        readerFlipped = !readerFlipped;
        document.getElementById("flashcard").classList.toggle("is-flipped");
        const ratingDiv = document.getElementById("reader-rating");
        if (readerFlipped) {
            ratingDiv.style.opacity = "1";
            ratingDiv.style.pointerEvents = "auto";
        } else {
            ratingDiv.style.opacity = "0.2";
            ratingDiv.style.pointerEvents = "none";
        }
    });

    // Rating buttons
    document.querySelectorAll(".rating-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const rating = btn.dataset.rate;
            await rateWord(readerCards[readerIndex].word, rating);

            // Update local card data
            const current = readerCards[readerIndex].mastery || 0;
            switch (rating) {
                case "again": readerCards[readerIndex].mastery = Math.max(0, current - 1); break;
                case "hard": break;
                case "good": readerCards[readerIndex].mastery = Math.min(4, current + 1); break;
                case "easy": readerCards[readerIndex].mastery = Math.min(4, current + 2); break;
            }

            // Move to next card
            if (readerIndex < readerCards.length - 1) {
                readerIndex++;
                readerFlipped = false;
                renderReader();
            } else {
                // End of deck
                const container = document.getElementById("reader-content");
                container.innerHTML = `
                    <div class="reader-empty" style="padding-top:80px">
                        <div class="icon">🎉</div>
                        <p>Great job! You've reviewed all ${readerCards.length} cards.</p>
                        <button class="btn-primary" id="reader-restart" style="margin-top:16px">Restart Deck</button>
                    </div>`;
                document.getElementById("reader-restart")?.addEventListener("click", () => {
                    readerIndex = 0;
                    readerFlipped = false;
                    renderReader();
                });
            }
        });
    });

    // Navigation
    document.getElementById("reader-prev")?.addEventListener("click", () => {
        if (readerIndex > 0) {
            readerIndex--;
            readerFlipped = false;
            renderReader();
        }
    });

    document.getElementById("reader-next")?.addEventListener("click", () => {
        if (readerIndex < readerCards.length - 1) {
            readerIndex++;
            readerFlipped = false;
            renderReader();
        }
    });

    // Shuffle
    document.getElementById("reader-shuffle")?.addEventListener("click", () => {
        // Fisher-Yates shuffle
        for (let i = readerCards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [readerCards[i], readerCards[j]] = [readerCards[j], readerCards[i]];
        }
        readerIndex = 0;
        readerFlipped = false;
        renderReader();
    });

    // Filter
    document.getElementById("reader-filter")?.addEventListener("change", async (e) => {
        const filterVal = e.target.value;
        const allWords = await getSavedWords();

        if (filterVal === "all") {
            readerCards = [...allWords];
        } else if (filterVal === "01") {
            readerCards = allWords.filter(w => (w.mastery || 0) <= 1);
        } else {
            const level = parseInt(filterVal, 10);
            readerCards = allWords.filter(w => (w.mastery || 0) === level);
        }

        readerIndex = 0;
        readerFlipped = false;
        renderReader();
    });
}

// ═══════════════════════════════════════════════════════════════════
// §11. Utility Functions
// ═══════════════════════════════════════════════════════════════════

/**
 * Updates the progress bar and status text.
 */
function updateProgress(message, overridePercent = null) {
    const pct =
        overridePercent !== null
            ? overridePercent
            : totalSubs > 0
            ? (processedSubs / totalSubs) * 100
            : 0;
    document.getElementById("progress-bar").style.width = `${pct}%`;
    document.getElementById("status-text").textContent = message;
}

/**
 * Escapes HTML special characters to prevent XSS in innerHTML usage.
 */
function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

/**
 * Promise-based sleep utility for batch pacing.
 */
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════
// §12. Scroll-to-Active FAB Button
// ═══════════════════════════════════════════════════════════════════

/** Tracks whether the user has manually scrolled away from the active subtitle */
let _userHasScrolledAway = false;
let _scrollCheckTimer = null;

/**
 * Sets up the scroll-to-active floating button.
 * Uses scroll event detection to determine when the user has
 * scrolled away from the currently active subtitle.
 */
function initScrollToActiveButton() {
    const btn = document.getElementById("scroll-to-active-btn");
    if (!btn) return;

    // Click handler: scroll to the active subtitle
    btn.addEventListener("click", () => {
        const activeBox = document.querySelector(".sentence-box.is-active");
        if (activeBox) {
            _userHasScrolledAway = false;
            activeBox.scrollIntoView({ behavior: "smooth", block: "center" });
            hideScrollToActiveButton();
        }
    });

    // Detect user scroll in the panel
    const panel = document.getElementById("panel-subtitles");
    if (panel) {
        // Use passive listener for scroll performance
        window.addEventListener("scroll", () => {
            if (activeTab !== "subtitles") return;

            clearTimeout(_scrollCheckTimer);
            _scrollCheckTimer = setTimeout(() => {
                checkActiveSubtitleVisibility();
            }, 100);
        }, { passive: true });
    }
}

/**
 * Checks if the active subtitle is currently visible in the viewport.
 * Shows/hides the FAB accordingly.
 */
function checkActiveSubtitleVisibility() {
    const activeBox = document.querySelector(".sentence-box.is-active");
    if (!activeBox) {
        hideScrollToActiveButton();
        return;
    }

    const rect = activeBox.getBoundingClientRect();
    const viewportHeight = window.innerHeight;

    // Consider the subtitle "visible" if any part of it is in the viewport
    // with some margin for the header bar
    const headerHeight = document.getElementById("header-bar")?.offsetHeight || 80;
    const isVisible = rect.bottom > headerHeight && rect.top < viewportHeight;

    if (isVisible) {
        _userHasScrolledAway = false;
        hideScrollToActiveButton();
    } else {
        _userHasScrolledAway = true;
        showScrollToActiveButton(rect.top < headerHeight ? "below" : "above");
    }
}

/**
 * Shows the scroll-to-active FAB with direction context.
 * @param {"above"|"below"} direction - Where the active subtitle is relative to viewport
 */
function showScrollToActiveButton(direction) {
    const btn = document.getElementById("scroll-to-active-btn");
    if (!btn) return;

    btn.textContent = direction === "above" ? "▲ Now Playing" : "▼ Now Playing";
    btn.style.display = "flex";
    // Trigger reflow for animation
    btn.offsetHeight;
    btn.classList.add("visible");
}

/**
 * Hides the scroll-to-active FAB.
 */
function hideScrollToActiveButton() {
    const btn = document.getElementById("scroll-to-active-btn");
    if (!btn) return;

    btn.classList.remove("visible");
    // Hide after transition completes
    setTimeout(() => {
        if (!btn.classList.contains("visible")) {
            btn.style.display = "none";
        }
    }, 300);
}

/**
 * Called by highlightActiveSubtitle when the active index changes.
 * Checks visibility and updates the FAB state.
 */
function updateScrollToActiveButton() {
    // Small delay to let the DOM update with the new active class
    setTimeout(() => checkActiveSubtitleVisibility(), 200);
}

// ── Initialize the scroll-to-active button on load ───────────────
initScrollToActiveButton();
