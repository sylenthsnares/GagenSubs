/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  Word Store — Persistent Vocabulary Manager                      ║
 * ║                                                                  ║
 * ║  Saves/loads/manages user's saved words via chrome.storage.local ║
 * ║  Includes mastery tracking, search, export/import.               ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ═══════════════════════════════════════════════════════════════════
// §1. Constants
// ═══════════════════════════════════════════════════════════════════

const STORAGE_KEY = "gagensubs_saved_words";
const OLD_STORAGE_KEY = "nigaku_saved_words";

/** Mastery levels with labels and colors */
const MASTERY_LEVELS = {
    0: { label: "New",       emoji: "🆕", color: "#e74c3c" },
    1: { label: "Learning",  emoji: "📖", color: "#f39c12" },
    2: { label: "Familiar",  emoji: "💡", color: "#f1c40f" },
    3: { label: "Known",     emoji: "✅", color: "#2ecc71" },
    4: { label: "Mastered",  emoji: "🎯", color: "#3498db" },
};

// ═══════════════════════════════════════════════════════════════════
// §2. Core CRUD Operations
// ═══════════════════════════════════════════════════════════════════

/**
 * Retrieves all saved words from storage.
 * @returns {Promise<Array>} Array of word objects sorted by savedAt (newest first)
 */
async function getSavedWords() {
    return new Promise((resolve) => {
        chrome.storage.local.get([STORAGE_KEY, OLD_STORAGE_KEY], (result) => {
            let words = result[STORAGE_KEY];
            if (!words && result[OLD_STORAGE_KEY]) {
                words = result[OLD_STORAGE_KEY];
                // Migrate to new storage key and clear old one
                chrome.storage.local.set({ [STORAGE_KEY]: words }, () => {
                    chrome.storage.local.remove([OLD_STORAGE_KEY]);
                });
            }
            words = words || [];
            // Sort newest first
            words.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
            resolve(words);
        });
    });
}

/**
 * Saves a word to the vocabulary list.
 * Prevents duplicates by checking the `word` field.
 *
 * @param {object} wordData
 *   { word, reading, meaning, pos, sentence, allSenses? }
 * @returns {Promise<boolean>} true if saved, false if already exists
 */
async function saveWord(wordData) {
    const words = await getSavedWords();

    // Check for duplicates
    if (words.some(w => w.word === wordData.word)) {
        return false;
    }

    words.push({
        ...wordData,
        mastery: 0,            // Start as "New"
        savedAt: Date.now(),
        reviewCount: 0,
        lastReviewed: null,
    });

    return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY]: words }, () => {
            resolve(true);
        });
    });
}

/**
 * Removes a word from the saved list.
 * @param {string} word - The word to remove
 * @returns {Promise<boolean>} true if removed
 */
async function removeWord(word) {
    const words = await getSavedWords();
    const filtered = words.filter(w => w.word !== word);

    if (filtered.length === words.length) return false;

    return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY]: filtered }, () => {
            resolve(true);
        });
    });
}

/**
 * Checks if a word is already saved.
 * @param {string} word
 * @returns {Promise<boolean>}
 */
async function isWordSaved(word) {
    const words = await getSavedWords();
    return words.some(w => w.word === word);
}

// ═══════════════════════════════════════════════════════════════════
// §3. Mastery & Review
// ═══════════════════════════════════════════════════════════════════

/**
 * Updates the mastery level and review stats for a word.
 * @param {string} word - The word to update
 * @param {number} level - New mastery level (0-4)
 */
async function updateWordMastery(word, level) {
    const words = await getSavedWords();
    const entry = words.find(w => w.word === word);

    if (!entry) return;

    entry.mastery = Math.max(0, Math.min(4, level));
    entry.reviewCount = (entry.reviewCount || 0) + 1;
    entry.lastReviewed = Date.now();

    return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY]: words }, resolve);
    });
}

/**
 * Adjusts mastery based on flashcard review rating.
 * @param {string} word
 * @param {"again"|"hard"|"good"|"easy"} rating
 */
async function rateWord(word, rating) {
    const words = await getSavedWords();
    const entry = words.find(w => w.word === word);
    if (!entry) return;

    const current = entry.mastery || 0;

    switch (rating) {
        case "again":
            entry.mastery = Math.max(0, current - 1);
            break;
        case "hard":
            // Keep same level
            break;
        case "good":
            entry.mastery = Math.min(4, current + 1);
            break;
        case "easy":
            entry.mastery = Math.min(4, current + 2);
            break;
    }

    entry.reviewCount = (entry.reviewCount || 0) + 1;
    entry.lastReviewed = Date.now();

    return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY]: words }, resolve);
    });
}

// ═══════════════════════════════════════════════════════════════════
// §4. Statistics
// ═══════════════════════════════════════════════════════════════════

/**
 * Returns vocabulary statistics.
 */
async function getWordStats() {
    const words = await getSavedWords();
    const masteryBreakdown = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };

    for (const w of words) {
        masteryBreakdown[w.mastery || 0]++;
    }

    return {
        total: words.length,
        mastery: masteryBreakdown,
        reviewedToday: words.filter(w => {
            if (!w.lastReviewed) return false;
            const today = new Date();
            const reviewed = new Date(w.lastReviewed);
            return today.toDateString() === reviewed.toDateString();
        }).length,
    };
}

// ═══════════════════════════════════════════════════════════════════
// §5. Export / Import
// ═══════════════════════════════════════════════════════════════════

/**
 * Exports all saved words as a JSON string.
 */
async function exportWords() {
    const words = await getSavedWords();
    return JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        words: words
    }, null, 2);
}

/**
 * Imports words from a JSON string.
 * Merges with existing words, avoiding duplicates.
 * @param {string} jsonStr
 * @returns {Promise<{imported: number, skipped: number}>}
 */
async function importWords(jsonStr) {
    const data = JSON.parse(jsonStr);
    const importedWords = data.words || data; // Support both wrapped and raw array

    if (!Array.isArray(importedWords)) {
        throw new Error("Invalid import format");
    }

    const existing = await getSavedWords();
    const existingSet = new Set(existing.map(w => w.word));

    let imported = 0;
    let skipped = 0;

    for (const w of importedWords) {
        if (!w.word) continue;

        if (existingSet.has(w.word)) {
            skipped++;
            continue;
        }

        existing.push({
            word: w.word,
            reading: w.reading || "",
            meaning: w.meaning || "",
            pos: w.pos || "",
            sentence: w.sentence || "",
            mastery: w.mastery || 0,
            savedAt: w.savedAt || Date.now(),
            reviewCount: w.reviewCount || 0,
            lastReviewed: w.lastReviewed || null,
            allSenses: w.allSenses || [],
        });
        existingSet.add(w.word);
        imported++;
    }

    return new Promise((resolve) => {
        chrome.storage.local.set({ [STORAGE_KEY]: existing }, () => {
            resolve({ imported, skipped });
        });
    });
}
