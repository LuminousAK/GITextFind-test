export function createPaginationView({ controls, numberFormatter }) {
    let navigateHandler = null;
    let currentState = null;

    for (const control of controls) {
        control.element.addEventListener("click", (event) => {
            const button = event.target.closest("button[data-page-action]");
            if (!button || !currentState || currentState.isLoading) {
                return;
            }

            const targetPages = {
                first: 1,
                previous: currentState.pageState.page - 1,
                next: currentState.pageState.page + 1,
                last: currentState.pageState.totalPages
            };
            navigateHandler?.(targetPages[button.dataset.pageAction]);
        });

        control.form.addEventListener("submit", (event) => {
            event.preventDefault();
            if (!currentState || currentState.isLoading) {
                return;
            }
            navigateHandler?.(control.input.value);
        });
    }

    function hide() {
        currentState = null;
        for (const control of controls) {
            control.element.hidden = true;
        }
    }

    function render(pageState, isLoading) {
        currentState = { pageState, isLoading };
        const hasMultiplePages = pageState.totalPages > 1;

        for (const control of controls) {
            control.element.hidden = !hasMultiplePages;

            if (pageState.totalPages === 0) {
                continue;
            }

            control.input.value = String(pageState.page);
            control.input.max = String(pageState.totalPages);
            control.total.textContent = `/ ${numberFormatter.format(pageState.totalPages)}`;

            control.first.disabled = isLoading || pageState.page <= 1;
            control.previous.disabled = isLoading || pageState.page <= 1;
            control.next.disabled = isLoading || pageState.page >= pageState.totalPages;
            control.last.disabled = isLoading || pageState.page >= pageState.totalPages;
            control.input.disabled = isLoading;
            control.go.disabled = isLoading;
        }
    }

    return {
        hide,
        render,
        setNavigateHandler(handler) {
            navigateHandler = handler;
        }
    };
}
