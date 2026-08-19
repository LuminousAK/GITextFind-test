export class ExactMatchPaginationError extends Error {
    constructor(message) {
        super(message);
        this.name = "ExactMatchPaginationError";
    }
}

export function buildExactMatchIndex(results) {
    if (!Array.isArray(results)) {
        throw new ExactMatchPaginationError("Pagefind 搜索结果不是数组。");
    }

    const groups = [];
    let total = 0;

    results.forEach((result, resultIndex) => {
        const count = result?.exactMatchCount;
        if (!Number.isSafeInteger(count) || count < 0) {
            throw new ExactMatchPaginationError(
                `Pagefind 结果 ${resultIndex} 缺少有效的 exactMatchCount。请使用自定义 Pagefind 重新构建索引。`
            );
        }

        if (count === 0) {
            return;
        }

        const start = total;
        total += count;
        groups.push({
            resultIndex,
            start,
            end: total,
            count
        });
    });

    return { groups, total };
}

export function normalizePageNumber(value, totalPages) {
    if (!Number.isSafeInteger(totalPages) || totalPages <= 0) {
        return 0;
    }

    const numericValue = Number(value);
    const integerValue = Number.isFinite(numericValue)
        ? Math.trunc(numericValue)
        : 1;

    return Math.min(totalPages, Math.max(1, integerValue));
}

export function getPageSlices(index, page, pageSize) {
    if (!index || !Array.isArray(index.groups) || !Number.isSafeInteger(index.total) || index.total < 0) {
        throw new TypeError("Invalid exact-match pagination index.");
    }
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
        throw new RangeError("Page size must be a positive safe integer.");
    }

    const totalPages = Math.ceil(index.total / pageSize);
    const normalizedPage = normalizePageNumber(page, totalPages);
    if (normalizedPage === 0) {
        return {
            page: 0,
            totalPages: 0,
            start: 0,
            end: 0,
            slices: []
        };
    }

    const start = (normalizedPage - 1) * pageSize;
    const end = Math.min(start + pageSize, index.total);
    const groups = index.groups;

    let lower = 0;
    let upper = groups.length;
    while (lower < upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        if (groups[middle].end <= start) {
            lower = middle + 1;
        } else {
            upper = middle;
        }
    }

    const slices = [];
    for (let groupIndex = lower; groupIndex < groups.length; groupIndex += 1) {
        const group = groups[groupIndex];
        if (group.start >= end) {
            break;
        }

        slices.push({
            resultIndex: group.resultIndex,
            from: Math.max(start, group.start) - group.start,
            to: Math.min(end, group.end) - group.start
        });
    }

    return {
        page: normalizedPage,
        totalPages,
        start,
        end,
        slices
    };
}
