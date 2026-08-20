import { execFileSync } from "node:child_process";

const RELEASE_VERSION_RE = /^CNRELWin\d+(?:\.\d+){2,}_R\d+_S\d+_D\d+$/;

export function isReleaseVersion(value) {
    return RELEASE_VERSION_RE.test(String(value ?? "").trim());
}

export function deriveDatasetVersion({ currentSubject, currentCommitDate, historySubjects }) {
    const subject = String(currentSubject ?? "").trim();

    if (isReleaseVersion(subject)) {
        return {
            datasetVersion: subject,
            releaseBaseVersion: subject,
            exactRelease: true
        };
    }

    const releaseBaseVersion = historySubjects
        .map((value) => String(value ?? "").trim())
        .find(isReleaseVersion);

    if (!releaseBaseVersion) {
        throw new Error("AnimeGameData2 history does not contain a supported release version commit.");
    }

    const dateSuffix = String(currentCommitDate ?? "").replaceAll("-", "");
    if (!/^\d{8}$/.test(dateSuffix)) {
        throw new Error(`Invalid AnimeGameData2 commit date: ${currentCommitDate}`);
    }

    return {
        datasetVersion: `${releaseBaseVersion}_${dateSuffix}`,
        releaseBaseVersion,
        exactRelease: false
    };
}

function runGit(dataPath, args) {
    try {
        return execFileSync("git", ["-C", dataPath, ...args], {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"]
        }).trim();
    } catch (error) {
        const detail = String(error?.stderr ?? error?.message ?? error).trim();
        throw new Error(`Unable to inspect AnimeGameData2 Git repository at ${dataPath}: ${detail}`);
    }
}

export function resolveDatasetVersion(dataPath) {
    const isWorkTree = runGit(dataPath, ["rev-parse", "--is-inside-work-tree"]);
    if (isWorkTree !== "true") {
        throw new Error(`AnimeGameData2 path is not a Git work tree: ${dataPath}`);
    }

    const dirtyStatus = runGit(dataPath, ["status", "--porcelain", "--untracked-files=normal"]);
    if (dirtyStatus) {
        throw new Error("AnimeGameData2 contains uncommitted changes; commit or discard them before building a release.");
    }

    const commit = runGit(dataPath, ["log", "-1", "--format=%H"]);
    const commitDate = runGit(dataPath, ["log", "-1", "--format=%cs"]);
    const currentSubject = runGit(dataPath, ["log", "-1", "--format=%s"]);
    const historySubjects = runGit(dataPath, ["log", "--format=%s"]).split(/\r?\n/);
    const derived = deriveDatasetVersion({ currentSubject, currentCommitDate: commitDate, historySubjects });

    return {
        ...derived,
        commit,
        commitDate,
        currentSubject
    };
}

