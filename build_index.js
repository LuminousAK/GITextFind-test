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
const TEXTMAP_SOURCE_ROOT = path.resolve("./TextMap");
const READABLE_SOURCE_ROOT = path.resolve("./Readable");
const SUBTITLE_SOURCE_ROOT = path.resolve("./Subtitle");
const DEFAULT_LANGUAGE_IDS = ["chs", "en"];
const TEXTMAP_FILE_RE = /^TextMap(?:_Medium)?([A-Za-z]+)(?:_(\d+))?\.json$/;
const SUBTITLE_TIME_RE = /\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/;

const LANGUAGE_LABELS = {
    chs: "简体中文",
    cht: "Traditional Chinese",
    de: "German",
    en: "English",
    es: "Spanish",
    fr: "French",
    id: "Indonesian",
    it: "Italian",
    jp: "Japanese",
    kr: "Korean",
    pt: "Portuguese",
    ru: "Russian",
    th: "Thai",
    tr: "Turkish",
    vi: "Vietnamese"
};

function normalizeLanguageId(value) {
    return String(value ?? "").trim().toLowerCase();
}

function toPosixPath(value) {
    return value.split(path.sep).join("/");
}

function getNormalizedRelativePath(relativePath, languageId) {
    const sufffixRegix = new RegExp(`_${languageId}(?=\\.[^.]+$)`, "i");
    return relativePath.replace(sufffixRegix, "");
}

function parseRequestedLanguageIds(argv) {
    if (argv.includes("--all-languages") || argv.includes("--all-langs")) {
        return null;
    }

    const languageArgIndex = argv.findIndex((arg) => (
        arg === "--languages"
        || arg === "--langs"
        || arg.startsWith("--languages=")
        || arg.startsWith("--langs=")
    ));

    if (languageArgIndex === -1) {
        return DEFAULT_LANGUAGE_IDS;
    }

    const languageArg = argv[languageArgIndex];
    const rawLanguages = languageArg.includes("=")
        ? languageArg.slice(languageArg.indexOf("=") + 1)
        : argv[languageArgIndex + 1] ?? "";
    const languageIds = rawLanguages
        .split(",")
        .map(normalizeLanguageId)
        .filter(Boolean);

    if (languageIds.length === 0) {
        throw new Error("No languages were provided. Use --languages=chs,en or --all-languages.");
    }

    return languageIds;
}

function compareTextMapFiles(left, right) {
    return (
        left.familyOrder - right.familyOrder
        || left.sequence - right.sequence
        || left.fileName.localeCompare(right.fileName)
    );
}

