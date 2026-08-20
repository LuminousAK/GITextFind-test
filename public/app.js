import { configureDisplay, getSearchPlaceholder } from "./js/core/displayConfig.js";
import { loadRuntimeData } from "./js/config/runtimeConfig.js";
import { createContextService } from "./js/context/contextService.js";
import { createTextRepository } from "./js/data/textRepository.js";
import { SearchController } from "./js/search/searchController.js";
import { createPagefindLoader } from "./js/search/pagefindLoader.js";
import { createContextDrawer } from "./js/ui/contextDrawer.js";
import { createPaginationView } from "./js/ui/paginationView.js";
import { createResultsView } from "./js/ui/resultsView.js";

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
const numberFormatter = new Intl.NumberFormat("en-US");

function getUserCustomName(key) {
    try {
        return window.localStorage.getItem(`gi-text-search-custom-name:${key}`) || null;
    } catch {
        return null;
    }
}

function syncLanguageUI(language) {
    input.placeholder = getSearchPlaceholder(language);
}

const resultsView = createResultsView({ container: results });
const paginationView = createPaginationView({
    controls: paginationControls,
    numberFormatter
});
const contextDrawer = createContextDrawer({
    backdrop: document.getElementById("drawer-backdrop"),
    drawer: document.getElementById("context-drawer"),
    closeButton: document.getElementById("drawer-close"),
    titleElement: document.getElementById("drawer-title"),
    subtitleElement: document.getElementById("drawer-subtitle"),
    contentElement: document.getElementById("drawer-content")
});
resultsView.showPlaceholder(
    "正在读取运行配置和可用语言..."
);

async function initializeApplication() {
    const runtime = await loadRuntimeData();
    configureDisplay({
        languages: runtime.languages,
        comparisonLanguages: runtime.config.comparisonLanguages
    });

    languageSelect.replaceChildren(...runtime.languages.map((language) => {
        const option = document.createElement("option");
        option.value = language.id;
        option.textContent = language.label;
        return option;
    }));
    languageSelect.value = runtime.config.defaultLanguage;

    const textDataBaseUrls = Object.fromEntries(
        runtime.languages.map((language) => [language.id, language.textDataBaseUrl])
    );
    const repository = createTextRepository({
        textDataBaseUrls,
        metaDataBaseUrl: runtime.shared.metaDataBaseUrl
    });
    const contextService = createContextService({
        repository,
        getCustomName: getUserCustomName
    });
    const pagefindLoader = createPagefindLoader({
        languageConfigs: runtime.languages,
        pageUrl: window.location.href
    });
    const searchController = new SearchController({
        pagefindLoader,
        repository,
        resultsView,
        paginationView,
        numberFormatter,
        setStatus(message) {
            status.textContent = message;
        }
    });

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        searchController.search(input.value, languageSelect.value);
    });
    languageSelect.addEventListener("change", () => {
        const language = languageSelect.value;
        syncLanguageUI(language);
        searchController.changeLanguage(language);
    });
    resultsView.setContextRequestHandler(async (item) => {
        contextDrawer.open(item);
        try {
            const contextState = await contextService.loadContext(item, languageSelect.value);
            contextDrawer.render(contextState);
        } catch (error) {
            console.error(error);
            contextDrawer.renderError(item);
        }
        contextDrawer.focusCloseButton();
    });

    const initialLanguage = runtime.config.defaultLanguage;
    syncLanguageUI(initialLanguage);
    resultsView.showPlaceholder(
        "结果会显示在这里。页面将查询所选语言索引，并按需加载 R2 文本桶。"
    );
    await searchController.initialize(initialLanguage);
    if (runtime.warnings.length > 0) {
        const skipped = runtime.warnings.map((warning) => warning.language).join(", ");
        status.textContent += ` 已跳过不可用语言：${skipped}。`;
    }
}

initializeApplication().catch((error) => {
    console.error(error);
    languageSelect.disabled = true;
    status.textContent = "初始化失败：无法加载运行配置或共享数据。";
    resultsView.showPlaceholder(
        "请检查 <code>runtime-config.json</code>、R2 自定义域名、manifest 与 CORS 配置。"
    );
});
