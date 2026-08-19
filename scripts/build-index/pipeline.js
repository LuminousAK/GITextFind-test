import { BUCKET_COUNT, getBucketId } from "../build_meta.js";

export function bucketEntries(entries, getBucketKey) {
    const buckets = Array.from({ length: BUCKET_COUNT }, () => []);

    for (const entry of entries) {
        const bucketId = getBucketId(String(getBucketKey(entry)));
        buckets[Number(bucketId)].push(entry);
    }

    return buckets
        .map((entriesForBucket, bucketIndex) => ({
            bucketId: String(bucketIndex).padStart(4, "0"),
            entries: entriesForBucket
        }))
        .filter((bucket) => bucket.entries.length > 0);
}

export function summarizeBucketStats(buckets, getText = (entry) => entry.searchText) {
    const entryCounts = buckets.map((bucket) => bucket.entries.length).sort((left, right) => left - right);
    const charCounts = buckets
        .map((bucket) => bucket.entries.reduce((sum, entry) => sum + String(getText(entry) ?? "").length, 0))
        .sort((left, right) => left - right);
    const percentile = (values, rate) => values[Math.floor((values.length - 1) * rate)] ?? 0;

    return {
        bucketCount: buckets.length,
        entriesPerBucket: {
            min: entryCounts[0] ?? 0,
            median: percentile(entryCounts, 0.5),
            p90: percentile(entryCounts, 0.9),
            max: entryCounts[entryCounts.length - 1] ?? 0
        },
        charsPerBucket: {
            min: charCounts[0] ?? 0,
            median: percentile(charCounts, 0.5),
            p90: percentile(charCounts, 0.9),
            max: charCounts[charCounts.length - 1] ?? 0
        }
    };
}

export async function mapWithConcurrency(items, concurrency, iteratee) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const currentIndex = nextIndex;
            nextIndex += 1;

            if (currentIndex >= items.length) {
                return;
            }

            results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
        }
    }

    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
}
