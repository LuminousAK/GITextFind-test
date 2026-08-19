import { loadCachedJson } from "../search/searchLifecycle.js";

export function createTextRepository({
    baseUrl,
    fetchImpl = fetch,
    logger = console
}) {
    const textBucketCache = new Map();
    const textBucketRequests = new Map();
    const metaBucketCache = new Map();
    const namesCache = {};
    const questsCache = {};
    const sourceTitlesCache = {};

    function getTextDataUrl(language, fileName) {
        return new URL(`./text-data/${language}/${fileName}`, baseUrl).href;
    }

    function getTextBucketUrl(language, bucketId) {
        return getTextDataUrl(language, `${bucketId}.json`);
    }

    async function loadTextBucket(language, bucketId, options = {}) {
        const cacheKey = `${language}:${bucketId}`;
        return loadCachedJson({
            key: cacheKey,
            url: getTextBucketUrl(language, bucketId),
            resolvedCache: textBucketCache,
            pendingRequests: options.pendingRequests || textBucketRequests,
            signal: options.signal,
            fetchImpl,
            errorMessage: `Failed to load text bucket: ${language}/${bucketId}`
        });
    }

    function loadLookupTable(language, fileName, cache) {
        if (!cache[language]) {
            cache[language] = (async () => {
                const response = await fetchImpl(getTextDataUrl(language, fileName));
                if (!response.ok) {
                    return {};
                }
                return response.json();
            })().catch((error) => {
                logger.warn(error);
                return {};
            });
        }

        return cache[language];
    }

    function loadNames(language) {
        return loadLookupTable(language, "names.json", namesCache);
    }

    function loadQuests(language) {
        return loadLookupTable(language, "quests.json", questsCache);
    }

    function loadSourceTitles(language) {
        return loadLookupTable(language, "source-titles.json", sourceTitlesCache);
    }

    async function loadMetaBucket(bucketType, bucketId) {
        const cacheKey = `${bucketType}:${bucketId}`;

        if (!metaBucketCache.has(cacheKey)) {
            metaBucketCache.set(cacheKey, (async () => {
                const url = new URL(`./meta-data/${bucketType}/${bucketId}.json`, baseUrl).href;
                const response = await fetchImpl(url);
                if (!response.ok) {
                    return {};
                }

                return response.json();
            })());
        }

        return metaBucketCache.get(cacheKey);
    }

    async function loadTextBucketsForLanguages(displayLanguages, bucketId) {
        const entries = await Promise.all(displayLanguages.map(async (language) => {
            try {
                return [language, await loadTextBucket(language, bucketId)];
            } catch (error) {
                logger.warn(error);
                return [language, {}];
            }
        }));

        return Object.fromEntries(entries);
    }

    return {
        loadMetaBucket,
        loadNames,
        loadQuests,
        loadSourceTitles,
        loadTextBucket,
        loadTextBucketsForLanguages
    };
}
