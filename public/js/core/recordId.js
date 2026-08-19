const BUCKET_COUNT = 512;

export function getBucketId(hash) {
    let mixedHash = 0x811c9dc5;
    const strHash = String(hash ?? "");

    for (let index = 0; index < strHash.length; index += 1) {
        mixedHash ^= strHash.charCodeAt(index);
        mixedHash = Math.imul(mixedHash, 0x01000193);
    }

    return String((mixedHash >>> 0) % BUCKET_COUNT).padStart(4, "0");
}

export function parseRecordId(recordId) {
    const id = String(recordId || "unknown");

    if (id.startsWith("talk:")) {
        const [, talkId, textHash] = id.split(":");
        return {
            sourceType: "talk",
            sourceId: talkId,
            textDataKey: textHash,
            bucketKey: talkId,
            originDetail: `talkId: ${talkId}`
        };
    }

    if (id.startsWith("fetter:")) {
        const textHash = id.slice("fetter:".length);
        return {
            sourceType: "fetter",
            sourceId: textHash,
            textDataKey: textHash,
            bucketKey: `fetter:${textHash}`,
            originDetail: textHash
        };
    }

    if (id.startsWith("textmap:")) {
        const textHash = id.slice("textmap:".length);
        return {
            sourceType: "textmap",
            sourceId: textHash,
            textDataKey: textHash,
            bucketKey: `textmap:${textHash}`,
            originDetail: textHash
        };
    }

    if (id.startsWith("readable:")) {
        const sourceId = id.slice("readable:".length);
        return {
            sourceType: "readable",
            sourceId,
            textDataKey: id,
            bucketKey: id,
            originDetail: sourceId
        };
    }

    if (id.startsWith("subtitle:")) {
        const value = id.slice("subtitle:".length);
        const separatorIndex = value.lastIndexOf(":");
        const sourceId = separatorIndex === -1 ? value : value.slice(0, separatorIndex);
        const segment = separatorIndex === -1 ? "" : value.slice(separatorIndex + 1);

        return {
            sourceType: "subtitle",
            sourceId,
            segment,
            textDataKey: id,
            bucketKey: `subtitle:${sourceId}`,
            originDetail: segment ? `${sourceId} #${segment}` : sourceId
        };
    }

    return {
        sourceType: "textmap",
        sourceId: id,
        textDataKey: id,
        bucketKey: `textmap:${id}`,
        originDetail: id
    };
}

export function getTextBucketIdFromRecordId(recordId) {
    return getBucketId(parseRecordId(recordId).bucketKey);
}

export function getTextDataKeyFromRecordId(recordId) {
    return parseRecordId(recordId).textDataKey;
}
