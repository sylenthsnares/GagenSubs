/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  J-Sub Explainer Engine — Content Script Bridge                  ║
 * ║  World: ISOLATED (Chrome extension context)                      ║
 * ║                                                                  ║
 * ║  Bridges between the MAIN world interceptor and the extension's  ║
 * ║  background service worker / side panel.                         ║
 * ║  Also monitors the Netflix player DOM for the currently active   ║
 * ║  on-screen subtitle text via MutationObserver.                   ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ═══════════════════════════════════════════════════════════════════
// §1. Safe Messaging Utility
// ═══════════════════════════════════════════════════════════════════

/**
 * Safely sends a message to the background/side panel.
 * Prevents "Extension context invalidated" errors that occur
 * when the extension is reloaded/updated while Netflix is open.
 */
function safeSendMessage(message) {
    try {
        // chrome.runtime.id is undefined when the context is invalidated
        if (!chrome.runtime?.id) {
            disconnectObserver();
            return;
        }
        chrome.runtime.sendMessage(message).catch(() => {
            // Receiver not ready (side panel closed, background idle) — safe to ignore
        });
    } catch (e) {
        // Context fully invalidated — clean up and stop
        console.log("J-SUB: Extension context invalidated, cleaning up.");
        disconnectObserver();
    }
}

// ═══════════════════════════════════════════════════════════════════
// §2. Text Normalization
// ═══════════════════════════════════════════════════════════════════

/**
 * Normalizes raw DOM text before sending to the side panel.
 * Strips invisible characters and collapses whitespace to ensure
 * the fuzzy matcher in sidepanel.js can find a reliable match.
 */
function normalizeSubtitleText(raw) {
    if (!raw) return "";
    return raw
        .replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, "") // Zero-width chars
        .replace(/\s+/g, " ")                                // Collapse whitespace
        .trim();
}

// ═══════════════════════════════════════════════════════════════════
// §3. Interceptor Message Listener (MAIN → ISOLATED)
// ═══════════════════════════════════════════════════════════════════

let lastJpSubs = [];
let lastEnSubs = [];

/**
 * Converts timestamp strings (hh:mm:ss.ms or ss.ms) to milliseconds.
 */
function timeToMs(timeStr) {
    if (!timeStr) return 0;
    const cleanTime = timeStr.trim();
    
    // Check if it's float seconds (e.g. "75.5" or "75")
    if (/^\d+(\.\d+)?(s)?$/.test(cleanTime)) {
        return parseFloat(cleanTime) * 1000;
    }
    
    const match = cleanTime.match(/^(?:(\d+):)?(?:(\d+):)?(\d+)(?:[.:](\d+))?$/);
    if (!match) {
        const floatVal = parseFloat(cleanTime);
        return isNaN(floatVal) ? 0 : floatVal * 1000;
    }
    
    const hh = parseInt(match[1] || "0", 10);
    const mm = parseInt(match[2] || "0", 10);
    const ss = parseInt(match[3] || "0", 10);
    const msStr = match[4] || "0";
    
    let ms = 0;
    if (msStr.length === 1) ms = parseInt(msStr, 10) * 100;
    else if (msStr.length === 2) ms = parseInt(msStr, 10) * 10;
    else if (msStr.length === 3) ms = parseInt(msStr, 10);
    else ms = parseInt(msStr.substring(0, 3), 10);

    return (hh * 3600 + mm * 60 + ss) * 1000 + ms;
}

/**
 * Finds the English subtitle that best matches the timing of the Japanese subtitle.
 */
