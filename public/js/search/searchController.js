import { getLanguageLabel } from "../core/displayConfig.js";
import { preprocessForCharacterSearch, wrapExactQuery } from "../core/searchQuery.js";
import {
    LatestSearchCoordinator,
    isAbortError,
    raceWithSignal,
    throwIfAborted
} from "./searchLifecycle.js";
import {
    ExactMatchPaginationError,
    buildExactMatchIndex,
    getPageSlices
} from "./searchPagination.js";
import {
    flattenPageSlices,
    hydrateOriginalTexts,
    validateExactMatchDocument
} from "./searchResults.js";

const PAGE_SIZE = 20;

function waitForNextPaint() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => {
            requestAnimationFrame(resolve);
        });
    });
}

export class SearchController {
    constructor({
        pagefindLoader,
        repository,
        resultsView,
        paginationView,
        setStatus,
        numberFormatter = new Intl.NumberFormat("en-US")
    }) {
        this.pagefind = null;
        this.pagefindLoader = pagefindLoader;
        this.repository = repository;
        this.resultsView = resultsView;
        this.paginationView = paginationView;
        this.setStatus = setStatus;
        this.numberFormatter = numberFormatter;

        this.searchToken = 0;
        this.pageRenderToken = 0;
        this.initializedLanguage = null;
        this.activeSearchSession = null;
        this.searchCoordinator = new LatestSearchCoordinator();

        this.paginationView.setNavigateHandler((page) => {
            this.navigateToPage(page);
        });
    }

    clearSearchSession() {
        this.activeSearchSession = null;
        this.pageRenderToken += 1;
        this.paginationView.hide();
        this.resultsView.setBusy(false);
    }

    updatePageStatus(session, pageState, isLoading) {
        const total = this.numberFormatter.format(session.index.total);
        const page = this.numberFormatter.format(pageState.page);
        const totalPages = this.numberFormatter.format(pageState.totalPages);

        if (isLoading) {
            this.setStatus(`找到 ${total} 条，正在加载第 ${page} / ${totalPages} 页...`);
            return;
        }

        const firstResult = this.numberFormatter.format(pageState.start + 1);
        const lastResult = this.numberFormatter.format(pageState.end);
        this.setStatus(`找到 ${total} 条，正在显示 ${firstResult}–${lastResult} 条，第 ${page} / ${totalPages} 页`);
    }

