import * as pagefind from "./pagefind/chs/pagefind.js";
import { getSearchPlaceholder } from "./js/core/displayConfig.js";
import { createContextService } from "./js/context/contextService.js";
import { createTextRepository } from "./js/data/textRepository.js";
import { SearchController } from "./js/search/searchController.js";
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

function getLanguageBasePath(language) {
    return new URL(`./pagefind/${language}/`, window.location.href).pathname;
}

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

const numberFormatter = new Intl.NumberFormat("en-US");
const repository = createTextRepository({ baseUrl: window.location.href });
const contextService = createContextService({
    repository,
    getCustomName: getUserCustomName
});
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
const searchController = new SearchController({
    pagefind,
    repository,
    resultsView,
    paginationView,
    numberFormatter,
    getLanguageBasePath,
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

const initialLanguage = languageSelect.value;
syncLanguageUI(initialLanguage);
resultsView.showPlaceholder(
    "结果会显示在这里。页面将查询所选语言索引，并从 text-data 文本桶加载展示文本。"
);
searchController.initialize(initialLanguage).catch((error) => {
    console.error(error);
    status.textContent = "Pagefind 初始化失败。请通过 HTTP server 提供此目录。";
    resultsView.showPlaceholder(
        "无法加载所选的 <code>./pagefind/&lt;language&gt;/pagefind.js</code> 资源。"
    );
});
