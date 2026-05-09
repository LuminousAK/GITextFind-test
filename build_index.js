import * as pagefind from "pagefind";
import fs from "fs";
import path from "path";

const BUCKET_COUNT = 512;
const PREPROCESS_CONCURRENCY = 64;
const INDEX_CONCURRENCY = 4;
const PAGEFIND_OUTPUT_ROOT = path.resolve("./public/pagefind");
const TEXT_DATA_OUTPUT_ROOT = path.resolve("./public/text-data");
const TEMP_INDEX_OUTPUT_ROOT = path.resolve("./.tmp-pagefind-html");
const LEGACY_CHUNK_OUTPUT_ROOT = path.resolve("./public/chunk");

const LANGUAGE_CONFIGS = [
    {
        id: "chs",
        label: "简体中文",
        sourceFile: "TextMapCHS.json"
    },
    {
        id: "en",
        label: "English",
        sourceFile: "TextMapEN.json"
    }
].map((config) => ({
    ...config,
    pagefindOutputDir: path.join(PAGEFIND_OUTPUT_ROOT, config.id),
    textDataOutputDir: path.join(TEXT_DATA_OUTPUT_ROOT, config.id),
    tempIndexOutputDir: path.join(TEMP_INDEX_OUTPUT_ROOT, config.id)
}));

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

    const isHan = (char) => /\p{Script=Han}/u.test(char);
    const isPunctuation = (char) => /\p{P}/u.test(char);
    const isNonSpaceNonHan = (char) => Boolean(char) && char !== " " && !isHan(char);
    const isSearchableNonHan = (char) => Boolean(char) && char !== " " && !isPunctuation(char) && !isHan(char);

    let output = "";

    for (let index = 0; index < normalized.length; index += 1) {
        const char = normalized[index];

        if (char === " ") {
            if (output && output[output.length - 1] !== " ") {
                output += " ";
            }

            continue;
        }

        output += char;

        const nextChar = normalized[index + 1] ?? "";
        const needsSeparator = (
            (isHan(char) && isHan(nextChar))
            || (isHan(char) && isSearchableNonHan(nextChar))
            || (isNonSpaceNonHan(char) && isHan(nextChar))
        );

        if (needsSeparator && output[output.length - 1] !== " ") {
            output += " ";
        }
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
        const bucketId = getBucketId(entry.hash);
        buckets[Number(bucketId)].push(entry);
    }

    return buckets
        .map((entriesForBucket, bucketIndex) => ({
            bucketId: String(bucketIndex).padStart(4, "0"),
            entries: entriesForBucket
        }))
        .filter((bucket) => bucket.entries.length > 0);
}