function findMatchingEnglishSub(jpSub, enSubs) {
    if (!jpSub.begin || !jpSub.end || enSubs.length === 0) return null;
    
    const jpStart = timeToMs(jpSub.begin);
    const jpEnd = timeToMs(jpSub.end);

    let bestMatch = null;
    let maxOverlap = 0;

    for (const enSub of enSubs) {
        if (!enSub.begin || !enSub.end) continue;
        
        const enStart = timeToMs(enSub.begin);
        const enEnd = timeToMs(enSub.end);

        // Overlapping interval logic: max of starts to min of ends
        const overlapStart = Math.max(jpStart, enStart);
        const overlapEnd = Math.min(jpEnd, enEnd);
        const overlap = overlapEnd - overlapStart;

        if (overlap > 0 && overlap > maxOverlap) {
            maxOverlap = overlap;
            bestMatch = enSub;
        }
    }

    // Fallback: match by closest start time if no physical overlap (within 1.5 seconds)
    if (!bestMatch) {
        let minDiff = 1500;
        for (const enSub of enSubs) {
            const enStart = timeToMs(enSub.begin);
            const diff = Math.abs(jpStart - enStart);
            if (diff < minDiff) {
                minDiff = diff;
                bestMatch = enSub;
            }
        }
    }

    return bestMatch;
}

/**
 * Correlates lastJpSubs and lastEnSubs, then saves and broadcasts them.
 */
function matchAndSendSubtitles() {
    if (lastJpSubs.length === 0) return;

    const mergedSubs = lastJpSubs.map(jpSub => {
        const enSub = findMatchingEnglishSub(jpSub, lastEnSubs);
        return {
            text: jpSub.text,
            begin: jpSub.begin,
            end: jpSub.end,
            enText: enSub ? enSub.text : ""
        };
    });

    console.log(`J-SUB: [BRIDGE] Merged ${mergedSubs.filter(s => s.enText).length}/${mergedSubs.length} subtitles with English translations.`);
    
    // Cache to local storage
    chrome.storage.local.set({ cachedSubtitles: mergedSubs });

    // Send update to background/side panel
    safeSendMessage({ action: "PRELOAD_SUBTITLES", subtitles: mergedSubs });
}

window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    
    const type = event.data?.type;
    const subs = event.data?.subtitles;
    if (!Array.isArray(subs) || subs.length === 0) return;

    if (type === "J_SUB_FULL_TRACK") {
        // Fallback for single track (old behavior)
        chrome.storage.local.set({ cachedSubtitles: subs });
        safeSendMessage({ action: "PRELOAD_SUBTITLES", subtitles: subs });
    } else if (type === "J_SUB_JP_TRACK") {
        console.log(`J-SUB: [BRIDGE] Received Japanese subtitle track with ${subs.length} cues.`);
        lastJpSubs = subs;
        matchAndSendSubtitles();
    } else if (type === "J_SUB_EN_TRACK") {
        console.log(`J-SUB: [BRIDGE] Received English subtitle track with ${subs.length} cues.`);
        lastEnSubs = subs;
        matchAndSendSubtitles();
    }
});

// ═══════════════════════════════════════════════════════════════════
// §4. MutationObserver — Track Active On-Screen Subtitle
// ═══════════════════════════════════════════════════════════════════

let lastActiveText = "";
let observer = null;

/** Cleanly disconnect the MutationObserver */
function disconnectObserver() {
    if (observer) {
        observer.disconnect();
        observer = null;
        console.log("J-SUB: MutationObserver disconnected.");
    }
}

/** Start observing the Netflix player DOM for subtitle changes */
function startObserver() {
    if (observer) return; // Already running

    observer = new MutationObserver(() => {
        // Verify the extension context is still valid before doing anything
        try {
            if (!chrome.runtime?.id) {
                disconnectObserver();
                return;
            }
        } catch (e) {
            disconnectObserver();
            return;
        }

        // Netflix renders active subtitles in these DOM containers
        const containers = document.querySelectorAll(
            ".player-timedtext, .player-timedtext-text-container"
        );

        if (containers.length === 0) return;

        // Combine all visible subtitle text fragments
        let currentText = Array.from(containers)
            .map(el => el.textContent)
            .join(" ");

        currentText = normalizeSubtitleText(currentText);

        // Only send if the text has actually changed (debounce at source)
        if (currentText && currentText !== lastActiveText) {
            lastActiveText = currentText;
            safeSendMessage({ action: "ACTIVE_SUBTITLE", text: currentText });
        }
    });

    // Observe the entire document body for subtitle DOM mutations
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });

    console.log("J-SUB: [BRIDGE] MutationObserver started, tracking active subtitles.");
}

