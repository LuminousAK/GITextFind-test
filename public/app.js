import * as pagefind from "./pagefind/chs/pagefind.js";

const BUCKET_COUNT = 512;

const LANGUAGE_LABELS = {
    chs: "简体中文",
    en: "English"
};

const SEARCH_PLACEHOLDERS = {
    chs: "输入中文关键词，将使用简体中文索引搜索",
    en: "Enter English keywords to search with the English index"
};

const input = document.getElementById("search-input");
const form = document.getElementById("search-form");
const languageSelect = document.getElementById("language-select");
const status = document.getElementById("status");
const results = document.getElementById("results");

let searchToken = 0;
let activeLanguage = languageSelect.value;
let initializedLanguage = null;
const textBucketCache = new Map();

function getLanguageBasePath(language) {
    return new URL(`./pagefind/${language}/`, window.location.href).pathname;
}

function getTextBucketUrl(language, bucketId) {
    return new URL(`./text-data/${language}/${bucketId}.json`, window.location.href).href;
}

function getDisplayLanguages(searchLanguage) {
    return Array.from(new Set([searchLanguage, "chs", "en"]));
}

function getLanguageLabel(language) {
    return LANGUAGE_LABELS[language] || language;
}

function getBucketId(hash) {
    let mixedHash = 0x811c9dc5;

    for (let index = 0; index < hash.length; index += 1) {
        mixedHash ^= hash.charCodeAt(index);
        mixedHash = Math.imul(mixedHash, 0x01000193);
    }

    return String((mixedHash >>> 0) % BUCKET_COUNT).padStart(4, "0");
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
        const entities = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "\"": "&quot;",
            "'": "&#39;"
        };

        return entities[char];
    });
}

function preprocessForCharacterSearch(input) {
    const normalized = String(input ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/\s+/g, " ")
        .trim();

    const isHan = (char) => /\p{Script=Han}/u.test(char);
    const isPunctuation = (char) => /\p{P}/u.test(char);
    const isNonSpaceNonHan = (char) => Boolean(char) && char !== " " && !isHan(char);
    const isSearchableNonHan = (char) => Boolean(char) && char !== " " && !isPunctuation(char) && !isHan(char);

    let output = "";

    for (let index = 0; index < normalized.length; index += 1) {
        const char = normalized[index];

        if (char === " ") {
            if (output && output[output.length - 1] !== " ") {
                output += " ";
            }

            continue;
        }

        output += char;

        const nextChar = normalized[index + 1] ?? "";
        const needsSeparator = (
            (isHan(char) && isHan(nextChar))
            || (isHan(char) && isSearchableNonHan(nextChar))
            || (isNonSpaceNonHan(char) && isHan(nextChar))
        );

        if (needsSeparator && output[output.length - 1] !== " ") {
            output += " ";
        }
    }

    return output.replace(/\s+/g, " ").trim();
}

function preprocessExactQuery(input) {
    const normalized = String(input ?? "")
        .replace(/\s+/g, " ")
        .trim();

    if (!normalized) {
        return "";
    }

    const isAlphaNumeric = (char) => /[\p{L}\p{N}]/u.test(char);
    const isPossiblyCompound = (word) => (
        Array.from(word).some((char) => !isAlphaNumeric(char))
        || Array.from(word).slice(1).some((char) => /\p{Lu}/u.test(char))
    );

    return normalized
        .split(" ")
        .map((word) => {
            if (!isPossiblyCompound(word)) {
                return word;
            }

            return word.replace(/(?<=\p{L}|\p{N})[^\p{L}\p{N}]+(?=\p{L}|\p{N})/gu, "");
        })
        .join(" ");
}

function wrapExactQuery(value) {
    const normalized = preprocessExactQuery(value).replace(/^"+|"+$/g, "");

    if (!normalized) {
        return "";
    }

    return `"${normalized}"`;
}

function setPlaceholder(message) {
    results.innerHTML = `<div class="placeholder">${message}</div>`;
}

function stripHtml(value) {
    return String(value ?? "").replace(/<[^>]+>/g, "");
}

function compactTextForMatch(value) {
    return stripHtml(value)
        .replace(/\s+/g, "")
        .trim()
        .toLowerCase();
}

