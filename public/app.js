import * as pagefind from "./pagefind/chs/pagefind.js";

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
const chunkDocumentCache = new Map();

function getLanguageBasePath(language) {
    return new URL(`./pagefind/${language}/`, window.location.href).pathname;
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

    let output = "";
    let previousWasCjk = false;

    for (const char of normalized) {
        if (char === " ") {
            if (output && output[output.length - 1] !== " ") {
                output += " ";
            }

            previousWasCjk = false;
            continue;
        }

        const isCjk = /\p{Script=Han}/u.test(char);

        if (isCjk) {
            if (output && output[output.length - 1] !== " ") {
                output += " ";
            }

            output += char;
            output += " ";
            previousWasCjk = true;
            continue;
        }

        if (previousWasCjk && output && output[output.length - 1] !== " ") {
            output += " ";
        }

        output += char;
        previousWasCjk = false;
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
        item.title,
        item.searchLanguageText,
        item.excerpt,
        language === "chs" ? item.texts.chs : item.texts.en
    ];

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

async function loadChunkTextMap(chunkUrl) {
    if (!chunkDocumentCache.has(chunkUrl)) {
        chunkDocumentCache.set(chunkUrl, (async () => {
            const response = await fetch(chunkUrl);

            if (!response.ok) {
                throw new Error(`Failed to load chunk page: ${chunkUrl}`);
            }

            const html = await response.text();
            const parser = new DOMParser();
            const document = parser.parseFromString(html, "text/html");
            const textMap = new Map();

            document.querySelectorAll("section[data-hash]").forEach((section) => {
                const hash = section.getAttribute("data-hash");
                const chsText = section.querySelector("[data-original-text-chs]")?.textContent?.replace(/^简体中文:?\s*/, "").trim() || "";
                const enText = section.querySelector("[data-original-text-en]")?.textContent?.replace(/^English:\s*/, "").trim() || "";

                if (hash) {
                    textMap.set(hash, {
                        chs: chsText,
                        en: enText
                    });
                }
            });

            return textMap;
        })());
    }

    return chunkDocumentCache.get(chunkUrl);
}

async function hydrateOriginalTexts(items, language) {
    const hydratedItems = await Promise.all(items.map(async (item) => {
        if (item.kind !== "hash" || !item.hash) {
            return item;
        }

        const chunkUrl = item.url.split("#")[0];
        const chunkTextMap = await loadChunkTextMap(chunkUrl);
        const texts = chunkTextMap.get(item.hash) || { chs: "", en: "" };

        return {
            ...item,
            texts,
            searchLanguageText: language === "chs" ? texts.chs : texts.en
        };
    }));

    return hydratedItems;
}

function flattenResults(searchResults, loadedDocuments, language) {
    const flattened = [];

    loadedDocuments.forEach((document, index) => {
        const searchResult = searchResults[index];
        const subResults = Array.isArray(document.sub_results) ? document.sub_results : [];

        if (subResults.length) {
            subResults.forEach((subResult) => {
                const hash = subResult.url.match(/#hash-([^#/?]+)/)?.[1] || subResult.title || "unknown";
                flattened.push({
                    kind: "hash",
                    title: subResult.title || hash,
                    hash,
                    url: subResult.url,
                    excerpt: subResult.excerpt || document.excerpt || "",
                    score: searchResult.score,
                    texts: {
                        chs: "",
                        en: ""
                    },
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
    const languageLabel = LANGUAGE_LABELS[language] || language;

    results.innerHTML = items.map((item) => `
        <article class="result">
            <span class="result-kind">Matched in ${escapeHtml(languageLabel)}</span>
            <h2><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a></h2>
            <p class="result-path">URL: ${escapeHtml(item.url)}</p>
            <p class="result-hash">hash: ${escapeHtml(item.hash || "-")}</p>
            <div class="excerpt-group">
                <div class="excerpt-block">
                    <p class="excerpt-label">简体中文</p>
                    <p class="excerpt">${escapeHtml(item.texts.chs || "No text available.")}</p>
                </div>
                <div class="excerpt-block">
                    <p class="excerpt-label">English</p>
                    <p class="excerpt">${escapeHtml(item.texts.en || "No text available.")}</p>
                </div>
            </div>
        </article>
    `).join("");
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
    status.textContent = `${LANGUAGE_LABELS[language]} index is ready. Click Search or press Enter to run a query.`;
}

async function runSearch(term, language) {
    const currentToken = ++searchToken;
    const keyword = term.trim();
    const processedKeyword = preprocessForCharacterSearch(keyword);
    const exactKeyword = wrapExactQuery(processedKeyword);

    if (!keyword) {
        status.textContent = "Enter a keyword to search.";
        setPlaceholder("Results will appear here. The selected language index will be queried, and both language texts will be shown.");
        return;
    }

    status.textContent = `Searching ${LANGUAGE_LABELS[language]} for "${keyword}" with exact query ${exactKeyword} ...`;
    setPlaceholder("Loading matching index shards on demand...");

    try {
        await ensureReady(language);
        const search = await pagefind.search(exactKeyword, {});

        if (!search || currentToken !== searchToken) {
            return;
        }

        if (!search.results.length) {
            status.textContent = `No results for "${keyword}" in ${LANGUAGE_LABELS[language]}.`;
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
            status.textContent = `No continuously matched results for "${keyword}" in ${LANGUAGE_LABELS[language]}.`;
            setPlaceholder("Pagefind found coarse matches, but none survived the front-end contiguous-match filter.");
            return;
        }

        status.textContent = `Found ${filteredItems.length} rendered result(s) from ${search.results.length} Pagefind group match(es) in ${LANGUAGE_LABELS[language]}.`;
        renderItems(filteredItems, language);
    } catch (error) {
        console.error(error);
        status.textContent = "Search failed. Open this page through an HTTP server instead of double-clicking the HTML file.";
        setPlaceholder("Initialization or search failed. Check DevTools for missing <code>pagefind</code> requests.");
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
    status.textContent = `Switching to ${LANGUAGE_LABELS[language]} index...`;
    setPlaceholder("Results will appear here after you run a search.");

    try {
        await ensureReady(language);
    } catch (error) {
        console.error(error);
        status.textContent = `Failed to switch to ${LANGUAGE_LABELS[language]} index.`;
    }
});

syncLanguageUI(activeLanguage);
setPlaceholder("Results will appear here. The selected language index will be queried, and both language texts will be shown.");
ensureReady(activeLanguage).catch((error) => {
    console.error(error);
    status.textContent = "Pagefind initialization failed. Serve this directory over HTTP.";
    setPlaceholder("Could not load the selected <code>./pagefind/&lt;language&gt;/pagefind.js</code> assets.");
});