// ── Bootstrap ────────────────────────────────────────────────────
try {
    startObserver();
} catch (e) {
    console.warn("J-SUB: Failed to start MutationObserver:", e);
}

// ═══════════════════════════════════════════════════════════════════
// §5. Automated Subtitle Track Loading (DOM Simulation)
// ═══════════════════════════════════════════════════════════════════

let subtitleAutomationDone = false;
let autoLoadingInProgress = false;

function automateSubtitleMenuClicks() {
    if (subtitleAutomationDone || autoLoadingInProgress) return;

    // Only run if the player video is present and active
    const video = document.querySelector("video");
    if (!video) return;

    const subtitleBtn = document.querySelector('[data-uia="control-audio-subtitle"], [data-uia="player-subtitle-button"]');
    if (!subtitleBtn) return;

    // Skip if tracks are already populated in bridge memory
    if (lastJpSubs.length > 0 && lastEnSubs.length > 0) {
        subtitleAutomationDone = true;
        return;
    }

    console.log("J-SUB: [AUTO] Triggering automated subtitle track toggle...");
    autoLoadingInProgress = true;

    // Step 1: Open the subtitle selection menu
    subtitleBtn.click();

    setTimeout(() => {
        // Step 2: Locate the English subtitle option
        const options = Array.from(document.querySelectorAll('[data-uia^="subtitle-item-"], [data-uia^="track-subtitle-"], li'));
        const englishOpt = options.find(el => {
            const text = el.textContent.toLowerCase();
            const uia = (el.getAttribute("data-uia") || "").toLowerCase();
            return (text.includes("english") || uia.includes("english")) && !uia.includes("audio");
        });

        if (!englishOpt) {
            console.warn("J-SUB: [AUTO] English subtitle option not found in menu.");
            // Re-close the menu if opened
            subtitleBtn.click();
            autoLoadingInProgress = false;
            subtitleAutomationDone = true; // prevent infinite loops if track unavailable
            return;
        }

        console.log("J-SUB: [AUTO] Clicking English subtitle track...");
        englishOpt.click();

        // Step 3: Wait for Netflix to download the English subtitle file
        setTimeout(() => {
            // Re-open the menu
            const openBtn = document.querySelector('[data-uia="control-audio-subtitle"], [data-uia="player-subtitle-button"]');
            openBtn?.click();

            setTimeout(() => {
                // Step 4: Locate the Japanese subtitle option
                const newOptions = Array.from(document.querySelectorAll('[data-uia^="subtitle-item-"], [data-uia^="track-subtitle-"], li'));
                const japaneseOpt = newOptions.find(el => {
                    const text = el.textContent.toLowerCase();
                    const uia = (el.getAttribute("data-uia") || "").toLowerCase();
                    return (text.includes("japanese") || text.includes("日本語") || uia.includes("japanese") || uia.includes("japanese")) && !uia.includes("audio");
                });

                if (japaneseOpt) {
                    console.log("J-SUB: [AUTO] Reverting back to Japanese subtitle track...");
                    japaneseOpt.click();
                    subtitleAutomationDone = true;
                } else {
                    console.warn("J-SUB: [AUTO] Japanese subtitle option not found to revert.");
                    // Re-close the menu
                    openBtn?.click();
                }
                autoLoadingInProgress = false;
            }, 300);
        }, 800);
    }, 300);
}

// Reset automation when the video changes (detected by URL changes)
let lastUrl = location.href;
setInterval(() => {
    if (location.href !== lastUrl) {
        lastUrl = location.href;
        subtitleAutomationDone = false;
        autoLoadingInProgress = false;
        lastJpSubs = [];
        lastEnSubs = [];
    }
    // Only attempt automation if we have a playing video and we don't have English track matched
    if (!subtitleAutomationDone && !autoLoadingInProgress && document.querySelector("video")) {
        automateSubtitleMenuClicks();
    }
}, 3000);