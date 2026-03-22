import * as pagefind from "pagefind";
import fs from "fs";
import path from "path";

const BUCKET_COUNT = 1024;
const PREPROCESS_CONCURRENCY = 64;
const INDEX_CONCURRENCY = 4;
const PAGEFIND_OUTPUT_ROOT = path.resolve("./public/pagefind");
const CHUNK_OUTPUT_ROOT = path.resolve("./public/chunk");

const LANGUAGE_CONFIGS = [
    {
        id: "chs",
        label: "简体中文",
        sourceFile: "TextMapCHS.json",
        pagefindOutputDir: path.join(PAGEFIND_OUTPUT_ROOT, "chs"),
        chunkOutputDir: path.join(CHUNK_OUTPUT_ROOT, "chs")
    },
    {
        id: "en",
        label: "English",
        sourceFile: "TextMapEN.json",
        pagefindOutputDir: path.join(PAGEFIND_OUTPUT_ROOT, "en"),
        chunkOutputDir: path.join(CHUNK_OUTPUT_ROOT, "en")
    }
];

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
        const entities = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "\"": "&quot;",
            "'": "&#39;"
        };

        return entities[char];
    });
}

function preprocessForCharacterSearch(input) {
    const normalized = String(input ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/\s+/g, " ")
        .trim();

    let output = "";
    let previousWasCjk = false;

    for (const char of normalized) {
        if (char === " ") {
            if (output && output[output.length - 1] !== " ") {
                output += " ";
            }

            previousWasCjk = false;
            continue;
        }

        const isCjk = /\p{Script=Han}/u.test(char);

        if (isCjk) {
            if (output && output[output.length - 1] !== " ") {
                output += " ";
            }

            output += char;
            output += " ";
            previousWasCjk = true;
            continue;
        }

        if (previousWasCjk && output && output[output.length - 1] !== " ") {
            output += " ";
        }

        output += char;
        previousWasCjk = false;
    }

    return output.replace(/\s+/g, " ").trim();
}

function getBucketId(hash) {
    let mixedHash = 0x811c9dc5;

    for (let index = 0; index < hash.length; index += 1) {
        mixedHash ^= hash.charCodeAt(index);
        mixedHash = Math.imul(mixedHash, 0x01000193);
    }

    return String((mixedHash >>> 0) % BUCKET_COUNT).padStart(4, "0");
}

function bucketEntries(entries) {
    const buckets = Array.from({ length: BUCKET_COUNT }, () => []);

    for (const entry of entries) {
        const { hash } = entry;
        const bucketId = getBucketId(hash);

        buckets[Number(bucketId)].push(entry);
    }

    return buckets
        .map((entriesForBucket, bucketIndex) => ({
            bucketId: String(bucketIndex).padStart(4, "0"),
            entries: entriesForBucket
        }))
        .filter((bucket) => bucket.entries.length > 0);
}

function summarizeBucketStats(buckets) {
    const entryCounts = buckets.map((bucket) => bucket.entries.length).sort((left, right) => left - right);
    const charCounts = buckets
        .map((bucket) => bucket.entries.reduce((sum, entry) => sum + String(entry.searchText ?? "").length, 0))
        .sort((left, right) => left - right);
    const percentile = (values, rate) => values[Math.floor((values.length - 1) * rate)];

    return {
        bucketCount: buckets.length,
        entriesPerBucket: {
            min: entryCounts[0],
            median: percentile(entryCounts, 0.5),
            p90: percentile(entryCounts, 0.9),
            max: entryCounts[entryCounts.length - 1]
        },
        charsPerBucket: {
            min: charCounts[0],
            median: percentile(charCounts, 0.5),
            p90: percentile(charCounts, 0.9),
            max: charCounts[charCounts.length - 1]
        }
    };
}

async function mapWithConcurrency(items, concurrency, iteratee) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const currentIndex = nextIndex;
            nextIndex += 1;

            if (currentIndex >= items.length) {
                return;
            }

            results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
        }
    }

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
}