function discoverLanguageConfigs(requestedLanguageIds = DEFAULT_LANGUAGE_IDS) {
    const languagesById = new Map();

    function ensureLanguageConfig(id) {
        if (!languagesById.has(id)) {
            languagesById.set(id, {
                id,
                label: LANGUAGE_LABELS[id] ?? id.toUpperCase(),
                sourceFiles: []
            });
        }

        return languagesById.get(id);
    }

    if (fs.existsSync(TEXTMAP_SOURCE_ROOT)) {
        for (const fileName of fs.readdirSync(TEXTMAP_SOURCE_ROOT)) {
            const match = TEXTMAP_FILE_RE.exec(fileName);

            if (!match) {
                continue;
            }

            const id = normalizeLanguageId(match[1]);
            const isMedium = fileName.startsWith("TextMap_Medium");
            const sequence = match[2] === undefined ? -1 : Number(match[2]);

            ensureLanguageConfig(id).sourceFiles.push({
                fileName,
                filePath: path.join(TEXTMAP_SOURCE_ROOT, fileName),
                familyOrder: isMedium ? 1 : 0,
                sequence
            });
        }
    }

    for (const sourceRoot of [READABLE_SOURCE_ROOT, SUBTITLE_SOURCE_ROOT]) {
        if (!fs.existsSync(sourceRoot)) {
            continue;
        }

        for (const dirent of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
            if (dirent.isDirectory()) {
                ensureLanguageConfig(normalizeLanguageId(dirent.name));
            }
        }
    }

    const allLanguageConfigs = Array.from(languagesById.values())
        .map((config) => ({
            ...config,
            sourceFiles: config.sourceFiles.sort(compareTextMapFiles),
            readableSourceDir: path.join(READABLE_SOURCE_ROOT, config.id.toUpperCase()),
            subtitleSourceDir: path.join(SUBTITLE_SOURCE_ROOT, config.id.toUpperCase()),
            pagefindOutputDir: path.join(PAGEFIND_OUTPUT_ROOT, config.id),
            textDataOutputDir: path.join(TEXT_DATA_OUTPUT_ROOT, config.id),
            tempIndexOutputDir: path.join(TEMP_INDEX_OUTPUT_ROOT, config.id)
        }))
        .sort((left, right) => left.id.localeCompare(right.id));

    if (requestedLanguageIds === null) {
        return allLanguageConfigs;
    }

    const allLanguageConfigsById = new Map(allLanguageConfigs.map((config) => [config.id, config]));
    const missingLanguageIds = requestedLanguageIds.filter((id) => !allLanguageConfigsById.has(id));

    if (missingLanguageIds.length > 0) {
        throw new Error(`No TextMap files found for language(s): ${missingLanguageIds.join(", ")}`);
    }

    return requestedLanguageIds.map((id) => allLanguageConfigsById.get(id));
}

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
            const headingId = makeHeadingId(entry.hash);
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

function listFilesRecursive(rootDir, predicate = () => true) {
    if (!fs.existsSync(rootDir)) {
        return [];
    }

    const files = [];

    function visit(currentDir) {
        for (const dirent of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const fullPath = path.join(currentDir, dirent.name);

            if (dirent.isDirectory()) {
                visit(fullPath);
            } else if (dirent.isFile() && predicate(fullPath)) {
                files.push(fullPath);
            }
        }
    }

    visit(rootDir);
    return files.sort((left, right) => left.localeCompare(right));
}

function normalizeSourceText(value) {
    return String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/\\n/g, "\n")
        .trim();
}

function makeRecordId(sourceType, relativePath, suffix = "") {
    return suffix ? `${sourceType}:${relativePath}:${suffix}` : `${sourceType}:${relativePath}`;
}

function makeHeadingId(recordId) {
    return `hash-${encodeURIComponent(recordId)}`;
}

function loadTextMapRecords(languageConfig) {
    const records = [];

    for (const sourceFile of languageConfig.sourceFiles) {
        const rawData = fs.readFileSync(sourceFile.filePath, "utf-8");
        const sourceRecords = JSON.parse(rawData);

        for (const [hash, text] of Object.entries(sourceRecords)) {
            records.push({
                id: hash,
                sourceType: "textmap",
                text: normalizeSourceText(text)
            });
        }
    }

    return records;
}

function loadReadableRecords(languageConfig) {
    return listFilesRecursive(
        languageConfig.readableSourceDir,
        (filePath) => path.extname(filePath).toLowerCase() === ".txt"
    ).map((filePath) => {
        const relativePath = toPosixPath(path.relative(languageConfig.readableSourceDir, filePath));

        const normalizedPath = getNormalizedRelativePath(relativePath, languageConfig.id);
        
        return {
            id: makeRecordId("readable", normalizedPath),
            sourceType: "readable",
            text: normalizeSourceText(fs.readFileSync(filePath, "utf-8"))
        };
    });
}

