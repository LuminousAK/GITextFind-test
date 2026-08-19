import { getDisplayLanguages, getSourceTypeLabel } from "../core/displayConfig.js";
import {
    getBucketId,
    getTextBucketIdFromRecordId,
    getTextDataKeyFromRecordId,
    parseRecordId
} from "../core/recordId.js";

export function buildQuestTitle(questHashes, questsMap) {
    if (!questHashes) {
        return "对话文本";
    }

    const questTitle = questsMap[questHashes.questTitleHash] || null;
    if (!questTitle) {
        return "对话文本";
    }

    const chapterTitle = questHashes.chapterTitleHash ? questsMap[questHashes.chapterTitleHash] : null;
    const chapterNum = questHashes.chapterNumHash ? questsMap[questHashes.chapterNumHash] : null;

    if (!chapterTitle) {
        return questTitle;
    }
    if (chapterNum) {
        return `${chapterNum} · ${chapterTitle} · ${questTitle}`;
    }

    return `${chapterTitle} · ${questTitle}`;
}

export function resolveSpeakerName(nameHash, namesMap, getCustomName = () => null) {
    if (nameHash === "PLAYER") {
        return getCustomName("player") || "主角";
    }
    if (nameHash === "MATE_AVATAR") {
        return getCustomName("mate") || "反主";
    }
    if (nameHash === null || nameHash === undefined) {
        return "";
    }

    const name = namesMap[nameHash];
    if (!name) {
        return "";
    }

    if (name.includes("#{REALNAME[ID(1)")) {
        return getCustomName("wanderer") || "流浪者";
    }

    return name;
}

export function parseSubtitleStartMs(timeKey) {
    const startPart = String(timeKey || "").split("-")[0];
    return Number(startPart) || 0;
}

