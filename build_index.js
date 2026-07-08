import * as pagefind from "pagefind";
import fs from "fs";
import path from "path";
import {
    BUCKET_COUNT,
    DATA_PATH,
    buildMetaData,
    getBucketId,
    writeMetaBuckets
} from "./scripts/build_meta.js";

const PREPROCESS_CONCURRENCY = 64;
const INDEX_CONCURRENCY = 4;
const PAGEFIND_OUTPUT_ROOT = path.resolve("./public/pagefind");
const TEXT_DATA_OUTPUT_ROOT = path.resolve("./public/text-data");
const META_DATA_OUTPUT_ROOT = path.resolve("./public/meta-data");
const TEMP_INDEX_OUTPUT_ROOT = path.resolve("./.tmp-pagefind-html");
const LEGACY_CHUNK_OUTPUT_ROOT = path.resolve("./public/chunk");
const TEXTMAP_SOURCE_ROOT = path.resolve("./TextMap");
const READABLE_SOURCE_ROOT = path.resolve("./Readable");
const SUBTITLE_SOURCE_ROOT = path.resolve("./Subtitle");
const DEFAULT_LANGUAGE_IDS = ["chs", "en"];
const TEXTMAP_FILE_RE = /^TextMap(?:_Medium)?([A-Za-z]+)(?:_(\d+))?\.json$/;
const SUBTITLE_TIME_RE = /^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[,.]\d{3})$/;

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
    const suffixRegex = new RegExp(`_${languageId}(?=\\.[^.]+$)`, "i");
    return relativePath.replace(suffixRegex, "");
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

    const configsById = new Map(allLanguageConfigs.map((config) => [config.id, config]));
    const missingLanguageIds = requestedLanguageIds.filter((id) => !configsById.has(id));

    if (missingLanguageIds.length > 0) {
        throw new Error(`No TextMap files found for language(s): ${missingLanguageIds.join(", ")}`);
    }

    return requestedLanguageIds.map((id) => configsById.get(id));
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

