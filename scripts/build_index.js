import fs from "fs";
import path from "path";

import {
    DATA_PATH,
    buildMetaData,
    writeMetaBuckets
} from "./build_meta.js";
import {
    SHARED_OUTPUT_ROOT,
    TEMP_INDEX_OUTPUT_ROOT,
    discoverLanguageConfigs,
    parseRequestedLanguageIds
} from "./build-index/config.js";
import { writeArtifactManifests } from "./build-index/artifact-manifest.js";
import { buildLanguageIndex, closePagefind } from "./build-index/pagefind-index.js";
import { loadLanguageData } from "./build-index/sources/index.js";
import {
    writeLanguageTextData,
    writeLookupTables
} from "./build-index/text-data.js";
import { resolveDatasetVersion } from "./release/dataset-version.js";

function resetOutputDirs(languageConfigs, metaDataOutputRoot) {
    fs.rmSync(path.join(SHARED_OUTPUT_ROOT, "releases"), { force: true, recursive: true });
    fs.rmSync(metaDataOutputRoot, { force: true, recursive: true });

    for (const languageConfig of languageConfigs) {
        fs.rmSync(path.join(languageConfig.languageOutputRoot, "releases"), { force: true, recursive: true });
        fs.rmSync(languageConfig.tempIndexOutputDir, { force: true, recursive: true });
        fs.mkdirSync(languageConfig.pagefindOutputDir, { recursive: true });
        fs.mkdirSync(languageConfig.textDataOutputDir, { recursive: true });
    }

    fs.mkdirSync(metaDataOutputRoot, { recursive: true });
    fs.mkdirSync(TEMP_INDEX_OUTPUT_ROOT, { recursive: true });
}

async function buildAllIndexes() {
    const requestedLanguageIds = parseRequestedLanguageIds(process.argv.slice(2));
    const dataset = resolveDatasetVersion(DATA_PATH);
    const languageConfigs = discoverLanguageConfigs(requestedLanguageIds, {
        datasetVersion: dataset.datasetVersion
    });
    const metaDataOutputRoot = path.join(
        SHARED_OUTPUT_ROOT,
        "releases",
        dataset.datasetVersion,
        "meta-data"
    );

    console.log(`Dataset version: ${dataset.datasetVersion} (${dataset.commit})`);
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

    resetOutputDirs(languageConfigs, metaDataOutputRoot);
    writeMetaBuckets(metaData, metaDataOutputRoot);

    for (const languageConfig of languageConfigs) {
        const languageData = languageDataById[languageConfig.id];
        writeLookupTables(languageConfig, metaData, languageData.textMap);
        await writeLanguageTextData(languageConfig, languageData.records, metaData);
        await buildLanguageIndex(languageConfig, languageData.records);
    }

    writeArtifactManifests({
        sharedOutputRoot: SHARED_OUTPUT_ROOT,
        languageConfigs,
        datasetVersion: dataset.datasetVersion
    });

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
