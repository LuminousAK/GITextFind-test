import { loadReadableRecords } from "./readable.js";
import { loadSubtitleRecords } from "./subtitle.js";
import { loadTextMapRecords } from "./textmap.js";

/**
 * Canonical record consumed by both text-data and Pagefind writers.
 *
 * @typedef {object} IndexRecord
 * @property {string} sourceType
 * @property {string} pagefindId
 * @property {string} textDataKey
 * @property {string} bucketKey
 * @property {string} titleText
 * @property {string} searchText
 * @property {string} text
 */

/**
 * @param {IndexRecord[][]} recordGroups
 * @returns {IndexRecord[]}
 */
export function mergeLanguageRecords(recordGroups) {
    const uniqueRecordsById = new Map();

    for (const record of recordGroups.flat()) {
        if (record.text.trim()) {
            uniqueRecordsById.set(record.pagefindId, record);
        }
    }

    return Array.from(uniqueRecordsById.values())
        .sort((left, right) => left.pagefindId.localeCompare(right.pagefindId));
}

/**
 * @param {import("../config.js").LanguageConfig} languageConfig
 * @param {ReturnType<import("../../build_meta.js").buildMetaData>} metaData
 */
export function loadLanguageData(languageConfig, metaData) {
    const { records: textMapRecords, textMap } = loadTextMapRecords(languageConfig, metaData);

    return {
        textMap,
        records: mergeLanguageRecords([
            textMapRecords,
            loadReadableRecords(languageConfig),
            loadSubtitleRecords(languageConfig)
        ])
    };
}
