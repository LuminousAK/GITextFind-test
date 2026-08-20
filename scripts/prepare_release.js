import fs from "node:fs";
import path from "node:path";

import { DATA_PATH } from "./build_meta.js";
import { DIST_OUTPUT_ROOT, R2_OUTPUT_ROOT, SHARED_OUTPUT_ROOT } from "./build-index/config.js";
import { resolveDatasetVersion } from "./release/dataset-version.js";
import { PAGES_HEADERS } from "./release/cloudflare-artifacts.js";
import {
    createR2UploadEntries,
    summarizeDirectory
} from "./release/release-artifacts.js";
import {
    loadReleaseConfig,
    normalizeRuntimeConfig,
    parseReleaseArgs
} from "./release/release-config.js";

const PAGES_OUTPUT_ROOT = path.join(DIST_OUTPUT_ROOT, "pages");
const RELEASE_OUTPUT_ROOT = path.join(DIST_OUTPUT_ROOT, "release");
const PUBLIC_SOURCE_ROOT = path.resolve("./public");

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function discoverLanguageManifests() {
    const languagesRoot = path.join(R2_OUTPUT_ROOT, "languages");
    if (!fs.existsSync(languagesRoot)) {
        return new Map();
    }

    const manifests = new Map();
    const dirents = fs.readdirSync(languagesRoot, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    for (const dirent of dirents) {
        if (!dirent.isDirectory()) {
            continue;
        }
        const manifestPath = path.join(languagesRoot, dirent.name, "manifest.json");
        if (fs.existsSync(manifestPath)) {
            manifests.set(dirent.name, { path: manifestPath, value: readJson(manifestPath) });
        }
    }
    return manifests;
}

function validateManifestSet(sharedManifest, languageManifests, enabledLanguages) {
    if (sharedManifest.schemaVersion !== 1 || sharedManifest.kind !== "shared") {
        throw new Error("Invalid shared manifest.");
    }

    for (const language of enabledLanguages) {
        const manifest = languageManifests.get(language)?.value;
        if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== "language") {
            throw new Error(`Invalid or missing language manifest: ${language}`);
        }
        if (manifest.language?.id !== language) {
            throw new Error(`Language manifest ID mismatch: expected ${language}`);
        }
        if (manifest.datasetVersion !== sharedManifest.datasetVersion) {
            throw new Error(`Dataset version mismatch for language ${language}.`);
        }
    }
}

function copyFrontendSources() {
    fs.rmSync(PAGES_OUTPUT_ROOT, { force: true, recursive: true });
    fs.mkdirSync(PAGES_OUTPUT_ROOT, { recursive: true });
    for (const fileName of ["index.html", "app.js", ".nojekyll"]) {
        fs.copyFileSync(path.join(PUBLIC_SOURCE_ROOT, fileName), path.join(PAGES_OUTPUT_ROOT, fileName));
    }
    fs.cpSync(path.join(PUBLIC_SOURCE_ROOT, "js"), path.join(PAGES_OUTPUT_ROOT, "js"), { recursive: true });
}

function writePagesHeaders() {
    fs.writeFileSync(path.join(PAGES_OUTPUT_ROOT, "_headers"), PAGES_HEADERS, "utf-8");
}

function snapshotManifests(datasetVersion, sharedManifestEntry, languageManifests, enabledLanguages) {
    const snapshotRoot = path.join(RELEASE_OUTPUT_ROOT, "manifests", datasetVersion);
    fs.rmSync(snapshotRoot, { force: true, recursive: true });
    fs.mkdirSync(path.join(snapshotRoot, "languages"), { recursive: true });
    fs.copyFileSync(sharedManifestEntry, path.join(snapshotRoot, "shared.json"));
    for (const language of enabledLanguages) {
        fs.copyFileSync(
            languageManifests.get(language).path,
            path.join(snapshotRoot, "languages", `${language}.json`)
        );
    }
}

