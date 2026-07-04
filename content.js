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

window.addEventListener("message", (event) => {
    // Security: only accept messages from the same window (our interceptor)
    if (event.source !== window) return;
    if (event.data?.type !== "J_SUB_FULL_TRACK") return;

    const subs = event.data.subtitles;
    if (!Array.isArray(subs) || subs.length === 0) return;

    // Buffer to chrome.storage as a race-condition guard.
    // If the side panel opens AFTER subtitles are caught, it reads from here.
    chrome.storage.local.set({ cachedSubtitles: subs });
    console.log(`J-SUB: [BRIDGE] Buffered ${subs.length} subtitles to storage.`);

    // Forward to background → side panel
    safeSendMessage({ action: "PRELOAD_SUBTITLES", subtitles: subs });
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