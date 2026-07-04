/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  J-Sub Explainer Engine — Network Interceptor                   ║
 * ║  World: MAIN (runs in Netflix's page context)                   ║
 * ║                                                                  ║
 * ║  Monkey-patches fetch() and XMLHttpRequest to intercept          ║
 * ║  Netflix subtitle payloads (TTML / DFXP / XML / VTT).           ║
 * ║  Parsed subtitles are sent to the content script bridge          ║
 * ║  via window.postMessage.                                         ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

console.log("J-SUB: [INIT] Hybrid Interceptor Active (Fetch + XHR)");

// ═══════════════════════════════════════════════════════════════════
// §1. Text Cleaning Utilities
// ═══════════════════════════════════════════════════════════════════

/**
 * Strips residual HTML/XML tags, invisible Unicode characters,
 * and collapses whitespace from raw subtitle text.
 */
function cleanSubtitleText(raw) {
    if (!raw) return "";
    return raw
        // Remove any leftover HTML/XML tags (e.g. <br>, <span class="...">)
        .replace(/<[^>]*>/g, "")
        // Remove zero-width joiners, BOM, non-breaking spaces, word joiners
        .replace(/[\u200B\u200C\u200D\uFEFF\u00A0\u2060\u2028\u2029]/g, "")
        // Collapse all whitespace (including newlines) to a single space
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Deduplicates an array of subtitle objects by their text content.
 * Netflix frequently sends overlapping/duplicate cues.
 */
function deduplicateSubs(subs) {
    const seen = new Set();
    return subs.filter(s => {
        if (seen.has(s.text)) return false;
        seen.add(s.text);
        return true;
    });
}

// ═══════════════════════════════════════════════════════════════════
// §2. Core Subtitle Parser
// ═══════════════════════════════════════════════════════════════════

/**
 * Detects the subtitle format and parses it into a clean array
 * of { text, begin?, end? } objects.
 *
 * Supported formats:
 *   - TTML / DFXP / generic XML (namespace-aware)
 *   - WebVTT (with multi-line cue support)
 */
function processSubtitles(data) {
    let subs = [];

    try {
        // ── Detect XML-based formats (TTML, DFXP) ──────────────
        if (data.includes("<tt") || data.includes("<?xml") || data.includes("xmlns")) {
            subs = parseTTML(data);
        }
        // ── Detect WebVTT ───────────────────────────────────────
        else if (data.includes("WEBVTT")) {
            subs = parseVTT(data);
        }

        // Deduplicate and dispatch
        subs = deduplicateSubs(subs);

        if (subs.length > 0) {
            console.log(`J-SUB: [OK] Parsed ${subs.length} unique subtitle cues`);
            window.postMessage({ type: "J_SUB_FULL_TRACK", subtitles: subs }, "*");
        }
    } catch (err) {
        console.error("J-SUB: [ERROR] Subtitle parsing failed:", err);
    }
}

/**
 * Parses TTML / DFXP / namespaced XML subtitle documents.
 * Uses namespace-wildcard searches to handle all Netflix variants:
 *   <p>, <tt:p>, <ttml:p>, etc.
 */
function parseTTML(data) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(data, "text/xml");

    // Check for XML parse errors — fall back to HTML parser if broken
    const parseError = doc.querySelector("parsererror");
    if (parseError) {
        console.warn("J-SUB: XML parse error detected, attempting HTML fallback...");
        const htmlDoc = parser.parseFromString(data, "text/html");
        return Array.from(htmlDoc.querySelectorAll("p"))
            .map(p => ({ text: cleanSubtitleText(p.textContent) }))
            .filter(s => s.text.length > 0);
    }

    // Namespace-aware: getElementsByTagNameNS("*", "p") catches ALL namespace variants
    let elements = doc.getElementsByTagNameNS("*", "p");

    // Some DFXP formats use <div> as the cue container instead of <p>
    if (elements.length === 0) {
        elements = doc.getElementsByTagNameNS("*", "div");
    }

    return Array.from(elements)
        .map(el => {
            // Extract timing data for potential future use
            const begin = el.getAttribute("begin") || "";
            const end = el.getAttribute("end") || "";

            // Handle nested <span> elements (Netflix wraps text in <tt:span> sometimes)
            const spans = el.getElementsByTagNameNS("*", "span");
            let text;
            if (spans.length > 0) {
                // Concatenate all span text content
                text = Array.from(spans).map(s => s.textContent).join("");
            } else {
                text = el.textContent;
            }

            return { text: cleanSubtitleText(text), begin, end };
        })
        .filter(s => s.text.length > 0);
}

/**
 * Parses WebVTT subtitle files.
 * Properly handles:
 *   - Multi-line cues (joins text between timestamps)
 *   - VTT formatting tags (<c>, <i>, <b>, <u>, <ruby>, <rt>, <v>, <lang>)
 *   - Cue identifiers, NOTE blocks, STYLE blocks
 */
function parseVTT(data) {
    const subs = [];
    // Split into cue blocks on blank lines
    const blocks = data.split(/\n\s*\n/);

    for (const block of blocks) {
        const lines = block.split("\n").map(l => l.trim());

        // Skip header, metadata, NOTE, and STYLE blocks
        if (
            lines[0] === "WEBVTT" ||
            lines[0].startsWith("NOTE") ||
            lines[0].startsWith("STYLE") ||
            lines[0].startsWith("REGION")
        ) {
            continue;
        }

        // Locate the timestamp line (contains "-->")
        let timestampIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes("-->")) {
                timestampIdx = i;
                break;
            }
        }

        // No timestamp found → not a valid cue block
        if (timestampIdx === -1) continue;

        // Everything after the timestamp is subtitle text
        const textLines = lines.slice(timestampIdx + 1).filter(l => l.length > 0);
        if (textLines.length === 0) continue;

        // Join multi-line cues into a single string
        let cueText = textLines.join(" ");

        // Strip VTT formatting tags: <c>, <i>, <b>, <u>, <ruby>, <rt>, <v Name>, <lang xx>
        cueText = cueText.replace(/<\/?(?:c|i|b|u|ruby|rt|v|lang)[^>]*>/gi, "");

        const cleaned = cleanSubtitleText(cueText);
        if (cleaned.length > 0) {
            subs.push({ text: cleaned });
        }
    }

    return subs;
}