    loadSessionFragment(session, resultIndex) {
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

    isCurrentPageRender(session, currentPageRenderToken) {
        return (
            session === this.activeSearchSession
            && session.searchToken === this.searchToken
            && currentPageRenderToken === this.pageRenderToken
            && this.searchCoordinator.isCurrent(session.searchRun)
        );
    }

    async renderSearchPage(session, requestedPage) {
        if (
            session !== this.activeSearchSession
            || session.searchToken !== this.searchToken
            || !this.searchCoordinator.isCurrent(session.searchRun)
        ) {
            return false;
        }

        const pageState = getPageSlices(session.index, requestedPage, PAGE_SIZE);
        const currentPageRenderToken = ++this.pageRenderToken;
        this.searchCoordinator.setBusy(session.searchRun, true);
        session.currentPage = pageState.page;
        session.loading = true;

        this.resultsView.setBusy(true);
        this.paginationView.render(pageState, true);
        this.updatePageStatus(session, pageState, true);
        this.resultsView.showPlaceholder(
            `正在加载第 ${this.numberFormatter.format(pageState.page)} 页的匹配 fragment 和双语文本...`
        );
        await waitForNextPaint();

        if (!this.isCurrentPageRender(session, currentPageRenderToken)) {
            return false;
        }

        try {
            const loadedSlices = await Promise.all(pageState.slices.map(async (slice) => {
                const searchResult = session.searchResults[slice.resultIndex];
                const document = await this.loadSessionFragment(session, slice.resultIndex);
                validateExactMatchDocument(searchResult, document, slice.resultIndex);
                return { slice, searchResult, document };
            }));

            if (!this.isCurrentPageRender(session, currentPageRenderToken)) {
                return false;
            }

            const items = flattenPageSlices(loadedSlices, session.language, session.keyword);
            const hydratedItems = await hydrateOriginalTexts(items, session.language, {
                repository: this.repository,
                signal: session.signal,
                pendingRequests: session.textBucketPromises
            });

            if (!this.isCurrentPageRender(session, currentPageRenderToken)) {
                return false;
            }

            if (hydratedItems.length !== pageState.end - pageState.start) {
                throw new Error(
                    `Expected ${pageState.end - pageState.start} paged results, received ${hydratedItems.length}.`
                );
            }

            this.resultsView.render(hydratedItems, session.language, session.keyword);
            session.loading = false;
            this.searchCoordinator.setBusy(session.searchRun, false);
            this.resultsView.setBusy(false);
            this.paginationView.render(pageState, false);
            this.updatePageStatus(session, pageState, false);
            return true;
        } catch (error) {
            if (isAbortError(error, session.signal)) {
                return false;
            }

            if (!this.isCurrentPageRender(session, currentPageRenderToken)) {
                return false;
            }

            console.error(error);
            session.loading = false;
            this.searchCoordinator.setBusy(session.searchRun, false);
            this.resultsView.setBusy(false);
            this.paginationView.render(pageState, false);
            this.setStatus(`第 ${this.numberFormatter.format(pageState.page)} 页加载失败。`);
            this.resultsView.showPlaceholder(
                "分页结果加载失败。请重试当前页，并在 DevTools 中检查 fragment 或 text-data 请求。"
            );
            return false;
        }
    }

    async ensureReady(language) {
        if (this.initializedLanguage === language) {
            return;
        }

        this.initializedLanguage = null;
        this.pagefind = await this.pagefindLoader.load(language);
        this.initializedLanguage = language;
        this.setStatus(`${getLanguageLabel(language)} 索引已就绪。点击 Search 或按 Enter 开始检索。`);
    }

    initialize(language) {
        return this.ensureReady(language);
    }

    async search(term, language) {
        const keyword = term.trim();
        const processedKeyword = preprocessForCharacterSearch(keyword);
        const exactKeyword = wrapExactQuery(processedKeyword);

        if (!keyword) {
            this.searchCoordinator.cancel();
            this.searchToken += 1;
            this.clearSearchSession();
            this.setStatus("请输入关键词。");
            this.resultsView.showPlaceholder(
                "结果会显示在这里。页面将查询所选语言索引，并从 text-data 文本桶加载展示文本。"
            );
            return;
        }

        const requestKey = `${language}\u0000${keyword}`;
        const { accepted, run } = this.searchCoordinator.start(requestKey);
        if (!accepted) {
            return;
        }

        const currentToken = ++this.searchToken;
        this.clearSearchSession();

        this.setStatus(`正在用 ${getLanguageLabel(language)} 检索 "${keyword}"，精确查询为 ${exactKeyword} ...`);
        this.resultsView.showPlaceholder("正在按需加载匹配索引分片和文本桶...");

        try {
            await this.ensureReady(language);
            throwIfAborted(run.signal);
            const search = await raceWithSignal(
                this.pagefind.search(exactKeyword, {}),
                run.signal
            );
            throwIfAborted(run.signal);

            if (
                !search
                || currentToken !== this.searchToken
                || !this.searchCoordinator.isCurrent(run)
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

            this.setStatus(`找到 ${this.numberFormatter.format(index.total)} 条`);

            if (index.total === 0) {
                this.searchCoordinator.setBusy(run, false);
                this.paginationView.hide();
                this.resultsView.showPlaceholder("没有找到匹配结果。可以尝试更短或更常见的关键词。");
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
            this.activeSearchSession = session;
            await this.renderSearchPage(session, 1);
        } catch (error) {
            if (
                isAbortError(error, run.signal)
                || currentToken !== this.searchToken
                || !this.searchCoordinator.isCurrent(run)
            ) {
                return;
            }

            console.error(error);
            this.searchCoordinator.setBusy(run, false);
            this.clearSearchSession();
            if (error instanceof ExactMatchPaginationError) {
                this.setStatus("当前 Pagefind 搜索结果不支持精确分页。");
                this.resultsView.showTextPlaceholder(error.message);
            } else {
                this.setStatus("搜索失败。请通过 HTTP server 打开本页面，不要直接双击 HTML 文件。");
                this.resultsView.showPlaceholder(
                    "初始化或搜索失败。请在 DevTools 中检查 <code>pagefind</code> 或 <code>text-data</code> 请求是否缺失。"
                );
            }
        }
    }

    async changeLanguage(language) {
        this.searchCoordinator.cancel();
        const currentToken = ++this.searchToken;
        this.clearSearchSession();
        this.setStatus(`正在切换到 ${getLanguageLabel(language)} 索引...`);
        this.resultsView.showPlaceholder("运行搜索后，结果会显示在这里。");

        try {
            await this.ensureReady(language);
            if (currentToken !== this.searchToken) {
                return;
            }
        } catch (error) {
            console.error(error);
            this.setStatus(`切换到 ${getLanguageLabel(language)} 索引失败。`);
        }
    }

    async navigateToPage(page) {
        const session = this.activeSearchSession;
        if (!session || session.loading) {
            return;
        }

        const pageState = getPageSlices(session.index, page, PAGE_SIZE);
        if (pageState.page === session.currentPage) {
            this.resultsView.setBusy(false);
            this.paginationView.render(pageState, false);
            return;
        }

        await this.renderSearchPage(session, pageState.page);
    }
}
