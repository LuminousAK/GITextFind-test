import fs from "fs";
import path from "path";

import {
    getNormalizedRelativePath,
    listFilesRecursive,
    normalizeSourceText,
    toPosixPath
} from "../filesystem.js";

/**
 * @param {import("../config.js").LanguageConfig} languageConfig
 * @returns {import("./index.js").IndexRecord[]}
 */
export function loadReadableRecords(languageConfig) {
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
