import * as pagefind from "./pagefind/chs/pagefind.js";
import { MyDomElement, parse as parseRichText } from "./textStyleParse.js";
import {
    ExactMatchPaginationError,
    buildExactMatchIndex,
    getPageSlices
} from "./searchPagination.js";
import {
    LatestSearchCoordinator,
    isAbortError,
    loadCachedJson,
    raceWithSignal,
    throwIfAborted
} from "./searchLifecycle.js";

const BUCKET_COUNT = 512;
const PAGE_SIZE = 20;
const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

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
    fetter: "角色语音",
    unknown: "未知来源"
};

const input = document.getElementById("search-input");
const form = document.getElementById("search-form");
const languageSelect = document.getElementById("language-select");
const status = document.getElementById("status");
const results = document.getElementById("results");
const paginationControls = Array.from(document.querySelectorAll("[data-pagination]"), (element) => ({
    element,
    first: element.querySelector('[data-page-action="first"]'),
    previous: element.querySelector('[data-page-action="previous"]'),
    next: element.querySelector('[data-page-action="next"]'),
    last: element.querySelector('[data-page-action="last"]'),
    form: element.querySelector("[data-pagination-form]"),
    input: element.querySelector("[data-pagination-input]"),
    total: element.querySelector("[data-pagination-total]"),
    go: element.querySelector("[data-pagination-go]")
}));
const drawerBackdrop = document.getElementById("drawer-backdrop");
const contextDrawer = document.getElementById("context-drawer");
const drawerClose = document.getElementById("drawer-close");
const drawerTitle = document.getElementById("drawer-title");
const drawerSubtitle = document.getElementById("drawer-subtitle");
const drawerContent = document.getElementById("drawer-content");

let searchToken = 0;
let pageRenderToken = 0;
let activeLanguage = languageSelect.value;
let initializedLanguage = null;
let activeSearchSession = null;

const searchCoordinator = new LatestSearchCoordinator();
const textBucketCache = new Map();
const textBucketRequests = new Map();
const metaBucketCache = new Map();
const renderedItems = new Map();
const namesCache = {};
const questsCache = {};
const sourceTitlesCache = {};

function getLanguageBasePath(language) {
    return new URL(`./pagefind/${language}/`, window.location.href).pathname;
}

function getTextDataUrl(language, fileName) {
    return new URL(`./text-data/${language}/${fileName}`, window.location.href).href;
}

function getTextBucketUrl(language, bucketId) {
    return getTextDataUrl(language, `${bucketId}.json`);
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
    const strHash = String(hash ?? "");

    for (let index = 0; index < strHash.length; index += 1) {
        mixedHash ^= strHash.charCodeAt(index);
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
    renderedItems.clear();
    results.innerHTML = `<div class="placeholder">${message}</div>`;
}

function waitForNextPaint() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => {
            requestAnimationFrame(resolve);
        });
    });
}

async function loadTextBucket(language, bucketId, options = {}) {
    const cacheKey = `${language}:${bucketId}`;
    return loadCachedJson({
        key: cacheKey,
        url: getTextBucketUrl(language, bucketId),
        resolvedCache: textBucketCache,
        pendingRequests: options.pendingRequests || textBucketRequests,
        signal: options.signal,
        errorMessage: `Failed to load text bucket: ${language}/${bucketId}`
    });
}

function loadLookupTable(language, fileName, cache) {
    if (!cache[language]) {
        cache[language] = (async () => {
            const response = await fetch(getTextDataUrl(language, fileName));
            if (!response.ok) {
                return {};
            }
            return response.json();
        })().catch((error) => {
            console.warn(error);
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
            const url = new URL(`./meta-data/${bucketType}/${bucketId}.json`, window.location.href).href;
            const response = await fetch(url);
            if (!response.ok) {
                return {};
            }

            return response.json();
        })());
    }

    return metaBucketCache.get(cacheKey);
}

