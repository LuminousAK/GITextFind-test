import { getDisplayLanguages, getLanguageLabel, getSourceTypeLabel } from "../core/displayConfig.js";
import { stylizeText } from "./richTextRenderer.js";

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

export function createResultsView({ container }) {
    const renderedItems = new Map();
    let contextRequestHandler = null;

    container.addEventListener("click", (event) => {
        const button = event.target.closest(".origin-action[data-result-id]");
        if (!button || button.disabled) {
            return;
        }

        const item = renderedItems.get(button.dataset.resultId);
        if (item && contextRequestHandler) {
            contextRequestHandler(item);
        }
    });

    function showPlaceholder(message) {
        renderedItems.clear();
        container.innerHTML = `<div class="placeholder">${message}</div>`;
    }

    function showTextPlaceholder(message) {
        renderedItems.clear();
        const placeholder = document.createElement("div");
        placeholder.className = "placeholder";
        placeholder.textContent = message;
        container.replaceChildren(placeholder);
    }

    function render(items, language, keyword) {
        const languageLabel = getLanguageLabel(language);
        renderedItems.clear();
        const resultFragment = document.createDocumentFragment();

        items.forEach((item, index) => {
            const resultId = `${item.contextKey || item.hash || "result"}-${index}`;
            renderedItems.set(resultId, item);

            const displayLanguages = item.displayLanguages?.length
                ? item.displayLanguages
                : getDisplayLanguages(language);
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

        container.replaceChildren(resultFragment);
    }

    return {
        render,
        setBusy(isBusy) {
            container.setAttribute("aria-busy", isBusy ? "true" : "false");
        },
        setContextRequestHandler(handler) {
            contextRequestHandler = handler;
        },
        showPlaceholder,
        showTextPlaceholder
    };
}
