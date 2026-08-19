import fs from "fs";
import path from "path";

import {
    getNormalizedRelativePath,
    listFilesRecursive,
    normalizeSourceText,
    toPosixPath
} from "../filesystem.js";

const SUBTITLE_TIME_RE = /^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[,.]\d{3})$/;

export function parseSrtTimeToMs(value) {
    const normalized = String(value || "").trim().replace(",", ".");
    const match = normalized.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
    if (!match) {
        return 0;
    }

    const [, hh, mm, ss, ms] = match;
    return Number(hh) * 3600000 + Number(mm) * 60000 + Number(ss) * 1000 + Number(ms);
}

export function makeSubtitleTimeKey(startMs, index) {
    return `${String(startMs).padStart(9, "0")}-${String(index + 1).padStart(4, "0")}`;
}

export function parseSubtitleSegments(content) {
    const normalized = normalizeSourceText(content);
    if (!normalized) {
        return [];
    }

    return normalized
        .split(/\n\s*\n/g)
        .map((block) => block.split("\n").map((line) => line.trim()).filter(Boolean))
        .map((lines) => {
            const timeLineIndex = lines.findIndex((line) => SUBTITLE_TIME_RE.test(line));
            if (timeLineIndex === -1) {
                return null;
            }

            const text = lines.slice(timeLineIndex + 1).join("\n").trim();
            if (!text) {
                return null;
            }

            const timeRange = lines[timeLineIndex];
            const timeMatch = SUBTITLE_TIME_RE.exec(timeRange);
            if (!timeMatch) {
                return null;
            }

            const startMs = parseSrtTimeToMs(timeMatch[1]);
            return {
                sequence: lines[0] ?? "",
                timeRange,
                startMs,
                text
            };
        })
        .filter(Boolean);
}

/**
 * @param {import("../config.js").LanguageConfig} languageConfig
 * @returns {import("./index.js").IndexRecord[]}
 */
export function loadSubtitleRecords(languageConfig) {
    return listFilesRecursive(
        languageConfig.subtitleSourceDir,
        (filePath) => path.extname(filePath).toLowerCase() === ".srt"
    ).flatMap((filePath) => {
        const relativePath = toPosixPath(path.relative(languageConfig.subtitleSourceDir, filePath));
        const normalizedPath = getNormalizedRelativePath(relativePath, languageConfig.id);
        const segments = parseSubtitleSegments(fs.readFileSync(filePath, "utf-8"));

        return segments.map((segment, index) => {
            const timeKey = makeSubtitleTimeKey(segment.startMs, index);
            const pagefindId = `subtitle:${normalizedPath}:${timeKey}`;

            return {
                sourceType: "subtitle",
                pagefindId,
                textDataKey: pagefindId,
                bucketKey: `subtitle:${normalizedPath}`,
                titleText: "subtitle",
                searchText: segment.text,
                text: segment.text
            };
        });
    }).filter((record) => record.text.trim());
}
