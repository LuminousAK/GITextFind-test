import * as pagefind from "pagefind";
import fs from "fs";
import path from "path";

import { BUCKET_COUNT } from "../build_meta.js";
import { INDEX_CONCURRENCY, PREPROCESS_CONCURRENCY } from "./config.js";
import { bucketEntries, mapWithConcurrency, summarizeBucketStats } from "./pipeline.js";

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

export function preprocessForCharacterSearch(input) {
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

/**
 * @param {import("./config.js").LanguageConfig} languageConfig
 * @param {import("./sources/index.js").IndexRecord[]} languageRecords
 */
export async function buildLanguageIndex(languageConfig, languageRecords) {
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

export async function closePagefind() {
    await pagefind.close();
}
