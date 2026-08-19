import fs from "fs";
import path from "path";

export function toPosixPath(value) {
    return value.split(path.sep).join("/");
}

export function getNormalizedRelativePath(relativePath, languageId) {
    const suffixRegex = new RegExp(`_${languageId}(?=\\.[^.]+$)`, "i");
    return relativePath.replace(suffixRegex, "");
}

export function listFilesRecursive(rootDir, predicate = () => true) {
    if (!fs.existsSync(rootDir)) {
        return [];
    }

    const files = [];

    function visit(currentDir) {
        for (const dirent of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const fullPath = path.join(currentDir, dirent.name);

            if (dirent.isDirectory()) {
                visit(fullPath);
            } else if (dirent.isFile() && predicate(fullPath)) {
                files.push(fullPath);
            }
        }
    }

    visit(rootDir);
    return files.sort((left, right) => left.localeCompare(right));
}

export function normalizeSourceText(value) {
    return String(value ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/\\n/g, "\n")
        .trim();
}