function prepareRelease() {
    const args = parseReleaseArgs(process.argv.slice(2));
    const dataset = resolveDatasetVersion(DATA_PATH);
    const sharedManifestPath = path.join(SHARED_OUTPUT_ROOT, "manifest.json");
    if (!fs.existsSync(sharedManifestPath)) {
        throw new Error("Shared manifest is missing. Run npm run build:data first.");
    }

    const sharedManifest = readJson(sharedManifestPath);
    const languageManifests = discoverLanguageManifests();
    const rawConfig = args.local
        ? {}
        : loadReleaseConfig(args.configPath);
    const runtimeConfig = normalizeRuntimeConfig(rawConfig, {
        local: args.local,
        availableLanguageIds: Array.from(languageManifests.keys())
    });
    validateManifestSet(sharedManifest, languageManifests, runtimeConfig.languages);
    if (sharedManifest.datasetVersion !== dataset.datasetVersion) {
        throw new Error("Built artifacts do not match the current AnimeGameData2 dataset version.");
    }

    copyFrontendSources();
    writeJson(path.join(PAGES_OUTPUT_ROOT, "runtime-config.json"), runtimeConfig);
    writePagesHeaders();

    fs.rmSync(RELEASE_OUTPUT_ROOT, { force: true, recursive: true });
    fs.mkdirSync(RELEASE_OUTPUT_ROOT, { recursive: true });
    snapshotManifests(
        dataset.datasetVersion,
        sharedManifestPath,
        languageManifests,
        runtimeConfig.languages
    );

    const enabledLanguagePrefixes = runtimeConfig.languages.map((language) => `languages/${language}/`);
    const uploadEntries = createR2UploadEntries(
        R2_OUTPUT_ROOT,
        process.cwd(),
        (objectKey) => (
            objectKey.startsWith("shared/")
            || enabledLanguagePrefixes.some((prefix) => objectKey.startsWith(prefix))
        )
    );
    const pagesStats = summarizeDirectory(PAGES_OUTPUT_ROOT);
    const r2Stats = {
        files: uploadEntries.length,
        bytes: uploadEntries.reduce((sum, entry) => sum + entry.size, 0),
        largestFileBytes: Math.max(0, ...uploadEntries.map((entry) => entry.size))
    };
    if (pagesStats.files > 20_000 || pagesStats.largestFileBytes > 25 * 1024 * 1024) {
        throw new Error("Cloudflare Pages output exceeds the 20,000-file or 25 MiB per-file limit.");
    }
    if (uploadEntries.some((entry) => entry.size > 5 * 1024 * 1024 * 1024)) {
        throw new Error("An R2 object exceeds the 5 GiB single-part upload limit.");
    }
    writeJson(path.join(RELEASE_OUTPUT_ROOT, "r2-upload-manifest.json"), {
        schemaVersion: 1,
        datasetVersion: dataset.datasetVersion,
        operations: uploadEntries
    });
    writeJson(path.join(RELEASE_OUTPUT_ROOT, "release-report.json"), {
        schemaVersion: 1,
        datasetVersion: dataset.datasetVersion,
        source: {
            dataPath: DATA_PATH,
            commit: dataset.commit,
            commitDate: dataset.commitDate,
            commitSubject: dataset.currentSubject
        },
        mode: args.local ? "local" : "production",
        languages: runtimeConfig.languages,
        packages: {
            pages: pagesStats,
            r2: r2Stats
        },
        upload: {
            puts: uploadEntries.length,
            deletes: 0,
            pagesAfterR2: true
        }
    });

    console.log(`Prepared ${args.local ? "local" : "production"} release ${dataset.datasetVersion}.`);
    console.log(`Pages output: ${PAGES_OUTPUT_ROOT}`);
    console.log(`R2 operations: ${uploadEntries.length} PUT, 0 DELETE`);
}

try {
    prepareRelease();
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
