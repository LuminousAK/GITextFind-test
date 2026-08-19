function getAbortReason(signal) {
    if (signal?.reason !== undefined) {
        return signal.reason;
    }

    return new DOMException("The operation was aborted.", "AbortError");
}

export function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw getAbortReason(signal);
    }
}

export function isAbortError(error, signal) {
    return Boolean(signal?.aborted || error?.name === "AbortError");
}

export function raceWithSignal(value, signal) {
    const promise = Promise.resolve(value);

    if (!signal) {
        return promise;
    }

    if (signal.aborted) {
        promise.catch(() => {});
        return Promise.reject(getAbortReason(signal));
    }

    return new Promise((resolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", handleAbort);
        const handleAbort = () => {
            cleanup();
            reject(getAbortReason(signal));
        };

        signal.addEventListener("abort", handleAbort, { once: true });
        promise.then(
            (result) => {
                cleanup();
                resolve(result);
            },
            (error) => {
                cleanup();
                reject(error);
            }
        );
    });
}

export class LatestSearchCoordinator {
    constructor() {
        this.activeRun = null;
    }

    start(key) {
        const normalizedKey = String(key);
        if (
            this.activeRun
            && this.activeRun.key === normalizedKey
            && this.activeRun.busy
            && !this.activeRun.signal.aborted
        ) {
            return { accepted: false, run: this.activeRun };
        }

        this.cancel();

        const controller = new AbortController();
        const run = {
            key: normalizedKey,
            controller,
            signal: controller.signal,
            busy: true
        };
        this.activeRun = run;

        return { accepted: true, run };
    }

    setBusy(run, busy) {
        if (!this.isCurrent(run)) {
            return false;
        }

        run.busy = Boolean(busy);
        return true;
    }

    isCurrent(run) {
        return Boolean(run && this.activeRun === run && !run.signal.aborted);
    }

    cancel(run = this.activeRun) {
        if (!run || this.activeRun !== run) {
            return false;
        }

        this.activeRun = null;
        run.controller.abort();
        return true;
    }
}

export async function loadCachedJson({
    key,
    url,
    resolvedCache,
    pendingRequests,
    signal,
    fetchImpl = fetch,
    errorMessage = `Failed to load JSON resource: ${url}`
}) {
    if (resolvedCache.has(key)) {
        return resolvedCache.get(key);
    }

    if (pendingRequests.has(key)) {
        return pendingRequests.get(key);
    }

    const request = (async () => {
        throwIfAborted(signal);
        const response = await fetchImpl(url, signal ? { signal } : undefined);
        if (!response.ok) {
            throw new Error(errorMessage);
        }

        const data = await response.json();
        throwIfAborted(signal);
        resolvedCache.set(key, data);
        return data;
    })();

    pendingRequests.set(key, request);

    try {
        return await request;
    } finally {
        if (pendingRequests.get(key) === request) {
            pendingRequests.delete(key);
        }
    }
}
