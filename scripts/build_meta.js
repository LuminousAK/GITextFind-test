import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getMetaFieldConfig, inferGameVersion } from "./meta-fields.js";

export const DATA_PATH = process.env.GI_DATA_PATH || "E:\\animegamedata2";
export const OUTPUT_ROOT = path.resolve("./dist/meta-data-standalone");
export const BUCKET_COUNT = 512;

export function getBucketId(hash) {
    let mixedHash = 0x811c9dc5;
    const strHash = String(hash ?? "");

    for (let index = 0; index < strHash.length; index += 1) {
        mixedHash ^= strHash.charCodeAt(index);
        mixedHash = Math.imul(mixedHash, 0x01000193);
    }

    return String((mixedHash >>> 0) % BUCKET_COUNT).padStart(4, "0");
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function resolveKeys(obj, keysets) {
    for (const keyset of keysets) {
        if (keyset.detect in obj) {
            return keyset.mapping;
        }
    }

    return null;
}

export function buildMetaData(dataPath = DATA_PATH, { gameVersion = null, datasetVersion = null } = {}) {
    const resolvedGameVersion = gameVersion || datasetVersion || inferGameVersion(dataPath);
    const fieldConfig = getMetaFieldConfig(resolvedGameVersion);
    const { talkKeysets, questKeysets, excelFields } = fieldConfig;

    console.log(`Using meta field config for game version ${fieldConfig.gameVersion}.`);
    console.log("Loading Excel configs...");

    const avatarsFile = path.join(dataPath, "ExcelBinOutput", "AvatarExcelConfigData.json");
    const avatars = JSON.parse(fs.readFileSync(avatarsFile, "utf-8"));
    const avatarMap = new Map();
    for (const avatar of avatars) {
        avatarMap.set(avatar.id, avatar[excelFields.avatarNameHash]);
    }

    const npcsFile = path.join(dataPath, "ExcelBinOutput", "NpcExcelConfigData.json");
    const npcs = JSON.parse(fs.readFileSync(npcsFile, "utf-8"));
    const npcMap = new Map();
    for (const npc of npcs) {
        npcMap.set(String(npc.id), npc[excelFields.npcNameHash]);
    }

    const chaptersFile = path.join(dataPath, "ExcelBinOutput", "ChapterExcelConfigData.json");
    const chapters = JSON.parse(fs.readFileSync(chaptersFile, "utf-8"));
    const chapterMap = new Map();
    for (const chapter of chapters) {
        chapterMap.set(chapter.id, {
            titleHash: chapter[excelFields.chapterTitleHash],
            numHash: chapter[excelFields.chapterNumHash]
        });
    }

    console.log("Loading Quests...");
    const questRoot = path.join(dataPath, "BinOutput", "Quest");
    const questFiles = fs.readdirSync(questRoot);
    const questMap = new Map();
    const questTalkMap = new Map();

    for (const file of questFiles) {
        const filePath = path.join(questRoot, file);
        const obj = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        const keys = resolveKeys(obj, questKeysets);

        if (!keys) {
            continue;
        }

        const questId = obj[keys.quest_id];
        const titleHash = obj[keys.title_hash];
        const chapterId = obj[keys.chapter_id];
        questMap.set(questId, { titleHash, chapterId });

        if (obj[keys.talks]) {
            for (const talk of obj[keys.talks]) {
                questTalkMap.set(talk[keys.talk_id], questId);
            }
        }
    }

    console.log("Loading Fetters...");
    const fettersFile = path.join(dataPath, "ExcelBinOutput", "FettersExcelConfigData.json");
    const fetters = JSON.parse(fs.readFileSync(fettersFile, "utf-8"));
    const fetterMap = new Map();
    for (const fetter of fetters) {
        fetterMap.set(String(fetter[excelFields.fetterVoiceFileHash]), {
            avatarId: fetter[excelFields.fetterAvatarId],
            voiceTitleHash: fetter[excelFields.fetterVoiceTitleHash]
        });
    }

    console.log("Loading Talks...");
    const talkRoot = path.join(dataPath, "BinOutput", "Talk");
    const talkFolders = fs.readdirSync(talkRoot);
    const hashToAllTalks = new Map();
    const talkDetails = new Map();

    for (const folder of talkFolders) {
        const folderPath = path.join(talkRoot, folder);
        if (!fs.statSync(folderPath).isDirectory()) {
            continue;
        }

        for (const file of fs.readdirSync(folderPath)) {
            const filePath = path.join(folderPath, file);
            const obj = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            const keys = resolveKeys(obj, talkKeysets);

            if (!keys || !obj[keys.dialogue_list] || obj[keys.dialogue_list].length === 0) {
                continue;
            }

            let coopQuestId = null;
            if (folder === "Coop") {
                const match = file.match(/^([0-9]+)_[0-9]+\.json$/);
                if (match) {
                    coopQuestId = Number.parseInt(match[1], 10);
                }
            }

            const talkId = obj[keys.talk_id];
            const dialogues = [];

            for (const dialogue of obj[keys.dialogue_list]) {
                if (!dialogue[keys.text_hash]) {
                    continue;
                }

                const textHash = String(dialogue[keys.text_hash]);
                let roleId = -1;
                let roleType = null;

                if (
                    keys.role in dialogue
                    && keys.role_id in dialogue[keys.role]
                    && keys.role_type in dialogue[keys.role]
                ) {
                    const rawRoleId = dialogue[keys.role][keys.role_id];
                    roleId = typeof rawRoleId === "string" ? rawRoleId.trim() : rawRoleId;
                    roleType = dialogue[keys.role][keys.role_type];
                }

                dialogues.push({
                    dialogueId: dialogue[keys.dialogue_id],
                    textHash,
                    roleId,
                    roleType
                });

                if (!hashToAllTalks.has(textHash)) {
                    hashToAllTalks.set(textHash, new Set());
                }
                hashToAllTalks.get(textHash).add(talkId);
            }

            if (dialogues.length > 0) {
                talkDetails.set(talkId, {
                    questId: questTalkMap.get(talkId) || null,
                    coopQuestId,
                    dialogues: dialogues.sort((left, right) => left.dialogueId - right.dialogueId)
                });
            }
        }
    }

    const primaryTalkByHash = new Map();
    const talkHashSets = new Map();
    for (const [talkId, data] of talkDetails.entries()) {
        const uniqueHashes = [];
        const seenHashes = new Set();

        for (const dialogue of data.dialogues) {
            if (!primaryTalkByHash.has(dialogue.textHash)) {
                primaryTalkByHash.set(dialogue.textHash, talkId);
            }

            if (!seenHashes.has(dialogue.textHash)) {
                seenHashes.add(dialogue.textHash);
                uniqueHashes.push(dialogue.textHash);
            }
        }

        talkHashSets.set(talkId, uniqueHashes);
    }

    const nameHashes = new Set();
    for (const [, hash] of avatarMap) {
        nameHashes.add(hash);
    }
    for (const [, hash] of npcMap) {
        nameHashes.add(hash);
    }

    const questTitleHashes = new Set();
    for (const [, quest] of questMap) {
        if (quest.titleHash) {
            questTitleHashes.add(quest.titleHash);
        }
    }
    for (const [, chapter] of chapterMap) {
        if (chapter.titleHash) {
            questTitleHashes.add(chapter.titleHash);
        }
        if (chapter.numHash) {
            questTitleHashes.add(chapter.numHash);
        }
    }

    const sourceTitleHashes = new Set();
    for (const [, fetter] of fetterMap) {
        if (fetter.voiceTitleHash) {
            sourceTitleHashes.add(fetter.voiceTitleHash);
        }
    }

    return {
        gameVersion: fieldConfig.gameVersion,
        primaryTalkByHash,
        hashToAllTalks,
        talkHashSets,
        nameHashes,
        questTitleHashes,
        sourceTitleHashes,
        hashToTalk: hashToAllTalks,
        talkDetails,
        fetterMap,
        avatarMap,
        npcMap,
        questMap,
        chapterMap
    };
}

export function writeMetaBuckets(metaData, outputRoot = OUTPUT_ROOT) {
    console.log("Writing buckets...");
    ensureDir(outputRoot);

    const hashToTalkDir = path.join(outputRoot, "hash-to-talk");
    ensureDir(hashToTalkDir);
    const hashToTalkBuckets = Array.from({ length: BUCKET_COUNT }, () => ({}));

    for (const [hashStr, talkIdSet] of metaData.hashToTalk.entries()) {
        const bucketId = Number(getBucketId(hashStr));
        hashToTalkBuckets[bucketId][hashStr] = Array.from(talkIdSet);
    }

    for (let index = 0; index < BUCKET_COUNT; index += 1) {
        if (Object.keys(hashToTalkBuckets[index]).length > 0) {
            fs.writeFileSync(
                path.join(hashToTalkDir, `${String(index).padStart(4, "0")}.json`),
                JSON.stringify(hashToTalkBuckets[index]),
                "utf-8"
            );
        }
    }

    const talkDetailsDir = path.join(outputRoot, "talk-details");
    ensureDir(talkDetailsDir);
    const talkDetailBuckets = Array.from({ length: BUCKET_COUNT }, () => ({}));

    for (const [talkId, data] of metaData.talkDetails.entries()) {
        const bucketId = Number(getBucketId(talkId));
        let resolvedQuestHashes = null;
        const finalQuestId = data.coopQuestId !== null ? Math.floor(data.coopQuestId / 100) : data.questId;

        if (finalQuestId && metaData.questMap.has(finalQuestId)) {
            const questData = metaData.questMap.get(finalQuestId);
            const chapterData = (
                questData.chapterId && metaData.chapterMap.has(questData.chapterId)
            ) ? metaData.chapterMap.get(questData.chapterId) : null;

            resolvedQuestHashes = {
                questTitleHash: questData.titleHash || null,
                chapterTitleHash: chapterData ? chapterData.titleHash : null,
                chapterNumHash: chapterData ? chapterData.numHash : null
            };
        }

        const resolvedDialogues = data.dialogues.map((dialogue) => {
            let nameHash = null;

            if (dialogue.roleType === "TALK_ROLE_NPC") {
                nameHash = metaData.npcMap.get(dialogue.roleId) || null;
            } else if (dialogue.roleType === "TALK_ROLE_PLAYER") {
                nameHash = "PLAYER";
            } else if (dialogue.roleType === "TALK_ROLE_MATE_AVATAR") {
                nameHash = "MATE_AVATAR";
            }

            return {
                id: dialogue.dialogueId,
                hash: dialogue.textHash,
                nameHash
            };
        });

        talkDetailBuckets[bucketId][talkId] = {
            questHashes: resolvedQuestHashes,
            dialogues: resolvedDialogues
        };
    }

    for (let index = 0; index < BUCKET_COUNT; index += 1) {
        if (Object.keys(talkDetailBuckets[index]).length > 0) {
            fs.writeFileSync(
                path.join(talkDetailsDir, `${String(index).padStart(4, "0")}.json`),
                JSON.stringify(talkDetailBuckets[index]),
                "utf-8"
            );
        }
    }

    const hashToFetterDir = path.join(outputRoot, "hash-to-fetter");
    ensureDir(hashToFetterDir);
    const hashToFetterBuckets = Array.from({ length: BUCKET_COUNT }, () => ({}));

    for (const [hashStr, data] of metaData.fetterMap.entries()) {
        const bucketId = Number(getBucketId(hashStr));
        hashToFetterBuckets[bucketId][hashStr] = {
            avatarNameHash: metaData.avatarMap.get(data.avatarId) || null,
            voiceTitleHash: data.voiceTitleHash
        };
    }

    for (let index = 0; index < BUCKET_COUNT; index += 1) {
        if (Object.keys(hashToFetterBuckets[index]).length > 0) {
            fs.writeFileSync(
                path.join(hashToFetterDir, `${String(index).padStart(4, "0")}.json`),
                JSON.stringify(hashToFetterBuckets[index]),
                "utf-8"
            );
        }
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const metaData = buildMetaData(DATA_PATH);
    writeMetaBuckets(metaData, OUTPUT_ROOT);
    console.log("Done.");
}
