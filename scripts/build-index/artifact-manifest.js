import fs from "node:fs";
import path from "node:path";

import { BUCKET_COUNT } from "../build_meta.js";

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function createSharedManifest(datasetVersion) {
    return {
        schemaVersion: 1,
        kind: "shared",
        datasetVersion,
        assets: {
            metaDataBaseUrl: `./releases/${datasetVersion}/meta-data/`
        }
    };
}

export function createLanguageManifest(languageConfig, datasetVersion) {
    return {
        schemaVersion: 1,
        kind: "language",
        datasetVersion,
        language: {
            id: languageConfig.id,
            label: languageConfig.label
        },
        bucketCount: BUCKET_COUNT,
        assets: {
            pagefindBaseUrl: `./releases/${datasetVersion}/pagefind/`,
            textDataBaseUrl: `./releases/${datasetVersion}/text-data/`
        }
    };
}

export function writeArtifactManifests({ sharedOutputRoot, languageConfigs, datasetVersion }) {
    writeJson(path.join(sharedOutputRoot, "manifest.json"), createSharedManifest(datasetVersion));

    for (const languageConfig of languageConfigs) {
        writeJson(
            path.join(languageConfig.languageOutputRoot, "manifest.json"),
            createLanguageManifest(languageConfig, datasetVersion)
        );
    }
}