export function createContextService({ repository, getCustomName = () => null }) {
    async function loadTalkContext(recordId, displayLanguages, keyword) {
        const [, talkId, hitHash] = String(recordId).split(":");
        const talkBucketId = getBucketId(talkId);
        const [talkDetailsBucket, primaryNames, primaryQuests, textBucketsByLanguage] = await Promise.all([
            repository.loadMetaBucket("talk-details", talkBucketId),
            repository.loadNames(displayLanguages[0]),
            repository.loadQuests(displayLanguages[0]),
            repository.loadTextBucketsForLanguages(displayLanguages, talkBucketId)
        ]);

        const talkData = talkDetailsBucket[talkId];
        if (!talkData) {
            return {
                status: "empty",
                title: "对话文本",
                subtitle: "",
                message: "未找到对话数据。",
                rows: []
            };
        }

        const title = buildQuestTitle(talkData.questHashes, primaryQuests);
        const rows = talkData.dialogues.map((dialogue) => ({
            hash: dialogue.hash,
            isHit: dialogue.hash === hitHash,
            speaker: resolveSpeakerName(dialogue.nameHash, primaryNames, getCustomName),
            cells: Object.fromEntries(displayLanguages.map((language) => [
                language,
                textBucketsByLanguage[language]?.[dialogue.hash] || ""
            ]))
        }));

        return {
            status: "ok",
            title,
            subtitle: `talkId: ${talkId}`,
            rows,
            hitHash,
            keyword
        };
    }

    async function loadSubtitleContext(recordId, displayLanguages, keyword) {
        const parsed = parseRecordId(recordId);
        const filePath = parsed.sourceId;
        const hitSegment = parsed.segment;
        const hitStartMs = parseSubtitleStartMs(hitSegment);
        const bucketId = getBucketId(parsed.bucketKey);
        const textBucketsByLanguage = await repository.loadTextBucketsForLanguages(displayLanguages, bucketId);
        const prefix = `subtitle:${filePath}:`;
        const segments = [];

        for (const language of displayLanguages) {
            const bucket = textBucketsByLanguage[language] || {};
            for (const [key, text] of Object.entries(bucket)) {
                if (!key.startsWith(prefix)) {
                    continue;
                }

                const timeKey = key.slice(prefix.length);
                segments.push({
                    lang: language,
                    key,
                    text,
                    timeKey,
                    startMs: parseSubtitleStartMs(timeKey)
                });
            }
        }

        const thresholdMs = 500;
        segments.sort((left, right) => left.startMs - right.startMs || left.lang.localeCompare(right.lang));

        const rows = [];
        for (const segment of segments) {
            const lastRow = rows[rows.length - 1];
            const canMerge = (
                lastRow
                && Math.abs(lastRow.startMs - segment.startMs) < thresholdMs
                && !lastRow.cells[segment.lang]
            );

            if (canMerge) {
                lastRow.cells[segment.lang] = segment.text;
                lastRow.keys[segment.lang] = segment.key;
                lastRow.isHit ||= Math.abs(segment.startMs - hitStartMs) < thresholdMs;
                continue;
            }

            rows.push({
                hash: segment.key,
                keys: { [segment.lang]: segment.key },
                startMs: segment.startMs,
                isHit: Math.abs(segment.startMs - hitStartMs) < thresholdMs,
                speaker: "",
                cells: { [segment.lang]: segment.text }
            });
        }

        return {
            status: "ok",
            title: `字幕: ${filePath}`,
            subtitle: "",
            rows,
            hitHash: `${prefix}${hitSegment}`,
            keyword
        };
    }

    async function loadSingleHashContext(recordId, displayLanguages, keyword) {
        const parsed = parseRecordId(recordId);
        const bucketId = getTextBucketIdFromRecordId(recordId);
        const lookupKey = getTextDataKeyFromRecordId(recordId);
        const textBucketsByLanguage = await repository.loadTextBucketsForLanguages(displayLanguages, bucketId);
        const row = {
            hash: parsed.textDataKey,
            isHit: true,
            speaker: "",
            cells: {}
        };

        for (const language of displayLanguages) {
            row.cells[language] = textBucketsByLanguage[language]?.[lookupKey] || "";
        }

        return {
            status: "ok",
            title: getSourceTypeLabel(parsed.sourceType),
            subtitle: parsed.originDetail,
            rows: [row],
            hitHash: parsed.textDataKey,
            keyword
        };
    }

    async function loadFetterContext(recordId, displayLanguages, keyword) {
        const parsed = parseRecordId(recordId);
        const textHash = parsed.textDataKey;
        const primaryLanguage = displayLanguages[0];
        const [metaBucket, names, sourceTitles, single] = await Promise.all([
            repository.loadMetaBucket("hash-to-fetter", getBucketId(textHash)),
            repository.loadNames(primaryLanguage),
            repository.loadSourceTitles(primaryLanguage),
            loadSingleHashContext(recordId, displayLanguages, keyword)
        ]);
        const fetter = metaBucket[textHash] || {};
        const avatarName = fetter.avatarNameHash ? names[fetter.avatarNameHash] : "";
        const voiceTitle = fetter.voiceTitleHash ? sourceTitles[fetter.voiceTitleHash] : "";

        return {
            ...single,
            title: [avatarName, voiceTitle].filter(Boolean).join(" · ") || "角色语音",
            subtitle: `textHash: ${textHash}`
        };
    }

    async function loadContext(item, fallbackLanguage) {
        const recordId = item.contextParams?.recordId || item.hash;
        const parsed = parseRecordId(recordId);
        const searchLanguage = item.contextParams?.searchLanguage || fallbackLanguage;
        const keyword = item.contextParams?.keyword || "";
        const displayLanguages = getDisplayLanguages(searchLanguage);

        if (parsed.sourceType === "talk") {
            return loadTalkContext(recordId, displayLanguages, keyword);
        }
        if (parsed.sourceType === "subtitle") {
            return loadSubtitleContext(recordId, displayLanguages, keyword);
        }
        if (parsed.sourceType === "readable") {
            return loadSingleHashContext(recordId, displayLanguages, keyword);
        }
        if (parsed.sourceType === "fetter") {
            return loadFetterContext(recordId, displayLanguages, keyword);
        }

        return loadSingleHashContext(recordId, displayLanguages, keyword);
    }

    return { loadContext };
}
