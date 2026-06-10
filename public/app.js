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

const SOURCE_TYPE_LABELS = {
    talk: "对话文本",
    readable: "阅读物",
    subtitle: "字幕",
    textmap: "其他文本",
    unknown: "未知来源"
};

const input = document.getElementById("search-input");
const form = document.getElementById("search-form");
const languageSelect = document.getElementById("language-select");
const status = document.getElementById("status");
const results = document.getElementById("results");
const drawerBackdrop = document.getElementById("drawer-backdrop");
const contextDrawer = document.getElementById("context-drawer");
const drawerClose = document.getElementById("drawer-close");
const drawerTitle = document.getElementById("drawer-title");
const drawerSubtitle = document.getElementById("drawer-subtitle");
const drawerContent = document.getElementById("drawer-content");

let searchToken = 0;
let activeLanguage = languageSelect.value;
let initializedLanguage = null;
const textBucketCache = new Map();
const renderedItems = new Map();

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

function getSourceTypeLabel(sourceType) {
    return SOURCE_TYPE_LABELS[sourceType] || SOURCE_TYPE_LABELS.unknown;
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

function preprocessForCharacterSearch(inputValue) {
    const normalized = String(inputValue ?? "")
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

function preprocessExactQuery(inputValue) {
    const normalized = String(inputValue ?? "")
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

function extractRecordIdFromResult(subResult) {
    const fromTitle = String(subResult.title || "").trim();

    if (fromTitle) {
        return fromTitle;
    }

    const fromUrl = subResult.url?.match(/#hash-(.+)$/)?.[1];

    if (fromUrl) {
        try {
            return decodeURIComponent(fromUrl);
        } catch {
            return fromUrl;
        }
    }

    return "unknown";
}

function parseRecordId(recordId) {
    const id = String(recordId || "unknown");

    if (id.startsWith("readable:")) {
        const sourceId = id.slice("readable:".length);

        return {
            sourceType: "readable",
            sourceId,
            originDetail: sourceId
        };
    }

    if (id.startsWith("subtitle:")) {
        const value = id.slice("subtitle:".length);
        const separatorIndex = value.lastIndexOf(":");
        const sourceId = separatorIndex === -1 ? value : value.slice(0, separatorIndex);
        const segment = separatorIndex === -1 ? "" : value.slice(separatorIndex + 1);

        return {
            sourceType: "subtitle",
            sourceId,
            segment,
            originDetail: segment ? `${sourceId} #${segment}` : sourceId
        };
    }

    if (id.startsWith("textmap:")) {
        const sourceId = id.slice("textmap:".length);

        return {
            sourceType: "textmap",
            sourceId,
            originDetail: sourceId
        };
    }

    return {
        sourceType: "textmap",
        sourceId: id,
        originDetail: id
    };
}

function buildResultSourceMeta(item) {
    const hash = String(item.hash || item.title || "unknown");
    const sourceMeta = parseRecordId(hash);

    return {
        sourceType: sourceMeta.sourceType,
        origin: `${getSourceTypeLabel(sourceMeta.sourceType)}: ${sourceMeta.originDetail}`,
        canOpenContext: true,
        contextKey: hash,
        contextParams: {
            hash,
            recordId: hash,
            sourceId: sourceMeta.sourceId,
            segment: sourceMeta.segment || "",
            sourceType: sourceMeta.sourceType,
            pagefindUrl: item.url || "",
            searchLanguage: item.searchLanguage || activeLanguage
        }
    };
}

function flattenResults(searchResults, loadedDocuments, language) {
    const flattened = [];

    loadedDocuments.forEach((document, index) => {
        const searchResult = searchResults[index];
        const subResults = Array.isArray(document.sub_results) ? document.sub_results : [];

        if (subResults.length) {
            subResults.forEach((subResult) => {
                const hash = extractRecordIdFromResult(subResult);
                const baseItem = {
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
                };

                flattened.push({
                    ...baseItem,
                    ...buildResultSourceMeta(baseItem)
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

function renderSourceControl(item, resultId) {
    const sourceLabel = item.origin || `${getSourceTypeLabel(item.sourceType)}：${item.hash || "-"}`;
    const clickableClass = item.canOpenContext ? " is-clickable" : "";
    const disabledAttribute = item.canOpenContext ? "" : " disabled";
    const arrow = item.canOpenContext ? '<span class="origin-arrow">&gt;</span>' : "";

    return `
            <p class="result-source">
                <button class="origin-action${clickableClass}" type="button" data-result-id="${escapeHtml(resultId)}"${disabledAttribute}>
                    来源：${escapeHtml(sourceLabel)}
                    ${arrow}
                </button>
            </p>
    `;
}

function renderItems(items, language) {
    const languageLabel = getLanguageLabel(language);
    renderedItems.clear();

    results.innerHTML = items.map((item, index) => {
        const resultId = `${item.contextKey || item.hash || "result"}-${index}`;
        renderedItems.set(resultId, item);

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
            ${renderSourceControl(item, resultId)}
            <p class="result-path">Pagefind source: ${escapeHtml(item.url || "-")}</p>
            <p class="result-hash">id: ${escapeHtml(item.hash || "-")}</p>
            <div class="excerpt-group">
${textBlocks}
            </div>
        </article>
    `;
    }).join("");
}

async function loadResultContext(item) {
    return {
        status: "empty",
        title: item.origin || getSourceTypeLabel(item.sourceType),
        subtitle: `id: ${item.contextParams?.recordId || item.hash || "-"} · source: ${getSourceTypeLabel(item.sourceType)}`,
        message: "详细上下文接口尚未接入。后续可在 loadResultContext(item) 中根据 contextKey/contextParams 拉取对话、阅读物或字幕上下文。",
        rows: [
            {
                speaker: "角色",
                chs: "这里将显示简体中文上下文，并对命中词预留高亮。",
                en: "English context will appear here with highlighted hits."
            }
        ]
    };
}

function renderContextDrawer(state) {
    drawerTitle.textContent = state.title || "详细上下文";
    drawerSubtitle.textContent = state.subtitle || "";

    if (state.status === "loading") {
        drawerContent.innerHTML = '<div class="context-empty">正在加载上下文...</div>';
        return;
    }

    const rows = Array.isArray(state.rows) ? state.rows : [];
    const skeletonRows = rows.map((row) => `
        <div class="context-row">
            <div class="context-cell">${escapeHtml(row.speaker || "-")}</div>
            <div class="context-cell">${escapeHtml(row.chs || "待接入")}</div>
            <div class="context-cell">${escapeHtml(row.en || "Pending")}</div>
        </div>
    `).join("");

    drawerContent.innerHTML = `
        <div class="context-empty">${escapeHtml(state.message || "详细上下文待接入。")}</div>
        <div class="context-skeleton" aria-label="上下文表格占位">
            <div class="context-row is-header">
                <div class="context-cell">角色</div>
                <div class="context-cell">简体中文</div>
                <div class="context-cell">English</div>
            </div>
            ${skeletonRows}
        </div>
    `;
}

async function openContextDrawer(item) {
    drawerBackdrop.hidden = false;
    requestAnimationFrame(() => {
        drawerBackdrop.classList.add("is-open");
    });
    renderContextDrawer({
        status: "loading",
        title: item.origin || "详细上下文",
        subtitle: `id: ${item.hash || "-"}`
    });

    const contextState = await loadResultContext(item);
    renderContextDrawer(contextState);
    drawerClose.focus();
}

function closeContextDrawer() {
    drawerBackdrop.classList.remove("is-open");
    window.setTimeout(() => {
        if (!drawerBackdrop.classList.contains("is-open")) {
            drawerBackdrop.hidden = true;
        }
    }, 240);
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
    status.textContent = `${getLanguageLabel(language)} 索引已就绪。点击 Search 或按 Enter 开始检索。`;
}

async function runSearch(term, language) {
    const currentToken = ++searchToken;
    const keyword = term.trim();
    const processedKeyword = preprocessForCharacterSearch(keyword);
    const exactKeyword = wrapExactQuery(processedKeyword);

    if (!keyword) {
        status.textContent = "请输入关键词。";
        setPlaceholder("结果会显示在这里。页面将查询所选语言索引，并从 text-data 文本桶加载展示文本。");
        return;
    }

    status.textContent = `正在用 ${getLanguageLabel(language)} 检索 "${keyword}"，精确查询为 ${exactKeyword} ...`;
    setPlaceholder("正在按需加载匹配索引分片和文本桶...");

    try {
        await ensureReady(language);
        const search = await pagefind.search(exactKeyword, {});

        if (!search || currentToken !== searchToken) {
            return;
        }

        if (!search.results.length) {
            status.textContent = `${getLanguageLabel(language)} 中没有找到 "${keyword}"。`;
            setPlaceholder("没有找到匹配结果。可以尝试更短或更常见的关键词。");
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
            status.textContent = `${getLanguageLabel(language)} 中没有找到连续命中的 "${keyword}"。`;
            setPlaceholder("Pagefind 找到了粗略匹配，但没有结果通过前端连续命中过滤。");
            return;
        }

        status.textContent = `在 ${getLanguageLabel(language)} 中找到 ${filteredItems.length} 条展示结果，来自 ${search.results.length} 个 Pagefind 分组命中。`;
        renderItems(filteredItems, language);
    } catch (error) {
        console.error(error);
        status.textContent = "搜索失败。请通过 HTTP server 打开本页面，不要直接双击 HTML 文件。";
        setPlaceholder("初始化或搜索失败。请在 DevTools 中检查 <code>pagefind</code> 或 <code>text-data</code> 请求是否缺失。");
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
    status.textContent = `正在切换到 ${getLanguageLabel(language)} 索引...`;
    setPlaceholder("运行搜索后，结果会显示在这里。");

    try {
        await ensureReady(language);
    } catch (error) {
        console.error(error);
        status.textContent = `切换到 ${getLanguageLabel(language)} 索引失败。`;
    }
});

results.addEventListener("click", (event) => {
    const button = event.target.closest(".origin-action[data-result-id]");

    if (!button || button.disabled) {
        return;
    }

    const item = renderedItems.get(button.dataset.resultId);

    if (item) {
        openContextDrawer(item);
    }
});

drawerClose.addEventListener("click", closeContextDrawer);

drawerBackdrop.addEventListener("click", (event) => {
    if (!contextDrawer.contains(event.target)) {
        closeContextDrawer();
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !drawerBackdrop.hidden) {
        closeContextDrawer();
    }
});

syncLanguageUI(activeLanguage);
setPlaceholder("结果会显示在这里。页面将查询所选语言索引，并从 text-data 文本桶加载展示文本。");
ensureReady(activeLanguage).catch((error) => {
    console.error(error);
    status.textContent = "Pagefind 初始化失败。请通过 HTTP server 提供此目录。";
    setPlaceholder("无法加载所选的 <code>./pagefind/&lt;language&gt;/pagefind.js</code> 资源。");
});
