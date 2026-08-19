import { getLanguageLabel } from "../core/displayConfig.js";
import { stylizeText } from "./richTextRenderer.js";

function createEmptyMessage(message) {
    const element = document.createElement("div");
    element.className = "context-empty";
    element.textContent = message;
    return element;
}

export function createContextDrawer({
    backdrop,
    drawer,
    closeButton,
    titleElement,
    subtitleElement,
    contentElement,
    documentRoot = document
}) {
    function render(state) {
        titleElement.textContent = state.title || "详细上下文";
        subtitleElement.textContent = state.subtitle || "";

        if (state.status === "loading") {
            contentElement.replaceChildren(createEmptyMessage("正在加载上下文..."));
            return;
        }

        if (!state.rows || state.rows.length === 0) {
            contentElement.replaceChildren(createEmptyMessage(state.message || "无上下文数据。"));
            return;
        }

        const displayLanguages = state.rows[0]?.cells ? Object.keys(state.rows[0].cells) : [];
        if (!displayLanguages.length) {
            contentElement.replaceChildren(createEmptyMessage(state.message || "无上下文数据。"));
            return;
        }

        const keyword = state.keyword || "";
        const table = document.createElement("div");
        table.className = "context-table";
        table.style.setProperty("--context-lang-count", String(displayLanguages.length));

        const headerRow = document.createElement("div");
        headerRow.className = "context-row is-header";
        const speakerHeader = document.createElement("div");
        speakerHeader.className = "context-cell context-cell-speaker";
        speakerHeader.textContent = "角色";
        headerRow.appendChild(speakerHeader);
        for (const language of displayLanguages) {
            const languageHeader = document.createElement("div");
            languageHeader.className = "context-cell";
            languageHeader.textContent = getLanguageLabel(language);
            headerRow.appendChild(languageHeader);
        }
        table.appendChild(headerRow);

        let hitRowAssigned = false;
        for (const row of state.rows) {
            const rowElement = document.createElement("div");
            rowElement.className = `context-row${row.isHit ? " context-hit" : ""}`;

            if (row.isHit && !hitRowAssigned) {
                rowElement.id = "context-hit-row";
                hitRowAssigned = true;
            }

            const speakerCell = document.createElement("div");
            speakerCell.className = "context-cell context-cell-speaker";
            speakerCell.textContent = row.speaker || "";
            rowElement.appendChild(speakerCell);

            for (const language of displayLanguages) {
                const cell = document.createElement("div");
                cell.className = "context-cell";
                cell.appendChild(stylizeText(row.cells[language] || "", keyword));
                rowElement.appendChild(cell);
            }

            table.appendChild(rowElement);
        }

        contentElement.replaceChildren(table);

        const hitRow = contentElement.querySelector("#context-hit-row");
        if (hitRow) {
            requestAnimationFrame(() => {
                hitRow.scrollIntoView({ behavior: "smooth", block: "center" });
            });
        }
    }

    function open(item) {
        backdrop.hidden = false;
        requestAnimationFrame(() => {
            backdrop.classList.add("is-open");
        });
        render({
            status: "loading",
            title: item.origin || "详细上下文",
            subtitle: `id: ${item.hash || "-"}`
        });
    }

    function close() {
        backdrop.classList.remove("is-open");
        window.setTimeout(() => {
            if (!backdrop.classList.contains("is-open")) {
                backdrop.hidden = true;
            }
        }, 240);
    }

    closeButton.addEventListener("click", close);
    backdrop.addEventListener("click", (event) => {
        if (!drawer.contains(event.target)) {
            close();
        }
    });
    documentRoot.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !backdrop.hidden) {
            close();
        }
    });

    return {
        close,
        focusCloseButton() {
            closeButton.focus();
        },
        open,
        render,
        renderError(item) {
            render({
                status: "empty",
                title: item.origin || "详细上下文",
                subtitle: `id: ${item.hash || "-"}`,
                message: "上下文加载失败，请在控制台查看详细错误。"
            });
        }
    };
}
