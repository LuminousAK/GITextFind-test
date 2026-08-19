import fs from "fs";
import path from "path";

import { BUCKET_COUNT, getBucketId } from "../build_meta.js";
import { INDEX_CONCURRENCY, TEXT_DATA_OUTPUT_ROOT } from "./config.js";
import { toPosixPath } from "./filesystem.js";
import { mapWithConcurrency, summarizeBucketStats } from "./pipeline.js";

function addToTextBucket(buckets, record) {
    const bucketId = getBucketId(String(record.bucketKey));
    buckets[Number(bucketId)][record.textDataKey] = record.text;
}

/**
 * @param {import("./config.js").LanguageConfig} languageConfig
 * @param {ReturnType<import("../build_meta.js").buildMetaData>} metaData
 * @param {Record<string, string>} textMap
 */
export function writeLookupTables(languageConfig, metaData, textMap) {
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

/**
 * @param {import("./config.js").LanguageConfig} languageConfig
 * @param {import("./sources/index.js").IndexRecord[]} languageRecords
 * @param {ReturnType<import("../build_meta.js").buildMetaData>} metaData
 */
export async function writeLanguageTextData(languageConfig, languageRecords, metaData) {
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

/** @param {import("./config.js").LanguageConfig[]} languageConfigs */
export function writeTextDataManifest(languageConfigs) {
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
