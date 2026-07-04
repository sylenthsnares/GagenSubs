/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  J-Sub Explainer Engine — Background Service Worker              ║
 * ║                                                                  ║
 * ║  Responsibilities:                                               ║
 * ║  1. Configure side panel to open on extension icon click         ║
 * ║  2. Relay messages between content script ↔ side panel           ║
 * ║  3. Clean up stale data on install/update                        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ═══════════════════════════════════════════════════════════════════
// §1. Side Panel Configuration
// ═══════════════════════════════════════════════════════════════════

chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(err => console.error("J-SUB: Side panel config error:", err));

// ═══════════════════════════════════════════════════════════════════
// §2. Lifecycle — Clean Up on Install / Update
// ═══════════════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install" || details.reason === "update") {
        // Clear stale subtitle cache from the previous session/version
        chrome.storage.local.remove(["cachedSubtitles"], () => {
            console.log("J-SUB: Cleared stale subtitle cache on", details.reason);
        });
    }
});

// ═══════════════════════════════════════════════════════════════════
// §3. Message Relay — Content Script ↔ Side Panel
// ═══════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only relay known action types to prevent unexpected message loops
    const RELAY_ACTIONS = ["PRELOAD_SUBTITLES", "ACTIVE_SUBTITLE"];

    if (RELAY_ACTIONS.includes(message.action)) {
        try {
            // Forward the message to all extension pages (including the side panel)
            chrome.runtime.sendMessage(message).catch(() => {
                // Side panel is not open or not listening — safe to ignore
            });
        } catch (e) {
            // Extension context invalidated (rare in background SW) — ignore
        }
    }

    // Return false: synchronous handling, no sendResponse needed
    return false;
});