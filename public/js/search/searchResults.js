import { getDisplayLanguages, getSourceTypeLabel } from "../core/displayConfig.js";
import { getBucketId, parseRecordId } from "../core/recordId.js";
import { isAbortError, throwIfAborted } from "./searchLifecycle.js";

export function extractRecordIdFromResult(subResult) {
    const fromUrl = subResult.url?.match(/#hash-(.+)$/)?.[1];
    if (fromUrl) {
        try {
            return decodeURIComponent(fromUrl);
        } catch {
            return fromUrl;
        }
    }

    const fromTitle = String(subResult.title || "").trim();
    if (fromTitle) {
        return fromTitle;
    }

    return "unknown";
}

export function buildResultSourceMeta(item, keyword = "") {
    const recordId = String(item.hash || "unknown");
    const sourceMeta = parseRecordId(recordId);

    return {
        sourceType: sourceMeta.sourceType,
        origin: `${getSourceTypeLabel(sourceMeta.sourceType)}`,
        canOpenContext: true,
        contextKey: recordId,
        contextParams: {
            recordId,
            sourceId: sourceMeta.sourceId,
            segment: sourceMeta.segment || "",
            sourceType: sourceMeta.sourceType,
            textDataKey: sourceMeta.textDataKey,
            bucketKey: sourceMeta.bucketKey,
            pagefindUrl: item.url || "",
            searchLanguage: item.searchLanguage,
            keyword
        }
    };
}

export function validateExactMatchDocument(searchResult, document, resultIndex) {
    const exactMatches = searchResult.exactMatches;
    const subResults = document?.sub_results;
    const expectedCount = searchResult.exactMatchCount;
    const resultLabel = searchResult.id || `#${resultIndex}`;

    if (!Array.isArray(exactMatches) || exactMatches.length !== expectedCount) {
        throw new Error(
            `Pagefind exact-match contract mismatch for ${resultLabel}: `
            + `expected ${expectedCount} exactMatches, received ${exactMatches?.length ?? "none"}.`
        );
    }
    if (!Array.isArray(subResults) || subResults.length !== expectedCount) {
        throw new Error(
            `Pagefind exact-match contract mismatch for ${resultLabel}: `
            + `expected ${expectedCount} sub_results, received ${subResults?.length ?? "none"}.`
        );
    }

    for (let index = 0; index < expectedCount; index += 1) {
        if (exactMatches[index].sectionStart !== subResults[index].anchor?.location) {
            throw new Error(
                `Pagefind exact-match section order mismatch for ${resultLabel} at entry ${index}.`
            );
        }
    }
}

export function flattenPageSlices(loadedSlices, language, keyword) {
    const flattened = [];

    loadedSlices.forEach(({ document, searchResult, slice }) => {
        document.sub_results.slice(slice.from, slice.to).forEach((subResult) => {
            const hash = extractRecordIdFromResult(subResult);
            const parsed = parseRecordId(hash);
            const displayLanguages = parsed.sourceType === "subtitle"
                ? [language]
                : getDisplayLanguages(language);
            const baseItem = {
                kind: "hash",
                title: subResult.title || hash,
                hash,
                url: subResult.url,
                excerpt: subResult.excerpt || document.excerpt || "",
                score: searchResult.score,
                texts: {},
                displayLanguages,
                searchLanguageText: "",
                searchLanguage: language
            };

            flattened.push({
                ...baseItem,
                ...buildResultSourceMeta(baseItem, keyword)
            });
        });
    });

    return flattened;
}

export async function hydrateOriginalTexts(items, language, {
    repository,
    signal,
    pendingRequests,
    logger = console
}) {
    throwIfAborted(signal);

    return Promise.all(items.map(async (item) => {
        if (item.kind !== "hash" || !item.hash) {
            return item;
        }

        const parsed = parseRecordId(item.hash);
        const bucketId = getBucketId(parsed.bucketKey);
        const lookupKey = parsed.textDataKey;
        const displayLanguages = parsed.sourceType === "subtitle"
            ? [language]
            : getDisplayLanguages(language);

        const textEntries = await Promise.all(displayLanguages.map(async (displayLanguage) => {
            try {
                const bucket = await repository.loadTextBucket(displayLanguage, bucketId, {
                    signal,
                    pendingRequests
                });
                return [displayLanguage, String(bucket[lookupKey] ?? "")];
            } catch (error) {
                if (isAbortError(error, signal)) {
                    throw error;
                }

                logger.warn(error);
                return [displayLanguage, ""];
            }
        }));

        const texts = Object.fromEntries(textEntries);
        return {
            ...item,
            displayLanguages,
            texts,
            searchLanguageText: texts[language] || ""
        };
    }));
}