function buildMatchInfo(item, rawKeyword, language) {
    const compactQuery = compactTextForMatch(rawKeyword);

    if (!compactQuery) {
        return null;
    }

    const candidates = [
        item.searchLanguageText,
        item.title,
        item.excerpt
    ];

    if (item.texts[language] && item.texts[language] !== item.searchLanguageText) {
        candidates.push(item.texts[language]);
    }

    let bestIndex = Infinity;
    let bestField = "";

    for (const candidate of candidates) {
        const compactCandidate = compactTextForMatch(candidate);
        const matchIndex = compactCandidate.indexOf(compactQuery);

        if (matchIndex !== -1 && matchIndex < bestIndex) {
            bestIndex = matchIndex;
            bestField = candidate;
        }
    }

    if (bestIndex === Infinity) {
        return null;
    }

    return {
        compactLength: compactQuery.length,
        fieldLength: compactTextForMatch(bestField).length,
        index: bestIndex
    };
}

async function loadTextBucket(language, bucketId) {
    const cacheKey = `${language}:${bucketId}`;

    if (!textBucketCache.has(cacheKey)) {
        textBucketCache.set(cacheKey, (async () => {
            const response = await fetch(getTextBucketUrl(language, bucketId));

            if (!response.ok) {
                throw new Error(`Failed to load text bucket: ${language}/${bucketId}`);
            }

            return response.json();
        })());
    }

    return textBucketCache.get(cacheKey);
}

