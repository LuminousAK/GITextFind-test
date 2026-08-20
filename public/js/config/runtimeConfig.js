function assertObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value;
}

function assertString(value, label) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    return value.trim();
}

function normalizeLanguageId(value) {
    const language = assertString(value, "language ID").toLowerCase();
    if (!/^[a-z0-9-]+$/.test(language)) {
        throw new Error(`Invalid language ID: ${value}`);
    }
    return language;
}

async function loadJson(url, fetchImpl) {
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response.ok) {
        throw new Error(`Failed to load ${url}: HTTP ${response.status ?? "error"}`);
    }
    return response.json();
}

export function validateRuntimeConfig(value, configUrl) {
    const config = assertObject(value, "runtime config");
    if (config.schemaVersion !== 1) {
        throw new Error(`Unsupported runtime config schema: ${config.schemaVersion}`);
    }

    const dataBaseUrl = new URL(assertString(config.dataBaseUrl, "dataBaseUrl"), configUrl).href;
    const languages = Array.from(new Set(
        (Array.isArray(config.languages) ? config.languages : []).map(normalizeLanguageId)
    ));
    if (languages.length === 0) {
        throw new Error("Runtime config must enable at least one language.");
    }

    const requestedDefault = normalizeLanguageId(config.defaultLanguage ?? languages[0]);
    const defaultLanguage = languages.includes(requestedDefault) ? requestedDefault : languages[0];
    const comparisonLanguages = Array.from(new Set(
        (Array.isArray(config.comparisonLanguages) ? config.comparisonLanguages : [])
            .map(normalizeLanguageId)
            .filter((language) => languages.includes(language))
    ));

    return {
        schemaVersion: 1,
        dataBaseUrl,
        languages,
        defaultLanguage,
        comparisonLanguages
    };
}

export function validateSharedManifest(value, manifestUrl) {
    const manifest = assertObject(value, "shared manifest");
    if (manifest.schemaVersion !== 1 || manifest.kind !== "shared") {
        throw new Error("Unsupported shared manifest.");
    }

    const datasetVersion = assertString(manifest.datasetVersion, "shared datasetVersion");
    const assets = assertObject(manifest.assets, "shared assets");
    return {
        datasetVersion,
        manifestUrl,
        metaDataBaseUrl: new URL(
            assertString(assets.metaDataBaseUrl, "metaDataBaseUrl"),
            manifestUrl
        ).href
    };
}

export function validateLanguageManifest(value, manifestUrl, expectedLanguage, datasetVersion) {
    const manifest = assertObject(value, `${expectedLanguage} manifest`);
    if (manifest.schemaVersion !== 1 || manifest.kind !== "language") {
        throw new Error(`Unsupported language manifest: ${expectedLanguage}`);
    }

    const language = assertObject(manifest.language, `${expectedLanguage} language`);
    const id = normalizeLanguageId(language.id);
    if (id !== expectedLanguage) {
        throw new Error(`Language manifest ID mismatch: expected ${expectedLanguage}, received ${id}`);
    }
    if (manifest.datasetVersion !== datasetVersion) {
        throw new Error(
            `Dataset version mismatch for ${id}: expected ${datasetVersion}, received ${manifest.datasetVersion}`
        );
    }
    if (!Number.isSafeInteger(manifest.bucketCount) || manifest.bucketCount <= 0) {
        throw new Error(`Invalid bucketCount for ${id}: ${manifest.bucketCount}`);
    }

    const assets = assertObject(manifest.assets, `${id} assets`);
    return {
        id,
        label: assertString(language.label, `${id} label`),
        datasetVersion,
        manifestUrl,
        bucketCount: manifest.bucketCount,
        pagefindBaseUrl: new URL(
            assertString(assets.pagefindBaseUrl, `${id} pagefindBaseUrl`),
            manifestUrl
        ).href,
        textDataBaseUrl: new URL(
            assertString(assets.textDataBaseUrl, `${id} textDataBaseUrl`),
            manifestUrl
        ).href
    };
}

export async function loadRuntimeData({
    configUrl = new URL("./runtime-config.json", window.location.href).href,
    fetchImpl = fetch,
    logger = console
} = {}) {
    const config = validateRuntimeConfig(await loadJson(configUrl, fetchImpl), configUrl);
    const sharedManifestUrl = new URL("shared/manifest.json", config.dataBaseUrl).href;
    const shared = validateSharedManifest(
        await loadJson(sharedManifestUrl, fetchImpl),
        sharedManifestUrl
    );

    const loadedLanguages = await Promise.all(config.languages.map(async (language) => {
        const manifestUrl = new URL(`languages/${language}/manifest.json`, config.dataBaseUrl).href;
        try {
            const manifest = await loadJson(manifestUrl, fetchImpl);
            return {
                language: validateLanguageManifest(
                    manifest,
                    manifestUrl,
                    language,
                    shared.datasetVersion
                ),
                warning: null
            };
        } catch (error) {
            logger.warn(error);
            return {
                language: null,
                warning: { language, message: error.message }
            };
        }
    }));

    const languages = loadedLanguages.map((entry) => entry.language).filter(Boolean);
    const warnings = loadedLanguages.map((entry) => entry.warning).filter(Boolean);
    if (languages.length === 0) {
        throw new Error("No compatible language dataset is available.");
    }

    const availableIds = languages.map((language) => language.id);
    const defaultLanguage = availableIds.includes(config.defaultLanguage)
        ? config.defaultLanguage
        : availableIds[0];

    return {
        config: {
            ...config,
            defaultLanguage,
            comparisonLanguages: config.comparisonLanguages.filter((language) => availableIds.includes(language))
        },
        shared,
        languages,
        warnings
    };
}