function summarizeBucketStats(buckets, getText = (entry) => entry.searchText) {
    const entryCounts = buckets.map((bucket) => bucket.entries.length).sort((left, right) => left - right);
    const charCounts = buckets
        .map((bucket) => bucket.entries.reduce((sum, entry) => sum + String(getText(entry) ?? "").length, 0))
        .sort((left, right) => left - right);
    const percentile = (values, rate) => values[Math.floor((values.length - 1) * rate)] ?? 0;

    return {
        bucketCount: buckets.length,
        entriesPerBucket: {
            min: entryCounts[0] ?? 0,
            median: percentile(entryCounts, 0.5),
            p90: percentile(entryCounts, 0.9),
            max: entryCounts[entryCounts.length - 1] ?? 0
        },
        charsPerBucket: {
            min: charCounts[0] ?? 0,
            median: percentile(charCounts, 0.5),
            p90: percentile(charCounts, 0.9),
            max: charCounts[charCounts.length - 1] ?? 0
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

function buildIndexPage({ chunkId, languageLabel, sections }) {
    const title = `Index ${chunkId} (${languageLabel})`;

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
</head>
<body>
    <main data-pagefind-body>
        <h1>${escapeHtml(title)}</h1>
${sections.join("\n")}
    </main>
</body>
</html>`;
}

async function buildIndexDocument(languageConfig, bucketId, bucketEntriesForLanguage) {
    const tempFilePath = path.join(languageConfig.tempIndexOutputDir, bucketId, "index.html");

    const sections = await mapWithConcurrency(
        bucketEntriesForLanguage,
        PREPROCESS_CONCURRENCY,
        async (entry) => {
            const headingId = `hash-${entry.hash}`;
            const processedText = preprocessForCharacterSearch(entry.searchText);

            return [
                `        <section data-hash="${escapeHtml(entry.hash)}">`,
                `            <h2 id="${escapeHtml(headingId)}">${escapeHtml(entry.hash)}</h2>`,
                `            <p>${escapeHtml(processedText)}</p>`,
                "        </section>"
            ].join("\n");
        }
    );

    return {
        bucketId,
        sourcePath: `index-source/${languageConfig.id}/${bucketId}/index.html`,
        tempFilePath,
        html: buildIndexPage({
            chunkId: bucketId,
            languageLabel: languageConfig.label,
            sections
        })
    };
}

function resetOutputDirs() {
    fs.rmSync(PAGEFIND_OUTPUT_ROOT, { force: true, recursive: true });
    fs.rmSync(TEXT_DATA_OUTPUT_ROOT, { force: true, recursive: true });
    fs.rmSync(TEMP_INDEX_OUTPUT_ROOT, { force: true, recursive: true });
    fs.rmSync(LEGACY_CHUNK_OUTPUT_ROOT, { force: true, recursive: true });
    fs.mkdirSync(PAGEFIND_OUTPUT_ROOT, { recursive: true });
    fs.mkdirSync(TEXT_DATA_OUTPUT_ROOT, { recursive: true });
    fs.mkdirSync(TEMP_INDEX_OUTPUT_ROOT, { recursive: true });
}

function loadLanguageRecordMap(sourceFile) {
    const rawData = fs.readFileSync(sourceFile, "utf-8");
    return JSON.parse(rawData);
}

function buildSearchEntries(languageRecords) {
    return Object.entries(languageRecords)
        .map(([hash, searchText]) => ({
            hash,
            searchText: String(searchText ?? "")
        }))
        .filter((entry) => entry.searchText.trim())
        .sort((left, right) => left.hash.localeCompare(right.hash));
}

async function writeLanguageTextData(languageConfig, languageRecords) {
    const entries = Object.entries(languageRecords)
        .map(([hash, text]) => ({
            hash,
            text: String(text ?? "")
        }))
        .sort((left, right) => left.hash.localeCompare(right.hash));
    const buckets = bucketEntries(entries);
    const bucketStats = summarizeBucketStats(buckets, (entry) => entry.text);
    const startedAt = Date.now();

    fs.mkdirSync(languageConfig.textDataOutputDir, { recursive: true });

    await mapWithConcurrency(
        buckets,
        INDEX_CONCURRENCY,
        async (bucket, bucketIndex) => {
            const textMap = Object.fromEntries(bucket.entries.map((entry) => [entry.hash, entry.text]));
            const outputPath = path.join(languageConfig.textDataOutputDir, `${bucket.bucketId}.json`);

            fs.writeFileSync(outputPath, JSON.stringify(textMap), "utf-8");

            if ((bucketIndex + 1) % 100 === 0 || bucketIndex === buckets.length - 1) {
                console.log(`[${languageConfig.id}] Wrote ${bucketIndex + 1} / ${buckets.length} text-data buckets...`);
            }
        }
    );

    console.log(
        `[${languageConfig.id}] Text data buckets built in ${Date.now() - startedAt}ms `
        + `(buckets=${bucketStats.bucketCount}, entries min/median/p90/max: `
        + `${bucketStats.entriesPerBucket.min}/${bucketStats.entriesPerBucket.median}/${bucketStats.entriesPerBucket.p90}/${bucketStats.entriesPerBucket.max}, `
        + `chars min/median/p90/max: ${bucketStats.charsPerBucket.min}/${bucketStats.charsPerBucket.median}/${bucketStats.charsPerBucket.p90}/${bucketStats.charsPerBucket.max}).`
    );
}

function writeTextDataManifest() {
    const manifest = {
        bucketCount: BUCKET_COUNT,
        pathTemplate: "text-data/{language}/{bucket}.json",
        languages: LANGUAGE_CONFIGS.map((config) => ({
            id: config.id,
            label: config.label,
            sourceFile: config.sourceFile
        }))
    };

    fs.writeFileSync(
        path.join(TEXT_DATA_OUTPUT_ROOT, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf-8"
    );
}

async function buildLanguageIndex(languageConfig, languageRecords) {
    const buildStartedAt = Date.now();
    const { index } = await pagefind.createIndex({
        forceLanguage: "en"
    });

    const entries = buildSearchEntries(languageRecords);
    const buckets = bucketEntries(entries);
    const bucketStats = summarizeBucketStats(buckets);

    console.log(`[${languageConfig.id}] Loaded ${entries.length} searchable records.`);
    console.log(
        `[${languageConfig.id}] Building ${bucketStats.bucketCount} pure HTML index buckets with BUCKET_COUNT=${BUCKET_COUNT} `
        + `(entries min/median/p90/max: ${bucketStats.entriesPerBucket.min}/${bucketStats.entriesPerBucket.median}/${bucketStats.entriesPerBucket.p90}/${bucketStats.entriesPerBucket.max}, `
        + `chars min/median/p90/max: ${bucketStats.charsPerBucket.min}/${bucketStats.charsPerBucket.median}/${bucketStats.charsPerBucket.p90}/${bucketStats.charsPerBucket.max}).`
    );

    const preprocessStartedAt = Date.now();
    const indexDocuments = await mapWithConcurrency(
        buckets,
        INDEX_CONCURRENCY,
        async (bucket, bucketIndex) => {
            const document = await buildIndexDocument(languageConfig, bucket.bucketId, bucket.entries);

            if ((bucketIndex + 1) % 100 === 0 || bucketIndex === buckets.length - 1) {
                console.log(`[${languageConfig.id}] Prepared ${bucketIndex + 1} / ${buckets.length} index documents...`);
            }

            return document;
        }
    );

    console.log(`[${languageConfig.id}] Preprocessing finished in ${Date.now() - preprocessStartedAt}ms.`);

    const indexStartedAt = Date.now();
    await mapWithConcurrency(
        indexDocuments,
        INDEX_CONCURRENCY,
        async (document, documentIndex) => {
            fs.mkdirSync(path.dirname(document.tempFilePath), { recursive: true });
            fs.writeFileSync(document.tempFilePath, document.html, "utf-8");

            await index.addHTMLFile({
                sourcePath: document.sourcePath,
                content: document.html
            });

            if ((documentIndex + 1) % 100 === 0 || documentIndex === indexDocuments.length - 1) {
                console.log(`[${languageConfig.id}] Indexed ${documentIndex + 1} / ${indexDocuments.length} documents...`);
            }
        }
    );

    console.log(`[${languageConfig.id}] In-memory index built in ${Date.now() - indexStartedAt}ms.`);

    await index.writeFiles({ outputPath: languageConfig.pagefindOutputDir });
    await index.deleteIndex();

    fs.rmSync(languageConfig.tempIndexOutputDir, { force: true, recursive: true });

    console.log(`[${languageConfig.id}] Pagefind index built in ${Date.now() - buildStartedAt}ms total.`);
}

async function buildAllIndexes() {
    console.log("Reading language JSON files...");
    const languageMaps = Object.fromEntries(
        LANGUAGE_CONFIGS.map((config) => [config.id, loadLanguageRecordMap(config.sourceFile)])
    );

    resetOutputDirs();
    writeTextDataManifest();

    for (const languageConfig of LANGUAGE_CONFIGS) {
        await writeLanguageTextData(languageConfig, languageMaps[languageConfig.id]);
        await buildLanguageIndex(languageConfig, languageMaps[languageConfig.id]);
    }

    fs.rmSync(TEMP_INDEX_OUTPUT_ROOT, { force: true, recursive: true });
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