async function hydrateOriginalTexts(items, language) {
    const displayLanguages = getDisplayLanguages(language);

    return Promise.all(items.map(async (item) => {
        if (item.kind !== "hash" || !item.hash) {
            return item;
        }

        const bucketId = getBucketId(item.hash);
        const textEntries = await Promise.all(displayLanguages.map(async (displayLanguage) => {
            try {
                const bucket = await loadTextBucket(displayLanguage, bucketId);
                return [displayLanguage, String(bucket[item.hash] ?? "")];
            } catch (error) {
                console.warn(error);
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

function extractHashFromResult(subResult) {
    const fromUrl = subResult.url?.match(/#hash-([^#/?]+)/)?.[1];

    if (fromUrl) {
        return decodeURIComponent(fromUrl);
    }

    return subResult.title || "unknown";
}

function flattenResults(searchResults, loadedDocuments, language) {
    const flattened = [];

    loadedDocuments.forEach((document, index) => {
        const searchResult = searchResults[index];
        const subResults = Array.isArray(document.sub_results) ? document.sub_results : [];

        if (subResults.length) {
            subResults.forEach((subResult) => {
                const hash = extractHashFromResult(subResult);

                flattened.push({
                    kind: "hash",
                    title: subResult.title || hash,
                    hash,
                    url: subResult.url,
                    excerpt: subResult.excerpt || document.excerpt || "",
                    score: searchResult.score,
                    texts: {},
                    displayLanguages: getDisplayLanguages(language),
                    searchLanguageText: "",
                    searchLanguage: language
                });
            });
        }
    });

    return flattened;
}

function filterAndSortResults(items, rawKeyword, language) {
    return items
        .map((item) => {
            const match = buildMatchInfo(item, rawKeyword, language);

            if (!match) {
                return null;
            }

            return {
                ...item,
                match
            };
        })
        .filter(Boolean)
        .sort((left, right) => {
            if (left.match.index !== right.match.index) {
                return left.match.index - right.match.index;
            }

            if (left.match.compactLength !== right.match.compactLength) {
                return right.match.compactLength - left.match.compactLength;
            }

            if (left.match.fieldLength !== right.match.fieldLength) {
                return left.match.fieldLength - right.match.fieldLength;
            }

            return right.score - left.score;
        });
}

function renderItems(items, language) {
    const languageLabel = getLanguageLabel(language);

    results.innerHTML = items.map((item) => {
        const displayLanguages = item.displayLanguages?.length ? item.displayLanguages : getDisplayLanguages(language);
        const textBlocks = displayLanguages.map((displayLanguage) => `
                <div class="excerpt-block">
                    <p class="excerpt-label">${escapeHtml(getLanguageLabel(displayLanguage))}</p>
                    <p class="excerpt">${escapeHtml(item.texts[displayLanguage] || "No text available.")}</p>
                </div>
        `).join("");

        return `
        <article class="result">
            <span class="result-kind">Matched in ${escapeHtml(languageLabel)}</span>
            <h2>${escapeHtml(item.title)}</h2>
            <p class="result-path">Pagefind source: ${escapeHtml(item.url || "-")}</p>
            <p class="result-hash">hash: ${escapeHtml(item.hash || "-")}</p>
            <div class="excerpt-group">
${textBlocks}
            </div>
        </article>
    `;
    }).join("");
}

async function ensureReady(language) {
    if (initializedLanguage === language) {
        return;
    }

    await pagefind.destroy();
    await pagefind.options({ basePath: getLanguageBasePath(language) });
    await pagefind.init();
    initializedLanguage = language;
    activeLanguage = language;
    status.textContent = `${getLanguageLabel(language)} index is ready. Click Search or press Enter to run a query.`;
}

async function runSearch(term, language) {
    const currentToken = ++searchToken;
    const keyword = term.trim();
    const processedKeyword = preprocessForCharacterSearch(keyword);
    const exactKeyword = wrapExactQuery(processedKeyword);

    if (!keyword) {
        status.textContent = "Enter a keyword to search.";
        setPlaceholder("Results will appear here. The selected language index will be queried, then display text will be loaded from text-data buckets.");
        return;
    }

    status.textContent = `Searching ${getLanguageLabel(language)} for "${keyword}" with exact query ${exactKeyword} ...`;
    setPlaceholder("Loading matching index shards and text buckets on demand...");

    try {
        await ensureReady(language);
        const search = await pagefind.search(exactKeyword, {});

        if (!search || currentToken !== searchToken) {
            return;
        }

        if (!search.results.length) {
            status.textContent = `No results for "${keyword}" in ${getLanguageLabel(language)}.`;
            setPlaceholder("No match found. Try a shorter or more common keyword.");
            return;
        }

        const allResults = search.results;
        const documents = await Promise.all(allResults.map((result) => result.data()));
        const items = flattenResults(allResults, documents, language);
        const hydratedItems = await hydrateOriginalTexts(items, language);
        const filteredItems = filterAndSortResults(hydratedItems, keyword, language);

        if (currentToken !== searchToken) {
            return;
        }

        if (!filteredItems.length) {
            status.textContent = `No continuously matched results for "${keyword}" in ${getLanguageLabel(language)}.`;
            setPlaceholder("Pagefind found coarse matches, but none survived the front-end contiguous-match filter.");
            return;
        }

        status.textContent = `Found ${filteredItems.length} rendered result(s) from ${search.results.length} Pagefind group match(es) in ${getLanguageLabel(language)}.`;
        renderItems(filteredItems, language);
    } catch (error) {
        console.error(error);
        status.textContent = "Search failed. Open this page through an HTTP server instead of double-clicking the HTML file.";
        setPlaceholder("Initialization or search failed. Check DevTools for missing <code>pagefind</code> or <code>text-data</code> requests.");
    }
}

function syncLanguageUI(language) {
    input.placeholder = SEARCH_PLACEHOLDERS[language] || SEARCH_PLACEHOLDERS.chs;
}

form.addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch(input.value, languageSelect.value);
});

languageSelect.addEventListener("change", async () => {
    const language = languageSelect.value;
    syncLanguageUI(language);
    status.textContent = `Switching to ${getLanguageLabel(language)} index...`;
    setPlaceholder("Results will appear here after you run a search.");

    try {
        await ensureReady(language);
    } catch (error) {
        console.error(error);
        status.textContent = `Failed to switch to ${getLanguageLabel(language)} index.`;
    }
});

syncLanguageUI(activeLanguage);
setPlaceholder("Results will appear here. The selected language index will be queried, then display text will be loaded from text-data buckets.");
ensureReady(activeLanguage).catch((error) => {
    console.error(error);
    status.textContent = "Pagefind initialization failed. Serve this directory over HTTP.";
    setPlaceholder("Could not load the selected <code>./pagefind/&lt;language&gt;/pagefind.js</code> assets.");
});
