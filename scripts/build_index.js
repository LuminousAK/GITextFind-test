import fs from "fs";

import {
    DATA_PATH,
    buildMetaData,
    writeMetaBuckets
} from "./build_meta.js";
import {
    LEGACY_CHUNK_OUTPUT_ROOT,
    META_DATA_OUTPUT_ROOT,
    PAGEFIND_OUTPUT_ROOT,
    TEMP_INDEX_OUTPUT_ROOT,
    TEXT_DATA_OUTPUT_ROOT,
    discoverLanguageConfigs,
    parseRequestedLanguageIds
} from "./build-index/config.js";
import { buildLanguageIndex, closePagefind } from "./build-index/pagefind-index.js";
import { loadLanguageData } from "./build-index/sources/index.js";
import {
    writeLanguageTextData,
    writeLookupTables,
    writeTextDataManifest
} from "./build-index/text-data.js";

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
    await closePagefind();
}

buildAllIndexes().catch(async (error) => {
    console.error(error);

    try {
        await closePagefind();
    } catch (closeError) {
        console.error(closeError);
    }

    process.exitCode = 1;
});