function bucketEntries(entries, getBucketKey) {
    const buckets = Array.from({ length: BUCKET_COUNT }, () => []);

    for (const entry of entries) {
        const bucketId = getBucketId(String(getBucketKey(entry)));
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

function makeHeadingId(pagefindId) {
    return `hash-${encodeURIComponent(pagefindId)}`;
}

function buildSearchSection(record) {
    const headingId = makeHeadingId(record.pagefindId);
    const processedText = preprocessForCharacterSearch(record.searchText);

    return [
        "        <section>",
        `            <h2 id="${escapeHtml(headingId)}">${escapeHtml(record.titleText)}</h2>`,
        `            <p>${escapeHtml(processedText)}</p>`,
        "        </section>"
    ].join("\n");
}

async function buildIndexDocument(languageConfig, bucketId, bucketEntriesForLanguage) {
    const tempFilePath = path.join(languageConfig.tempIndexOutputDir, bucketId, "index.html");
    const sections = await mapWithConcurrency(
        bucketEntriesForLanguage,
        PREPROCESS_CONCURRENCY,
        async (entry) => buildSearchSection(entry)
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
    fs.rmSync(META_DATA_OUTPUT_ROOT, { force: true, recursive: true });
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

function parseSrtTimeToMs(value) {
    const normalized = String(value || "").trim().replace(",", ".");
    const match = normalized.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
    if (!match) {
        return 0;
    }

    const [, hh, mm, ss, ms] = match;
    return Number(hh) * 3600000 + Number(mm) * 60000 + Number(ss) * 1000 + Number(ms);
}

function makeSubtitleTimeKey(startMs, index) {
    return `${String(startMs).padStart(9, "0")}-${String(index + 1).padStart(4, "0")}`;
}

function loadFullTextMap(languageConfig) {
    const textMap = {};

    for (const sourceFile of languageConfig.sourceFiles) {
        const rawData = fs.readFileSync(sourceFile.filePath, "utf-8");
        const sourceRecords = JSON.parse(rawData);

        for (const [hash, text] of Object.entries(sourceRecords)) {
            textMap[String(hash)] = normalizeSourceText(text);
        }
    }

    return textMap;
}

function makeTextMapRecord(hash, text, metaData) {
    const talkId = metaData.primaryTalkByHash.get(hash);

    if (talkId !== undefined) {
        return {
            sourceType: "talk",
            pagefindId: `talk:${talkId}:${hash}`,
            textDataKey: hash,
            bucketKey: String(talkId),
            titleText: hash,
            searchText: text,
            text
        };
    }

    if (metaData.fetterMap.has(hash)) {
        return {
            sourceType: "fetter",
            pagefindId: `fetter:${hash}`,
            textDataKey: hash,
            bucketKey: `fetter:${hash}`,
            titleText: hash,
            searchText: text,
            text
        };
    }

    return {
        sourceType: "textmap",
        pagefindId: `textmap:${hash}`,
        textDataKey: hash,
        bucketKey: `textmap:${hash}`,
        titleText: hash,
        searchText: text,
        text
    };
}

function loadTextMapRecords(languageConfig, metaData) {
    const textMap = loadFullTextMap(languageConfig);
    const records = [];

    for (const [hash, text] of Object.entries(textMap)) {
        if (!text.trim()) {
            continue;
        }

        records.push(makeTextMapRecord(hash, text, metaData));
    }

    return { records, textMap };
}

function loadReadableRecords(languageConfig) {
    return listFilesRecursive(
        languageConfig.readableSourceDir,
        (filePath) => path.extname(filePath).toLowerCase() === ".txt"
    )
        .map((filePath) => {
            const relativePath = toPosixPath(path.relative(languageConfig.readableSourceDir, filePath));
            const normalizedPath = getNormalizedRelativePath(relativePath, languageConfig.id);
            const pagefindId = `readable:${normalizedPath}`;
            const text = normalizeSourceText(fs.readFileSync(filePath, "utf-8"));

            return {
                sourceType: "readable",
                pagefindId,
                textDataKey: pagefindId,
                bucketKey: pagefindId,
                titleText: "readable",
                searchText: text,
                text
            };
        })
        .filter((record) => record.text.trim());
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

            const timeRange = lines[timeLineIndex];
            const timeMatch = SUBTITLE_TIME_RE.exec(timeRange);
            if (!timeMatch) {
                return null;
            }

            const startMs = parseSrtTimeToMs(timeMatch[1]);
            return {
                sequence: lines[0] ?? "",
                timeRange,
                startMs,
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

        return segments.map((segment, index) => {
            const timeKey = makeSubtitleTimeKey(segment.startMs, index);
            const pagefindId = `subtitle:${normalizedPath}:${timeKey}`;

            return {
                sourceType: "subtitle",
                pagefindId,
                textDataKey: pagefindId,
                bucketKey: `subtitle:${normalizedPath}`,
                titleText: "subtitle",
                searchText: segment.text,
                text: segment.text
            };
        });
    }).filter((record) => record.text.trim());
}

function loadLanguageData(languageConfig, metaData) {
    const { records: textMapRecords, textMap } = loadTextMapRecords(languageConfig, metaData);
    const records = [
        ...textMapRecords,
        ...loadReadableRecords(languageConfig),
        ...loadSubtitleRecords(languageConfig)
    ];
    const uniqueRecordsById = new Map();

    for (const record of records) {
        if (record.text.trim()) {
            uniqueRecordsById.set(record.pagefindId, record);
        }
    }

    return {
        textMap,
        records: Array.from(uniqueRecordsById.values())
            .sort((left, right) => left.pagefindId.localeCompare(right.pagefindId))
    };
}

function addToTextBucket(buckets, record) {
    const bucketId = getBucketId(String(record.bucketKey));
    buckets[Number(bucketId)][record.textDataKey] = record.text;
}

function writeLookupTables(languageConfig, metaData, textMap) {
    const names = {};
    for (const hash of metaData.nameHashes) {
        if (textMap[hash]) {
            names[hash] = textMap[hash];
        }
    }

    const quests = {};
    for (const hash of metaData.questTitleHashes) {
        if (textMap[hash]) {
            quests[hash] = textMap[hash];
        }
    }

    const sourceTitles = {};
    for (const hash of metaData.sourceTitleHashes) {
        if (textMap[hash]) {
            sourceTitles[hash] = textMap[hash];
        }
    }

    fs.mkdirSync(languageConfig.textDataOutputDir, { recursive: true });
    fs.writeFileSync(
        path.join(languageConfig.textDataOutputDir, "names.json"),
        JSON.stringify(names),
        "utf-8"
    );
    fs.writeFileSync(
        path.join(languageConfig.textDataOutputDir, "quests.json"),
        JSON.stringify(quests),
        "utf-8"
    );
    fs.writeFileSync(
        path.join(languageConfig.textDataOutputDir, "source-titles.json"),
        JSON.stringify(sourceTitles),
        "utf-8"
    );
}

async function writeLanguageTextData(languageConfig, languageRecords, metaData) {
    const buckets = Array.from({ length: BUCKET_COUNT }, () => ({}));
    const redundantHashes = new Set();
    let redundantWriteCount = 0;
    const startedAt = Date.now();

    for (const record of languageRecords) {
        if (record.sourceType === "talk") {
            const textHash = record.textDataKey;
            const associatedTalkIds = metaData.hashToAllTalks.get(textHash);

            if (associatedTalkIds && associatedTalkIds.size > 0) {
                if (associatedTalkIds.size > 1) {
                    redundantHashes.add(textHash);
                    redundantWriteCount += associatedTalkIds.size - 1;
                    console.log(
                        `[redundant] textHash ${textHash} appears in ${associatedTalkIds.size} talks: `
                        + `${Array.from(associatedTalkIds).join(", ")} -> writing to ${associatedTalkIds.size} buckets`
                    );
                }

                for (const talkId of associatedTalkIds) {
                    addToTextBucket(buckets, {
                        ...record,
                        bucketKey: String(talkId),
                        textDataKey: textHash
                    });
                }
                continue;
            }
        }

        addToTextBucket(buckets, record);
    }

    const nonEmptyBuckets = buckets
        .map((entriesByKey, bucketIndex) => ({
            bucketId: String(bucketIndex).padStart(4, "0"),
            entries: Object.entries(entriesByKey).map(([hash, text]) => ({ hash, text }))
        }))
        .filter((bucket) => bucket.entries.length > 0);
    const bucketStats = summarizeBucketStats(nonEmptyBuckets, (entry) => entry.text);

    fs.mkdirSync(languageConfig.textDataOutputDir, { recursive: true });
    await mapWithConcurrency(
        nonEmptyBuckets,
        INDEX_CONCURRENCY,
        async (bucket, bucketIndex) => {
            const outputPath = path.join(languageConfig.textDataOutputDir, `${bucket.bucketId}.json`);
            const textMap = Object.fromEntries(bucket.entries.map((entry) => [entry.hash, entry.text]));
            fs.writeFileSync(outputPath, JSON.stringify(textMap), "utf-8");

            if ((bucketIndex + 1) % 100 === 0 || bucketIndex === nonEmptyBuckets.length - 1) {
                console.log(`[${languageConfig.id}] Wrote ${bucketIndex + 1} / ${nonEmptyBuckets.length} text-data buckets...`);
            }
        }
    );

    console.log(
        `[${languageConfig.id}] Text data buckets built in ${Date.now() - startedAt}ms `
        + `(buckets=${bucketStats.bucketCount}, entries min/median/p90/max: `
        + `${bucketStats.entriesPerBucket.min}/${bucketStats.entriesPerBucket.median}/${bucketStats.entriesPerBucket.p90}/${bucketStats.entriesPerBucket.max}, `
        + `chars min/median/p90/max: ${bucketStats.charsPerBucket.min}/${bucketStats.charsPerBucket.median}/${bucketStats.charsPerBucket.p90}/${bucketStats.charsPerBucket.max}).`
    );
    console.log(
        `[${languageConfig.id}] Redundancy summary: `
        + `${redundantHashes.size} unique hashes duplicated across multiple talks, `
        + `${redundantWriteCount} extra writes (total).`
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
    const { index } = await pagefind.createIndex({ forceLanguage: "en" });
    const searchableRecords = languageRecords.filter((record) => record.searchText.trim());
    const buckets = bucketEntries(searchableRecords, (record) => record.pagefindId);
    const bucketStats = summarizeBucketStats(buckets);

    console.log(`[${languageConfig.id}] Loaded ${searchableRecords.length} searchable records.`);
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

    console.log("Building meta-data...");
    const metaData = buildMetaData(DATA_PATH);

    console.log("Reading text sources...");
    const languageDataById = Object.fromEntries(
        languageConfigs.map((config) => [config.id, loadLanguageData(config, metaData)])
    );

    resetOutputDirs();
    writeMetaBuckets(metaData, META_DATA_OUTPUT_ROOT);
    writeTextDataManifest(languageConfigs);

    for (const languageConfig of languageConfigs) {
        const languageData = languageDataById[languageConfig.id];
        writeLookupTables(languageConfig, metaData, languageData.textMap);
        await writeLanguageTextData(languageConfig, languageData.records, metaData);
        await buildLanguageIndex(languageConfig, languageData.records);
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
