#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  JMDict Dictionary Builder                                       ║
 * ║                                                                  ║
 * ║  Downloads jmdict-eng-common from GitHub, processes it into a    ║
 * ║  compact lookup JSON keyed by kanji + kana readings.             ║
 * ║  Output: data/jmdict-lookup.json                                 ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Usage:  node tools/build-dict.js
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ═══════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════

const RELEASE_TAG = "3.6.2+20260629154100";
const FILE_NAME = `jmdict-eng-${RELEASE_TAG}.json`;
const ZIP_NAME = `${FILE_NAME}.zip`;
const DOWNLOAD_URL = `https://github.com/scriptin/jmdict-simplified/releases/download/${encodeURIComponent(RELEASE_TAG)}/${encodeURIComponent(ZIP_NAME)}`;

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const TEMP_DIR = path.join(ROOT_DIR, "tools", "_temp");
const OUTPUT_FILE = path.join(DATA_DIR, "jmdict-lookup.json");

// ═══════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/**
 * Downloads a file from a URL, following redirects (up to 10 hops).
 */
function downloadFile(url, destPath, maxRedirects = 10) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) {
            return reject(new Error("Too many redirects"));
        }

        const proto = url.startsWith("https") ? https : http;

        proto.get(url, { headers: { "User-Agent": "JMDict-Builder/1.0" } }, (res) => {
            // Handle redirects (GitHub releases redirect to S3)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                console.log(`  ↳ Redirecting (${res.statusCode})…`);
                return downloadFile(res.headers.location, destPath, maxRedirects - 1)
                    .then(resolve)
                    .catch(reject);
            }

            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
            }

            const total = parseInt(res.headers["content-length"], 10) || 0;
            let downloaded = 0;
            const file = fs.createWriteStream(destPath);

            res.on("data", (chunk) => {
                downloaded += chunk.length;
                if (total > 0) {
                    const pct = ((downloaded / total) * 100).toFixed(1);
                    process.stdout.write(`\r  Downloading: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
                }
            });

            res.pipe(file);
            file.on("finish", () => {
                file.close();
                console.log("\n  ✓ Download complete");
                resolve();
            });
            file.on("error", reject);
        }).on("error", reject);
    });
}

/**
 * Extracts a ZIP file using PowerShell (native on Windows).
 * Falls back to the 'unzip' command on Unix.
 */
async function extractZip(zipPath, destDir) {
    const { execSync } = require("child_process");
    ensureDir(destDir);

    if (process.platform === "win32") {
        execSync(
            `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`,
            { stdio: "inherit" }
        );
    } else {
        execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: "inherit" });
    }
}

// ═══════════════════════════════════════════════════════════════════
// Main Build Pipeline
// ═══════════════════════════════════════════════════════════════════

async function main() {
    console.log("╔════════════════════════════════════════╗");
    console.log("║  JMDict Offline Dictionary Builder     ║");
    console.log("╚════════════════════════════════════════╝\n");

    ensureDir(DATA_DIR);
    ensureDir(TEMP_DIR);

    const zipPath = path.join(TEMP_DIR, ZIP_NAME);

    // ── Step 1: Download ─────────────────────────────────────────
    if (fs.existsSync(zipPath)) {
        console.log("● ZIP already downloaded, skipping…");
    } else {
        console.log(`● Downloading: ${ZIP_NAME}`);
        console.log(`  From: ${DOWNLOAD_URL}`);
        await downloadFile(DOWNLOAD_URL, zipPath);
    }

    // ── Step 2: Extract ──────────────────────────────────────────
    console.log("\n● Extracting ZIP…");
    await extractZip(zipPath, TEMP_DIR);

    // Find the extracted JSON file
    const jsonFiles = fs.readdirSync(TEMP_DIR).filter(f => f.endsWith(".json"));
    if (jsonFiles.length === 0) {
        throw new Error("No JSON file found after extraction!");
    }
    const jsonPath = path.join(TEMP_DIR, jsonFiles[0]);
    console.log(`  ✓ Found: ${jsonFiles[0]}`);

    // ── Step 3: Parse & Process ──────────────────────────────────
    console.log("\n● Parsing JMDict JSON…");
    const rawData = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    const entries = rawData.words;
    console.log(`  ✓ Loaded ${entries.length} dictionary entries`);

    console.log("\n● Building lookup index…");
    const lookup = {};
    let totalKeys = 0;

    for (const entry of entries) {
        // Extract kanji forms
        const kanjiTexts = (entry.kanji || []).map(k => k.text);
        // Extract kana readings
        const kanaTexts = (entry.kana || []).map(k => k.text);

        // Extract sense data (meanings, parts of speech)
        const senses = (entry.sense || []).map(s => ({
            pos: (s.partOfSpeech || []).slice(0, 3), // Limit POS tags
            g: (s.gloss || []).map(g => g.text).slice(0, 5), // Limit glosses
        }));

        if (senses.length === 0) continue;

        // Build a compact entry object
        const compactEntry = {
            id: entry.id,
            k: kanjiTexts,           // Kanji forms
            r: kanaTexts,            // Kana readings
            s: senses,              // Senses [{pos, g}]
        };

        // Index by every kanji form
        for (const k of kanjiTexts) {
            if (!lookup[k]) lookup[k] = [];
            lookup[k].push(compactEntry);
            totalKeys++;
        }

        // Index by every kana reading
        for (const r of kanaTexts) {
            if (!lookup[r]) lookup[r] = [];
            // Avoid duplicating if kana === kanji
            if (!kanjiTexts.includes(r)) {
                lookup[r].push(compactEntry);
                totalKeys++;
            }
        }
    }

    console.log(`  ✓ Created ${Object.keys(lookup).length} unique keys (${totalKeys} total index entries)`);

    // ── Step 4: Write Output ─────────────────────────────────────
    console.log("\n● Writing lookup file…");
    const outputJson = JSON.stringify(lookup);
    fs.writeFileSync(OUTPUT_FILE, outputJson, "utf-8");

    const sizeMB = (Buffer.byteLength(outputJson) / 1024 / 1024).toFixed(2);
    console.log(`  ✓ Output: ${OUTPUT_FILE}`);
    console.log(`  ✓ Size: ${sizeMB} MB`);

    // ── Step 5: Cleanup ──────────────────────────────────────────
    console.log("\n● Cleaning up temp files…");
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    console.log("  ✓ Temp directory removed");

    console.log("\n╔════════════════════════════════════════╗");
    console.log("║  ✓ Dictionary build complete!          ║");
    console.log("╚════════════════════════════════════════╝");
}

main().catch((err) => {
    console.error("\n✗ Build failed:", err.message);
    process.exit(1);
});
