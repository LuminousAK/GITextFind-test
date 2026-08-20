const LANGUAGE_LABELS = {
    chs: "简体中文",
    en: "English"
};

let availableLanguageIds = ["chs", "en"];
let comparisonLanguageIds = ["chs", "en"];

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

export function getDisplayLanguages(searchLanguage) {
    return Array.from(new Set([searchLanguage, ...comparisonLanguageIds]))
        .filter((language) => availableLanguageIds.includes(language));
}

export function getLanguageLabel(language) {
    return LANGUAGE_LABELS[language] || language;
}

export function getSearchPlaceholder(language) {
    return SEARCH_PLACEHOLDERS[language] || `输入关键词，使用 ${getLanguageLabel(language)} 索引搜索`;
}

export function getSourceTypeLabel(sourceType) {
    return SOURCE_TYPE_LABELS[sourceType] || SOURCE_TYPE_LABELS.unknown;
}

export function configureDisplay({ languages, comparisonLanguages = [] }) {
    availableLanguageIds = languages.map((language) => language.id);
    comparisonLanguageIds = comparisonLanguages.filter((language) => availableLanguageIds.includes(language));
    for (const language of languages) {
        LANGUAGE_LABELS[language.id] = language.label;
    }
}
