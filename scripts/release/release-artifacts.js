import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const NO_STORE_CACHE_CONTROL = "no-store";

export function toPosixPath(value) {
    return value.split(path.sep).join("/");
}

export function listFilesRecursive(rootDir) {
    if (!fs.existsSync(rootDir)) {
        return [];
    }

    const files = [];
    const visit = (currentDir) => {
        for (const dirent of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const fullPath = path.join(currentDir, dirent.name);
            if (dirent.isDirectory()) {
                visit(fullPath);
            } else if (dirent.isFile()) {
                files.push(fullPath);
            }
        }
    };
    visit(rootDir);
    return files.sort((left, right) => left.localeCompare(right));
}

export function getContentType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    const contentTypes = {
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".txt": "text/plain; charset=utf-8",
        ".wasm": "application/wasm",
        ".pagefind": "application/octet-stream",
        ".pf_filter": "application/octet-stream",
        ".pf_fragment": "application/octet-stream",
        ".pf_index": "application/octet-stream",
        ".pf_meta": "application/octet-stream"
    };

    return contentTypes[extension] ?? "application/octet-stream";
}

export function getObjectCacheControl(objectKey) {
    return objectKey.includes("/releases/")
        ? IMMUTABLE_CACHE_CONTROL
        : NO_STORE_CACHE_CONTROL;
}

export function getUploadOrder(objectKey) {
    if (objectKey.includes("/releases/")) {
        return 10;
    }
    if (objectKey === "shared/manifest.json") {
        return 90;
    }
    if (/^languages\/[^/]+\/manifest\.json$/.test(objectKey)) {
        return 100;
    }
    return 50;
}

export function createR2UploadEntries(r2Root, projectRoot = process.cwd(), includeObject = () => true) {
    return listFilesRecursive(r2Root)
        .map((filePath) => {
            const objectKey = toPosixPath(path.relative(r2Root, filePath));
            if (!includeObject(objectKey)) {
                return null;
            }
            const content = fs.readFileSync(filePath);
            return {
                operation: "PUT",
                order: getUploadOrder(objectKey),
                objectKey,
                localPath: toPosixPath(path.relative(projectRoot, filePath)),
                size: content.byteLength,
                sha256: crypto.createHash("sha256").update(content).digest("hex"),
                contentType: getContentType(filePath),
                cacheControl: getObjectCacheControl(objectKey)
            };
        })
        .filter(Boolean)
        .sort((left, right) => left.order - right.order || left.objectKey.localeCompare(right.objectKey));
}

export function summarizeDirectory(rootDir) {
    const files = listFilesRecursive(rootDir);
    const sizes = files.map((filePath) => fs.statSync(filePath).size);
    return {
        files: files.length,
        bytes: sizes.reduce((sum, size) => sum + size, 0),
        largestFileBytes: Math.max(0, ...sizes)
    };
}