function buildChunkPage({ chunkId, languageLabel, sections }) {
    const title = `Chunk ${chunkId} (${languageLabel})`;

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
        body {
            margin: 0;
            font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            color: #2a241f;
            background: #f5efe6;
        }

        main {
            width: min(960px, calc(100vw - 32px));
            margin: 32px auto;
            padding: 24px;
            border-radius: 20px;
            background: rgba(255, 252, 248, 0.96);
            box-shadow: 0 18px 48px rgba(69, 44, 28, 0.12);
        }

        h1 {
            margin: 0 0 12px;
            font-size: 2rem;
        }

        .lead {
            margin: 0 0 24px;
            color: #6f6053;
        }

        section {
            padding: 16px 0;
            border-top: 1px solid rgba(69, 44, 28, 0.12);
        }

        section:first-of-type {
            border-top: 0;
        }

        h2 {
            margin: 0 0 10px;
            font-size: 1.05rem;
        }

        p {
            margin: 0;
            line-height: 1.8;
            word-break: break-word;
        }

        .text-row + .text-row {
            margin-top: 6px;
        }

        .text-label {
            font-weight: 700;
            color: #7a5538;
        }

        .indexed-text {
            margin-top: 4px;
            max-height: 0;
            overflow: hidden;
            color: transparent;
            font-size: 1px;
            line-height: 1;
            user-select: none;
            pointer-events: none;
        }
    </style>
</head>
<body>
    <main>
        <h1>${escapeHtml(title)}</h1>
        <p class="lead">This chunk contains ${sections.length} merged hash records for Pagefind.</p>
        <div data-pagefind-body>
${sections.join("\n")}
        </div>
    </main>
</body>
</html>`;
}

async function buildChunkDocument(languageConfig, chunkId, chunkEntries) {
    const chunkUrl = `/chunk/${languageConfig.id}/${chunkId}/`;
    const chunkDir = path.join(languageConfig.chunkOutputDir, chunkId);
    const chunkFilePath = path.join(chunkDir, "index.html");

    const sections = await mapWithConcurrency(
        chunkEntries,
        PREPROCESS_CONCURRENCY,
        async (entry) => {
            const headingId = `hash-${entry.hash}`;
            const processedText = preprocessForCharacterSearch(entry.searchText);
            const originalTextChs = String(entry.texts.chs ?? "");
            const originalTextEn = String(entry.texts.en ?? "");

            return [
                `            <section data-hash="${escapeHtml(entry.hash)}">`,
                `                <h2 id="${escapeHtml(headingId)}">${escapeHtml(entry.hash)}</h2>`,
                `                <p class="text-row" data-original-text-chs><span class="text-label">简体中文:</span> ${escapeHtml(originalTextChs)}</p>`,
                `                <p class="text-row" data-original-text-en><span class="text-label">English:</span> ${escapeHtml(originalTextEn)}</p>`,
                `                <p class="indexed-text" aria-hidden="true">${escapeHtml(processedText)}</p>`,
                "            </section>"
            ].join("\n");
        }
    );

    const html = buildChunkPage({
        chunkId,
        languageLabel: languageConfig.label,
        sections
    });

    return {
        chunkId,
        chunkUrl,
        chunkFilePath,
        html
    };
}

function resetOutputDirs() {
    fs.rmSync(PAGEFIND_OUTPUT_ROOT, { force: true, recursive: true });
    fs.rmSync(CHUNK_OUTPUT_ROOT, { force: true, recursive: true });
    fs.mkdirSync(PAGEFIND_OUTPUT_ROOT, { recursive: true });
    fs.mkdirSync(CHUNK_OUTPUT_ROOT, { recursive: true });
}

function loadLanguageRecordMap(sourceFile) {
    const rawData = fs.readFileSync(sourceFile, "utf-8");
    return JSON.parse(rawData);
}

function buildCombinedEntries(languageMaps, searchLanguageId) {
    const allHashes = new Set();

    for (const records of Object.values(languageMaps)) {
        for (const hash of Object.keys(records)) {
            allHashes.add(hash);
        }
    }

    return Array.from(allHashes)
        .sort()
        .map((hash) => ({
            hash,
            searchText: String(languageMaps[searchLanguageId]?.[hash] ?? ""),
            texts: {
                chs: String(languageMaps.chs?.[hash] ?? ""),
                en: String(languageMaps.en?.[hash] ?? "")
            }
        }));
}

async function buildLanguageIndex(languageConfig, languageMaps) {
    const buildStartedAt = Date.now();
    const { index } = await pagefind.createIndex({
        forceLanguage: "en"
    });

    const entries = buildCombinedEntries(languageMaps, languageConfig.id);
    const buckets = bucketEntries(entries);
    const bucketStats = summarizeBucketStats(buckets);

    console.log(`[${languageConfig.id}] Loaded ${entries.length} combined records.`);
    console.log(
        `[${languageConfig.id}] Building ${bucketStats.bucketCount} hash-addressable buckets with BUCKET_COUNT=${BUCKET_COUNT} `
        + `(entries min/median/p90/max: ${bucketStats.entriesPerBucket.min}/${bucketStats.entriesPerBucket.median}/${bucketStats.entriesPerBucket.p90}/${bucketStats.entriesPerBucket.max}, `
        + `chars min/median/p90/max: ${bucketStats.charsPerBucket.min}/${bucketStats.charsPerBucket.median}/${bucketStats.charsPerBucket.p90}/${bucketStats.charsPerBucket.max}).`
    );

    const preprocessStartedAt = Date.now();
    const chunkDocuments = await mapWithConcurrency(
        buckets,
        INDEX_CONCURRENCY,
        async (bucket, chunkIndex) => {
            const document = await buildChunkDocument(languageConfig, bucket.bucketId, bucket.entries);

            if ((chunkIndex + 1) % 100 === 0 || chunkIndex === buckets.length - 1) {
                console.log(`[${languageConfig.id}] Prepared ${chunkIndex + 1} / ${buckets.length} chunk documents...`);
            }

            return document;
        }
    );

    console.log(`[${languageConfig.id}] Preprocessing finished in ${Date.now() - preprocessStartedAt}ms.`);

    const writeStartedAt = Date.now();
    await mapWithConcurrency(
        chunkDocuments,
        INDEX_CONCURRENCY,
        async (document, chunkIndex) => {
            fs.mkdirSync(path.dirname(document.chunkFilePath), { recursive: true });
            fs.writeFileSync(document.chunkFilePath, document.html, "utf-8");

            await index.addHTMLFile({
                sourcePath: `chunk/${languageConfig.id}/${document.chunkId}/index.html`,
                content: document.html
            });

            if ((chunkIndex + 1) % 100 === 0 || chunkIndex === chunkDocuments.length - 1) {
                console.log(`[${languageConfig.id}] Indexed ${chunkIndex + 1} / ${chunkDocuments.length} chunk documents...`);
            }
        }
    );

    console.log(`[${languageConfig.id}] Chunk pages and in-memory index built in ${Date.now() - writeStartedAt}ms.`);

    await index.writeFiles({ outputPath: languageConfig.pagefindOutputDir });
    await index.deleteIndex();

    console.log(`[${languageConfig.id}] Pagefind index built in ${Date.now() - buildStartedAt}ms total.`);
}

async function buildAllIndexes() {
    console.log("Reading language JSON files...");
    const languageMaps = Object.fromEntries(
        LANGUAGE_CONFIGS.map((config) => [config.id, loadLanguageRecordMap(config.sourceFile)])
    );

    resetOutputDirs();

    for (const languageConfig of LANGUAGE_CONFIGS) {
        await buildLanguageIndex(languageConfig, languageMaps);
    }

    await pagefind.close();
}

buildAllIndexes().catch(async (error) => {
    console.error(error);

    try {
        await pagefind.close();
    } catch (closeError) {
        console.error(closeError);
    }

    process.exitCode = 1;
});