function parseSubtitleSegments(content) {
    const normalized = normalizeSourceText(content);

    if (!normalized) {
        return [];
    }

    return normalized
        .split(/\n\s*\n/g)
        .map((block) => block.split("\n").map((line) => line.trim()).filter(Boolean))
        .map((lines) => {
            const timeLineIndex = lines.findIndex((line) => SUBTITLE_TIME_RE.test(line));

            if (timeLineIndex === -1) {
                return null;
            }

            const text = lines.slice(timeLineIndex + 1).join("\n").trim();

            if (!text) {
                return null;
            }

            const timeRange = lines[timeLineIndex]
            const timeMatch = timeRange.match(/^(\d{2}:\d{2}:\d{2})/);
            const timeKey = timeMatch ? timeMatch[1].replace(/:/g, "-") : "";

            return {
                sequence: lines[0] ?? "",
                timeRange,
                timeKey,
                text
            };
        })
        .filter(Boolean);
}

function loadSubtitleRecords(languageConfig) {
    return listFilesRecursive(
        languageConfig.subtitleSourceDir,
        (filePath) => path.extname(filePath).toLowerCase() === ".srt"
    ).flatMap((filePath) => {
        const relativePath = toPosixPath(path.relative(languageConfig.subtitleSourceDir, filePath));
        
        const normalizedPath = getNormalizedRelativePath(relativePath, languageConfig.id);
        
        const segments = parseSubtitleSegments(fs.readFileSync(filePath, "utf-8"));

        return segments.map((segment, index) => ({

            id: makeRecordId("subtitle", normalizedPath, String(segment.timeKey || index + 1).padStart(6, "0")),
            sourceType: "subtitle",
            text: segment.text
        }));
    });
}

function loadLanguageRecords(languageConfig) {
    const records = [
        ...loadTextMapRecords(languageConfig),
        ...loadReadableRecords(languageConfig),
        ...loadSubtitleRecords(languageConfig)
    ];

    const uniqueRecordsById = new Map();

    for (const record of records) {
        if (record.text.trim()) {
            uniqueRecordsById.set(record.id, record);
        }
    }

    return Array.from(uniqueRecordsById.values())
        .sort((left, right) => left.id.localeCompare(right.id));
}

function buildSearchEntries(languageRecords) {
    return languageRecords
        .map((record) => ({
            hash: record.id,
            searchText: String(record.text ?? "")
        }))
        .filter((entry) => entry.searchText.trim())
        .sort((left, right) => left.hash.localeCompare(right.hash));
}

async function writeLanguageTextData(languageConfig, languageRecords) {
    const entries = languageRecords
        .map((record) => ({
            hash: record.id,
            text: String(record.text ?? "")
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

function writeTextDataManifest(languageConfigs) {
    const manifest = {
        bucketCount: BUCKET_COUNT,
        pathTemplate: "text-data/{language}/{bucket}.json",
        languages: languageConfigs.map((config) => ({
            id: config.id,
            label: config.label,
            sourceFiles: config.sourceFiles.map((sourceFile) => sourceFile.fileName),
            readableSourceDir: fs.existsSync(config.readableSourceDir)
                ? toPosixPath(path.relative(process.cwd(), config.readableSourceDir))
                : null,
            subtitleSourceDir: fs.existsSync(config.subtitleSourceDir)
                ? toPosixPath(path.relative(process.cwd(), config.subtitleSourceDir))
                : null
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
    const requestedLanguageIds = parseRequestedLanguageIds(process.argv.slice(2));
    const languageConfigs = discoverLanguageConfigs(requestedLanguageIds);

    console.log(`Discovered ${languageConfigs.length} language(s): ${languageConfigs.map((config) => config.id).join(", ")}`);
    for (const languageConfig of languageConfigs) {
        console.log(
            `[${languageConfig.id}] TextMap files: `
            + languageConfig.sourceFiles.map((sourceFile) => sourceFile.fileName).join(", ")
        );
    }

    console.log("Reading text sources...");
    const languageRecordsById = Object.fromEntries(
        languageConfigs.map((config) => [config.id, loadLanguageRecords(config)])
    );

    resetOutputDirs();
    writeTextDataManifest(languageConfigs);

    for (const languageConfig of languageConfigs) {
        await writeLanguageTextData(languageConfig, languageRecordsById[languageConfig.id]);
        await buildLanguageIndex(languageConfig, languageRecordsById[languageConfig.id]);
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
