import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../config/meta-fields.json"
);

const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

export const META_FIELDS_CONFIG_PATH = CONFIG_PATH;

/**
 * Convert a full AnimeGameData2 release identifier into the short game version
 * used by config/meta-fields.json. Plain values such as "7.0" are preserved.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeGameVersion(value) {
    const normalized = String(value ?? "").trim();
    const match = normalized.match(/(?:CNRELWin)?(\d+\.\d+)/i);
    return match ? match[1] : normalized;
}

/**
 * @param {string} version
 * @returns {object & { gameVersion: string }}
 */
export function getMetaFieldConfig(version) {
    const gameVersion = normalizeGameVersion(version);
    const config = CONFIG.versions?.[gameVersion];

    if (!config) {
        const supportedVersions = Object.keys(CONFIG.versions ?? {}).join(", ");
        throw new Error(
            `No meta field config for game version "${gameVersion}". `
            + `Add it to ${path.relative(process.cwd(), CONFIG_PATH)}. `
            + `Supported versions: ${supportedVersions}`
        );
    }

    return { ...config, gameVersion };
}

function walkJsonFiles(rootPath) {
    if (!fs.existsSync(rootPath)) {
        return [];
    }

    const files = [];
    for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
        const entryPath = path.join(rootPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkJsonFiles(entryPath));
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
            files.push(entryPath);
        }
    }
    return files;
}

function configMatchesData(config, dataPath) {
    const roots = [
        path.join(dataPath, "BinOutput", "Talk"),
        path.join(dataPath, "BinOutput", "Quest")
    ];
    const keysets = [
        ...(config.talkKeysets ?? []),
        ...(config.questKeysets ?? [])
    ];

    for (const root of roots) {
        for (const filePath of walkJsonFiles(root)) {
            let value;
            try {
                value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            } catch {
                continue;
            }

            if (keysets.some((keyset) => keyset.detect in value)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Infer the configured game version from the obfuscated source field names.
 * The normal build path passes the version explicitly; this keeps the
 * standalone build_meta.js entry point convenient as well.
 *
 * @param {string} dataPath
 * @returns {string}
 */
export function inferGameVersion(dataPath) {
    const matches = Object.entries(CONFIG.versions ?? {})
        .filter(([, config]) => configMatchesData(config, dataPath))
        .map(([version]) => version);

    if (matches.length === 1) {
        return matches[0];
    }

    if (matches.length > 1) {
        throw new Error(
            `Multiple meta field configs match ${dataPath}: ${matches.join(", ")}. `
            + "Pass an explicit dataset version to buildMetaData()."
        );
    }

    throw new Error(
        `Unable to infer a meta field config from ${dataPath}. `
        + `Pass an explicit game version or add one to ${path.relative(process.cwd(), CONFIG_PATH)}.`
    );
}