// ═══════════════════════════════════════════════════════════════════
// §3. Network Interception — Fetch API
// ═══════════════════════════════════════════════════════════════════

const originalFetch = window.fetch;

window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
        // Clone the response so the original stream remains consumable
        const clone = response.clone();
        clone.text().then(text => {
            if (
                text &&
                (text.includes("<?xml") ||
                 text.includes("<tt") ||
                 text.includes("WEBVTT") ||
                 text.includes("xmlns"))
            ) {
                console.log("J-SUB: [CATCH] Subtitle data intercepted via Fetch");
                processSubtitles(text);
            }
        }).catch(() => {
            // Non-text response (binary, media stream) — safely ignore
        });
    } catch (e) {
        // Clone failed — response may have been consumed already
    }

    return response;
};

// ═══════════════════════════════════════════════════════════════════
// §4. Network Interception — XMLHttpRequest
// ═══════════════════════════════════════════════════════════════════

const originalXHROpen = XMLHttpRequest.prototype.open;
const originalXHRSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method, url) {
    this._jsubUrl = url; // Store URL for debugging
    return originalXHROpen.apply(this, arguments);
};

XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener("load", function () {
        try {
            const text = this.responseText;
            if (
                text &&
                (text.includes("<?xml") ||
                 text.includes("<tt") ||
                 text.includes("WEBVTT") ||
                 text.includes("xmlns"))
            ) {
                console.log("J-SUB: [CATCH] Subtitle data intercepted via XHR");
                processSubtitles(text);
            }
        } catch (e) {
            // responseText access failed — safe to ignore
        }
    });
    return originalXHRSend.apply(this, arguments);
};