import fs from "fs";

import { normalizeSourceText } from "../filesystem.js";

/**
 * @param {import("../config.js").LanguageConfig} languageConfig
 * @returns {Record<string, string>}
 */
export function loadFullTextMap(languageConfig) {
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

/**
 * @param {string} hash
 * @param {string} text
 * @param {ReturnType<import("../../build_meta.js").buildMetaData>} metaData
 * @returns {import("./index.js").IndexRecord}
 */
export function makeTextMapRecord(hash, text, metaData) {
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

/**
 * @param {import("../config.js").LanguageConfig} languageConfig
 * @param {ReturnType<import("../../build_meta.js").buildMetaData>} metaData
 */
export function loadTextMapRecords(languageConfig, metaData) {
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