function parseRecordId(recordId) {
    const id = String(recordId || "unknown");

    if (id.startsWith("talk:")) {
        const [, talkId, textHash] = id.split(":");
        return {
            sourceType: "talk",
            sourceId: talkId,
            textDataKey: textHash,
            bucketKey: talkId,
            originDetail: `talkId: ${talkId}`
        };
    }

    if (id.startsWith("fetter:")) {
        const textHash = id.slice("fetter:".length);
        return {
            sourceType: "fetter",
            sourceId: textHash,
            textDataKey: textHash,
            bucketKey: `fetter:${textHash}`,
            originDetail: textHash
        };
    }

    if (id.startsWith("textmap:")) {
        const textHash = id.slice("textmap:".length);
        return {
            sourceType: "textmap",
            sourceId: textHash,
            textDataKey: textHash,
            bucketKey: `textmap:${textHash}`,
            originDetail: textHash
        };
    }

    if (id.startsWith("readable:")) {
        const sourceId = id.slice("readable:".length);
        return {
            sourceType: "readable",
            sourceId,
            textDataKey: id,
            bucketKey: id,
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
            textDataKey: id,
            bucketKey: `subtitle:${sourceId}`,
            originDetail: segment ? `${sourceId} #${segment}` : sourceId
        };
    }

    return {
        sourceType: "textmap",
        sourceId: id,
        textDataKey: id,
        bucketKey: `textmap:${id}`,
        originDetail: id
    };
}

function getTextBucketIdFromRecordId(recordId) {
    return getBucketId(parseRecordId(recordId).bucketKey);
}

function getTextDataKeyFromRecordId(recordId) {
    return parseRecordId(recordId).textDataKey;
}

function extractRecordIdFromResult(subResult) {
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

async function hydrateOriginalTexts(items, language, options = {}) {
    throwIfAborted(options.signal);

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
                const bucket = await loadTextBucket(displayLanguage, bucketId, options);
                return [displayLanguage, String(bucket[lookupKey] ?? "")];
            } catch (error) {
                if (isAbortError(error, options.signal)) {
                    throw error;
                }

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

function buildResultSourceMeta(item, keyword = "") {
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
            searchLanguage: item.searchLanguage || activeLanguage,
            keyword
        }
    };
}

