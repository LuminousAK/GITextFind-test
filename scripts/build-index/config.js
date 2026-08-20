import fs from "fs";
import path from "path";
import { DATA_PATH } from "../build_meta.js";

export const PREPROCESS_CONCURRENCY = 64;
export const INDEX_CONCURRENCY = 4;
export const DIST_OUTPUT_ROOT = path.resolve("./dist");
export const R2_OUTPUT_ROOT = path.join(DIST_OUTPUT_ROOT, "r2");
export const SHARED_OUTPUT_ROOT = path.join(R2_OUTPUT_ROOT, "shared");
export const LANGUAGES_OUTPUT_ROOT = path.join(R2_OUTPUT_ROOT, "languages");
export const TEMP_INDEX_OUTPUT_ROOT = path.resolve("./.tmp-pagefind-html");
export const TEXTMAP_SOURCE_ROOT = path.join(DATA_PATH, "TextMap");
export const READABLE_SOURCE_ROOT = path.join(DATA_PATH, "Readable");
export const SUBTITLE_SOURCE_ROOT = path.join(DATA_PATH, "Subtitle");
export const DEFAULT_LANGUAGE_IDS = ["chs", "en"];

const TEXTMAP_FILE_RE = /^TextMap(?:_Medium)?([A-Za-z]+)(?:_(\d+))?\.json$/;

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

/**
 * @typedef {object} TextMapSourceFile
 * @property {string} fileName
 * @property {string} filePath
 * @property {number} familyOrder
 * @property {number} sequence
 */

/**
 * Configuration shared by every stage of a single-language build.
 *
 * @typedef {object} LanguageConfig
 * @property {string} id
 * @property {string} label
 * @property {TextMapSourceFile[]} sourceFiles
 * @property {string} readableSourceDir
 * @property {string} subtitleSourceDir
 * @property {string} pagefindOutputDir
 * @property {string} textDataOutputDir
 * @property {string} tempIndexOutputDir
 */

export function normalizeLanguageId(value) {
    return String(value ?? "").trim().toLowerCase();
}

export function parseRequestedLanguageIds(argv) {
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

export function compareTextMapFiles(left, right) {
    return (
        left.familyOrder - right.familyOrder
        || left.sequence - right.sequence
        || left.fileName.localeCompare(right.fileName)
    );
}

/**
 * @param {string[] | null} requestedLanguageIds
 * @returns {LanguageConfig[]}
 */
export function discoverLanguageConfigs(
    requestedLanguageIds = DEFAULT_LANGUAGE_IDS,
    { datasetVersion = "unversioned" } = {}
) {
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
        .map((config) => {
            const languageOutputRoot = path.join(LANGUAGES_OUTPUT_ROOT, config.id);
            const releaseOutputRoot = path.join(languageOutputRoot, "releases", datasetVersion);

            return {
                ...config,
                sourceFiles: config.sourceFiles.sort(compareTextMapFiles),
                readableSourceDir: path.join(READABLE_SOURCE_ROOT, config.id.toUpperCase()),
                subtitleSourceDir: path.join(SUBTITLE_SOURCE_ROOT, config.id.toUpperCase()),
                languageOutputRoot,
                releaseOutputRoot,
                pagefindOutputDir: path.join(releaseOutputRoot, "pagefind"),
                textDataOutputDir: path.join(releaseOutputRoot, "text-data"),
                tempIndexOutputDir: path.join(TEMP_INDEX_OUTPUT_ROOT, config.id)
            };
        })
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