function validateExactMatchDocument(searchResult, document, resultIndex) {
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

function flattenPageSlices(loadedSlices, language, keyword) {
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

function renderItems(items, language, keyword) {
    const languageLabel = getLanguageLabel(language);
    renderedItems.clear();
    const resultFragment = document.createDocumentFragment();

    items.forEach((item, index) => {
        const resultId = `${item.contextKey || item.hash || "result"}-${index}`;
        renderedItems.set(resultId, item);

        const displayLanguages = item.displayLanguages?.length ? item.displayLanguages : getDisplayLanguages(language);
        const article = document.createElement("article");
        article.className = "result";
        article.innerHTML = `
            <span class="result-kind">Matched in ${escapeHtml(languageLabel)}</span>
            <h2>${escapeHtml(item.title)}</h2>
            ${renderSourceControl(item, resultId)}
            <p class="result-path">Pagefind source: ${escapeHtml(item.url || "-")}</p>
            <p class="result-hash">id: ${escapeHtml(item.hash || "-")}</p>
            <div class="excerpt-group"></div>
        `;

        const excerptGroup = article.querySelector(".excerpt-group");
        for (const displayLanguage of displayLanguages) {
            const block = document.createElement("div");
            block.className = "excerpt-block";

            const label = document.createElement("p");
            label.className = "excerpt-label";
            label.textContent = getLanguageLabel(displayLanguage);

            const excerpt = document.createElement("div");
            excerpt.className = "excerpt";
            excerpt.appendChild(stylizeText(
                item.texts[displayLanguage] || "No text available.",
                keyword
            ));

            block.append(label, excerpt);
            excerptGroup.appendChild(block);
        }

        resultFragment.appendChild(article);
    });

    results.replaceChildren(resultFragment);
}

function _createStyledSpan(node) {
    const span = document.createElement("span");
    if (node.tagName === "color") {
        if (!String(node.tagValue || "").toLowerCase().startsWith("#ffffff")) {
            span.style.color = node.tagValue;
        }
    } else if (node.tagName === "i") {
        span.style.fontStyle = "italic";
    }

    return span;
}

function _appendTextWithHighlight(container, text, lowerKeyword) {
    if (!lowerKeyword || !text) {
        container.appendChild(document.createTextNode(text));
        return;
    }

    const lowerText = text.toLowerCase();
    let position = 0;

    while (position < text.length) {
        const matchIndex = lowerText.indexOf(lowerKeyword, position);
        if (matchIndex === -1) {
            container.appendChild(document.createTextNode(text.substring(position)));
            break;
        }

        if (matchIndex > position) {
            container.appendChild(document.createTextNode(text.substring(position, matchIndex)));
        }

        const mark = document.createElement("mark");
        mark.className = "keyword-highlight";
        mark.textContent = text.substring(matchIndex, matchIndex + lowerKeyword.length);
        container.appendChild(mark);
        position = matchIndex + lowerKeyword.length;
    }
}

function _iterateRichNode(node, lineElements, containerStack, labelStack, lowerKeyword) {
    let container = containerStack[containerStack.length - 1];
    if (node.tagName !== "root") {
        labelStack.push(node);
    }

    for (const child of node.children) {
        if (typeof child === "string") {
            const lines = child.split("\n");
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
                if (lineIndex > 0) {
                    const newParagraph = document.createElement("p");
                    lineElements.push(newParagraph);
                    containerStack[0] = newParagraph;
                    let stackIndex = 1;

                    for (const label of labelStack) {
                        const span = _createStyledSpan(label);
                        (stackIndex === 1 ? newParagraph : containerStack[stackIndex - 1]).appendChild(span);
                        containerStack[stackIndex] = span;
                        container = span;
                        stackIndex += 1;
                    }
                }

                _appendTextWithHighlight(container, lines[lineIndex], lowerKeyword);
            }
        } else {
            const span = _createStyledSpan(child);
            containerStack.push(span);
            container.appendChild(span);
            _iterateRichNode(child, lineElements, containerStack, labelStack, lowerKeyword);
        }
    }

    labelStack.pop();
    containerStack.pop();
}

function buildPlainTextFragment(text, lowerKeyword) {
    const fragment = document.createDocumentFragment();
    const lines = String(text ?? "").split("\n");

    for (const line of lines) {
        const paragraph = document.createElement("p");
        _appendTextWithHighlight(paragraph, line, lowerKeyword);
        fragment.appendChild(paragraph);
    }

    return fragment;
}

function stylizeText(text, keyword) {
    if (!text) {
        return document.createDocumentFragment();
    }

    const lowerKeyword = keyword ? keyword.toLowerCase() : "";

    try {
        const root = new MyDomElement();
        root.children = parseRichText(text);
        root.tagName = "root";

        const fragment = document.createDocumentFragment();
        const firstParagraph = document.createElement("p");
        const lineElements = [firstParagraph];
        const containerStack = [firstParagraph];
        const labelStack = [];

        _iterateRichNode(root, lineElements, containerStack, labelStack, lowerKeyword);

        for (const element of lineElements) {
            fragment.appendChild(element);
        }

        return fragment;
    } catch (error) {
        console.warn("Failed to parse rich text.", error);
        return buildPlainTextFragment(text, lowerKeyword);
    }
}

async function loadTextBucketsForLanguages(displayLangs, bucketId) {
    const entries = await Promise.all(displayLangs.map(async (language) => {
        try {
            return [language, await loadTextBucket(language, bucketId)];
        } catch (error) {
            console.warn(error);
            return [language, {}];
        }
    }));

    return Object.fromEntries(entries);
}

function buildQuestTitle(questHashes, questsMap) {
    if (!questHashes) {
        return "对话文本";
    }

    const questTitle = questsMap[questHashes.questTitleHash] || null;
    if (!questTitle) {
        return "对话文本";
    }

    const chapterTitle = questHashes.chapterTitleHash ? questsMap[questHashes.chapterTitleHash] : null;
    const chapterNum = questHashes.chapterNumHash ? questsMap[questHashes.chapterNumHash] : null;

    if (!chapterTitle) {
        return questTitle;
    }
    if (chapterNum) {
        return `${chapterNum} · ${chapterTitle} · ${questTitle}`;
    }

    return `${chapterTitle} · ${questTitle}`;
}

function getUserCustomName(key) {
    try {
        return window.localStorage.getItem(`gi-text-search-custom-name:${key}`) || null;
    } catch {
        return null;
    }
}

function resolveSpeakerName(nameHash, namesMap) {
    if (nameHash === "PLAYER") {
        return getUserCustomName("player") || "主角";
    }
    if (nameHash === "MATE_AVATAR") {
        return getUserCustomName("mate") || "反主";
    }
    if (nameHash === null || nameHash === undefined) {
        return "";
    }

    const name = namesMap[nameHash];
    if (!name) {
        return "";
    }

    if (name.includes("#{REALNAME[ID(1)")) {
        return getUserCustomName("wanderer") || "流浪者";
    }

    return name;
}

function parseSubtitleStartMs(timeKey) {
    const startPart = String(timeKey || "").split("-")[0];
    return Number(startPart) || 0;
}

async function loadTalkContext(recordId, displayLangs, keyword) {
    const [, talkId, hitHash] = String(recordId).split(":");
    const talkBucketId = getBucketId(talkId);
    const [talkDetailsBucket, primaryNames, primaryQuests, textBucketsByLang] = await Promise.all([
        loadMetaBucket("talk-details", talkBucketId),
        loadNames(displayLangs[0]),
        loadQuests(displayLangs[0]),
        loadTextBucketsForLanguages(displayLangs, talkBucketId)
    ]);

    const talkData = talkDetailsBucket[talkId];
    if (!talkData) {
        return {
            status: "empty",
            title: "对话文本",
            subtitle: "",
            message: "未找到对话数据。",
            rows: []
        };
    }

    const title = buildQuestTitle(talkData.questHashes, primaryQuests);
    const rows = talkData.dialogues.map((dialogue) => ({
        hash: dialogue.hash,
        isHit: dialogue.hash === hitHash,
        speaker: resolveSpeakerName(dialogue.nameHash, primaryNames),
        cells: Object.fromEntries(displayLangs.map((language) => [
            language,
            textBucketsByLang[language]?.[dialogue.hash] || ""
        ]))
    }));

    return {
        status: "ok",
        title,
        subtitle: `talkId: ${talkId}`,
        rows,
        hitHash,
        keyword
    };
}

async function loadSubtitleContext(recordId, displayLangs, keyword) {
    const parsed = parseRecordId(recordId);
    const filePath = parsed.sourceId;
    const hitSegment = parsed.segment;
    const hitStartMs = parseSubtitleStartMs(hitSegment);
    const bucketId = getBucketId(parsed.bucketKey);
    const textBucketsByLang = await loadTextBucketsForLanguages(displayLangs, bucketId);
    const prefix = `subtitle:${filePath}:`;
    const segments = [];

    for (const language of displayLangs) {
        const bucket = textBucketsByLang[language] || {};
        for (const [key, text] of Object.entries(bucket)) {
            if (!key.startsWith(prefix)) {
                continue;
            }

            const timeKey = key.slice(prefix.length);
            segments.push({
                lang: language,
                key,
                text,
                timeKey,
                startMs: parseSubtitleStartMs(timeKey)
            });
        }
    }

    const thresholdMs = 500;
    segments.sort((left, right) => left.startMs - right.startMs || left.lang.localeCompare(right.lang));

    const rows = [];
    for (const segment of segments) {
        const lastRow = rows[rows.length - 1];
        const canMerge = (
            lastRow
            && Math.abs(lastRow.startMs - segment.startMs) < thresholdMs
            && !lastRow.cells[segment.lang]
        );

        if (canMerge) {
            lastRow.cells[segment.lang] = segment.text;
            lastRow.keys[segment.lang] = segment.key;
            lastRow.isHit ||= Math.abs(segment.startMs - hitStartMs) < thresholdMs;
            continue;
        }

        rows.push({
            hash: segment.key,
            keys: { [segment.lang]: segment.key },
            startMs: segment.startMs,
            isHit: Math.abs(segment.startMs - hitStartMs) < thresholdMs,
            speaker: "",
            cells: { [segment.lang]: segment.text }
        });
    }

    return {
        status: "ok",
        title: `字幕: ${filePath}`,
        subtitle: "",
        rows,
        hitHash: `${prefix}${hitSegment}`,
        keyword
    };
}

async function loadSingleHashContext(recordId, displayLangs, keyword) {
    const parsed = parseRecordId(recordId);
    const bucketId = getTextBucketIdFromRecordId(recordId);
    const lookupKey = getTextDataKeyFromRecordId(recordId);
    const textBucketsByLang = await loadTextBucketsForLanguages(displayLangs, bucketId);
    const row = {
        hash: parsed.textDataKey,
        isHit: true,
        speaker: "",
        cells: {}
    };

    for (const language of displayLangs) {
        row.cells[language] = textBucketsByLang[language]?.[lookupKey] || "";
    }

    return {
        status: "ok",
        title: getSourceTypeLabel(parsed.sourceType),
        subtitle: parsed.originDetail,
        rows: [row],
        hitHash: parsed.textDataKey,
        keyword
    };
}

async function loadReadableContext(recordId, displayLangs, keyword) {
    return loadSingleHashContext(recordId, displayLangs, keyword);
}

async function loadFetterContext(recordId, displayLangs, keyword) {
    const parsed = parseRecordId(recordId);
    const textHash = parsed.textDataKey;
    const primaryLanguage = displayLangs[0];
    const [metaBucket, names, sourceTitles, single] = await Promise.all([
        loadMetaBucket("hash-to-fetter", getBucketId(textHash)),
        loadNames(primaryLanguage),
        loadSourceTitles(primaryLanguage),
        loadSingleHashContext(recordId, displayLangs, keyword)
    ]);
    const fetter = metaBucket[textHash] || {};
    const avatarName = fetter.avatarNameHash ? names[fetter.avatarNameHash] : "";
    const voiceTitle = fetter.voiceTitleHash ? sourceTitles[fetter.voiceTitleHash] : "";

    return {
        ...single,
        title: [avatarName, voiceTitle].filter(Boolean).join(" · ") || "角色语音",
        subtitle: `textHash: ${textHash}`
    };
}

async function loadResultContext(item) {
    const recordId = item.contextParams?.recordId || item.hash;
    const parsed = parseRecordId(recordId);
    const searchLang = item.contextParams?.searchLanguage || activeLanguage;
    const keyword = item.contextParams?.keyword || "";
    const displayLangs = getDisplayLanguages(searchLang);

    if (parsed.sourceType === "talk") {
        return loadTalkContext(recordId, displayLangs, keyword);
    }
    if (parsed.sourceType === "subtitle") {
        return loadSubtitleContext(recordId, displayLangs, keyword);
    }
    if (parsed.sourceType === "readable") {
        return loadReadableContext(recordId, displayLangs, keyword);
    }
    if (parsed.sourceType === "fetter") {
        return loadFetterContext(recordId, displayLangs, keyword);
    }

    return loadSingleHashContext(recordId, displayLangs, keyword);
}

function renderContextDrawer(state) {
    drawerTitle.textContent = state.title || "详细上下文";
    drawerSubtitle.textContent = state.subtitle || "";

    if (state.status === "loading") {
        drawerContent.innerHTML = '<div class="context-empty">正在加载上下文...</div>';
        return;
    }

    if (!state.rows || state.rows.length === 0) {
        drawerContent.innerHTML = `<div class="context-empty">${escapeHtml(state.message || "无上下文数据。")}</div>`;
        return;
    }

    const displayLangs = state.rows[0]?.cells ? Object.keys(state.rows[0].cells) : [];
    if (!displayLangs.length) {
        drawerContent.innerHTML = `<div class="context-empty">${escapeHtml(state.message || "无上下文数据。")}</div>`;
        return;
    }

    const keyword = state.keyword || "";
    const table = document.createElement("div");
    table.className = "context-table";
    table.style.setProperty("--context-lang-count", String(displayLangs.length));

    const headerRow = document.createElement("div");
    headerRow.className = "context-row is-header";
    headerRow.innerHTML = [
        '<div class="context-cell context-cell-speaker">角色</div>',
        ...displayLangs.map((language) => `<div class="context-cell">${escapeHtml(getLanguageLabel(language))}</div>`)
    ].join("");
    table.appendChild(headerRow);

    let hitRowAssigned = false;
    for (const row of state.rows) {
        const rowEl = document.createElement("div");
        rowEl.className = `context-row${row.isHit ? " context-hit" : ""}`;

        if (row.isHit && !hitRowAssigned) {
            rowEl.id = "context-hit-row";
            hitRowAssigned = true;
        }

        const speakerCell = document.createElement("div");
        speakerCell.className = "context-cell context-cell-speaker";
        speakerCell.textContent = row.speaker || "";
        rowEl.appendChild(speakerCell);

        for (const language of displayLangs) {
            const cell = document.createElement("div");
            cell.className = "context-cell";
            cell.appendChild(stylizeText(row.cells[language] || "", keyword));
            rowEl.appendChild(cell);
        }

        table.appendChild(rowEl);
    }

    drawerContent.innerHTML = "";
    drawerContent.appendChild(table);

    const hitRow = drawerContent.querySelector("#context-hit-row");
    if (hitRow) {
        requestAnimationFrame(() => {
            hitRow.scrollIntoView({ behavior: "smooth", block: "center" });
        });
    }
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

    try {
        const contextState = await loadResultContext(item);
        renderContextDrawer(contextState);
    } catch (error) {
        console.error(error);
        renderContextDrawer({
            status: "empty",
            title: item.origin || "详细上下文",
            subtitle: `id: ${item.hash || "-"}`,
            message: "上下文加载失败，请在控制台查看详细错误。"
        });
    }

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

function clearSearchSession() {
    activeSearchSession = null;
    pageRenderToken += 1;
    renderedItems.clear();
    for (const controls of paginationControls) {
        controls.element.hidden = true;
    }
    results.setAttribute("aria-busy", "false");
}

function setPaginationControls(session, pageState, isLoading) {
    const hasMultiplePages = Boolean(session) && pageState.totalPages > 1;
    results.setAttribute("aria-busy", isLoading ? "true" : "false");

    for (const controls of paginationControls) {
        controls.element.hidden = !hasMultiplePages;

        if (!session || pageState.totalPages === 0) {
            continue;
        }

        controls.input.value = String(pageState.page);
        controls.input.max = String(pageState.totalPages);
        controls.total.textContent = `/ ${NUMBER_FORMATTER.format(pageState.totalPages)}`;

        controls.first.disabled = isLoading || pageState.page <= 1;
        controls.previous.disabled = isLoading || pageState.page <= 1;
        controls.next.disabled = isLoading || pageState.page >= pageState.totalPages;
        controls.last.disabled = isLoading || pageState.page >= pageState.totalPages;
        controls.input.disabled = isLoading;
        controls.go.disabled = isLoading;
    }
}

function updatePageStatus(session, pageState, isLoading) {
    const total = NUMBER_FORMATTER.format(session.index.total);
    const page = NUMBER_FORMATTER.format(pageState.page);
    const totalPages = NUMBER_FORMATTER.format(pageState.totalPages);

    if (isLoading) {
        status.textContent = `找到 ${total} 条，正在加载第 ${page} / ${totalPages} 页...`;
        return;
    }

    const firstResult = NUMBER_FORMATTER.format(pageState.start + 1);
    const lastResult = NUMBER_FORMATTER.format(pageState.end);
    status.textContent = `找到 ${total} 条，正在显示 ${firstResult}–${lastResult} 条，第 ${page} / ${totalPages} 页`;
}

function loadSessionFragment(session, resultIndex) {
    if (!session.fragmentPromises.has(resultIndex)) {
        const dataPromise = Promise.resolve()
            .then(() => {
                throwIfAborted(session.signal);
                return session.searchResults[resultIndex].data();
            });
        const promise = raceWithSignal(dataPromise, session.signal)
            .catch((error) => {
                session.fragmentPromises.delete(resultIndex);
                throw error;
            });
        session.fragmentPromises.set(resultIndex, promise);
    }

    return session.fragmentPromises.get(resultIndex);
}

async function renderSearchPage(session, requestedPage) {
    if (
        session !== activeSearchSession
        || session.searchToken !== searchToken
        || !searchCoordinator.isCurrent(session.searchRun)
    ) {
        return false;
    }

    const pageState = getPageSlices(session.index, requestedPage, PAGE_SIZE);
    const currentPageRenderToken = ++pageRenderToken;
    searchCoordinator.setBusy(session.searchRun, true);
    session.currentPage = pageState.page;
    session.loading = true;

    setPaginationControls(session, pageState, true);
    updatePageStatus(session, pageState, true);
    setPlaceholder(`正在加载第 ${NUMBER_FORMATTER.format(pageState.page)} 页的匹配 fragment 和双语文本...`);
    await waitForNextPaint();

    if (
        session !== activeSearchSession
        || session.searchToken !== searchToken
        || currentPageRenderToken !== pageRenderToken
        || !searchCoordinator.isCurrent(session.searchRun)
    ) {
        return false;
    }

    try {
        const loadedSlices = await Promise.all(pageState.slices.map(async (slice) => {
            const searchResult = session.searchResults[slice.resultIndex];
            const document = await loadSessionFragment(session, slice.resultIndex);
            validateExactMatchDocument(searchResult, document, slice.resultIndex);
            return { slice, searchResult, document };
        }));

        if (
            session !== activeSearchSession
            || session.searchToken !== searchToken
            || currentPageRenderToken !== pageRenderToken
            || !searchCoordinator.isCurrent(session.searchRun)
        ) {
            return false;
        }

        const items = flattenPageSlices(loadedSlices, session.language, session.keyword);
        const hydratedItems = await hydrateOriginalTexts(items, session.language, {
            signal: session.signal,
            pendingRequests: session.textBucketPromises
        });

        if (
            session !== activeSearchSession
            || session.searchToken !== searchToken
            || currentPageRenderToken !== pageRenderToken
            || !searchCoordinator.isCurrent(session.searchRun)
        ) {
            return false;
        }

        if (hydratedItems.length !== pageState.end - pageState.start) {
            throw new Error(
                `Expected ${pageState.end - pageState.start} paged results, received ${hydratedItems.length}.`
            );
        }

        renderItems(hydratedItems, session.language, session.keyword);
        session.loading = false;
        searchCoordinator.setBusy(session.searchRun, false);
        setPaginationControls(session, pageState, false);
        updatePageStatus(session, pageState, false);
        return true;
    } catch (error) {
        if (isAbortError(error, session.signal)) {
            return false;
        }

        if (
            session !== activeSearchSession
            || session.searchToken !== searchToken
            || currentPageRenderToken !== pageRenderToken
            || !searchCoordinator.isCurrent(session.searchRun)
        ) {
            return false;
        }

        console.error(error);
        session.loading = false;
        searchCoordinator.setBusy(session.searchRun, false);
        setPaginationControls(session, pageState, false);
        status.textContent = `第 ${NUMBER_FORMATTER.format(pageState.page)} 页加载失败。`;
        setPlaceholder("分页结果加载失败。请重试当前页，并在 DevTools 中检查 fragment 或 text-data 请求。");
        return false;
    }
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
    const keyword = term.trim();
    const processedKeyword = preprocessForCharacterSearch(keyword);
    const exactKeyword = wrapExactQuery(processedKeyword);

    if (!keyword) {
        searchCoordinator.cancel();
        searchToken += 1;
        clearSearchSession();
        status.textContent = "请输入关键词。";
        setPlaceholder("结果会显示在这里。页面将查询所选语言索引，并从 text-data 文本桶加载展示文本。");
        return;
    }

    const requestKey = `${language}\u0000${keyword}`;
    const { accepted, run } = searchCoordinator.start(requestKey);
    if (!accepted) {
        return;
    }

    const currentToken = ++searchToken;
    clearSearchSession();

    status.textContent = `正在用 ${getLanguageLabel(language)} 检索 "${keyword}"，精确查询为 ${exactKeyword} ...`;
    setPlaceholder("正在按需加载匹配索引分片和文本桶...");

    try {
        await ensureReady(language);
        throwIfAborted(run.signal);
        const search = await raceWithSignal(
            pagefind.search(exactKeyword, {}),
            run.signal
        );
        throwIfAborted(run.signal);

        if (
            !search
            || currentToken !== searchToken
            || !searchCoordinator.isCurrent(run)
        ) {
            return;
        }

        const index = buildExactMatchIndex(search.results);
        if (
            Number.isSafeInteger(search.exactMatchCount)
            && search.exactMatchCount !== index.total
        ) {
            console.warn(
                `Pagefind exactMatchCount mismatch: response=${search.exactMatchCount}, results=${index.total}. `
                + "Using the per-result prefix sum."
            );
        }

        status.textContent = `找到 ${NUMBER_FORMATTER.format(index.total)} 条`;

        if (index.total === 0) {
            searchCoordinator.setBusy(run, false);
            for (const controls of paginationControls) {
                controls.element.hidden = true;
            }
            setPlaceholder("没有找到匹配结果。可以尝试更短或更常见的关键词。");
            return;
        }

        const session = {
            searchToken: currentToken,
            searchRun: run,
            controller: run.controller,
            signal: run.signal,
            keyword,
            language,
            searchResults: search.results,
            index,
            currentPage: 1,
            loading: false,
            fragmentPromises: new Map(),
            textBucketPromises: new Map()
        };
        activeSearchSession = session;
        await renderSearchPage(session, 1);
    } catch (error) {
        if (
            isAbortError(error, run.signal)
            || currentToken !== searchToken
            || !searchCoordinator.isCurrent(run)
        ) {
            return;
        }

        console.error(error);
        searchCoordinator.setBusy(run, false);
        clearSearchSession();
        if (error instanceof ExactMatchPaginationError) {
            status.textContent = "当前 Pagefind 搜索结果不支持精确分页。";
            setPlaceholder(escapeHtml(error.message));
        } else {
            status.textContent = "搜索失败。请通过 HTTP server 打开本页面，不要直接双击 HTML 文件。";
            setPlaceholder("初始化或搜索失败。请在 DevTools 中检查 <code>pagefind</code> 或 <code>text-data</code> 请求是否缺失。");
        }
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
    searchCoordinator.cancel();
    const currentToken = ++searchToken;
    clearSearchSession();
    const language = languageSelect.value;
    syncLanguageUI(language);
    status.textContent = `正在切换到 ${getLanguageLabel(language)} 索引...`;
    setPlaceholder("运行搜索后，结果会显示在这里。");

    try {
        await ensureReady(language);
        if (currentToken !== searchToken) {
            return;
        }
    } catch (error) {
        console.error(error);
        status.textContent = `切换到 ${getLanguageLabel(language)} 索引失败。`;
    }
});

async function navigateToPage(page) {
    const session = activeSearchSession;
    if (!session || session.loading) {
        return;
    }

    const pageState = getPageSlices(session.index, page, PAGE_SIZE);
    if (pageState.page === session.currentPage) {
        setPaginationControls(session, pageState, false);
        return;
    }

    await renderSearchPage(session, pageState.page);
}

for (const controls of paginationControls) {
    controls.element.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-page-action]");
        const session = activeSearchSession;
        if (!button || !session || session.loading) {
            return;
        }

        const totalPages = Math.ceil(session.index.total / PAGE_SIZE);
        const targetPages = {
            first: 1,
            previous: session.currentPage - 1,
            next: session.currentPage + 1,
            last: totalPages
        };
        navigateToPage(targetPages[button.dataset.pageAction]);
    });

    controls.form.addEventListener("submit", (event) => {
        event.preventDefault();
        navigateToPage(controls.input.value);
    });
}

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
