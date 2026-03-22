import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 4173);

const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".pf_filter": "application/octet-stream",
    ".pf_fragment": "application/octet-stream",
    ".pf_index": "application/octet-stream",
    ".pf_meta": "application/octet-stream",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
    ".pagefind": "application/octet-stream"
};

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
    res.writeHead(status, { "Content-Type": contentType });
    res.end(body);
}

function resolvePath(urlPath) {
    const pathname = decodeURIComponent(urlPath.split("?")[0]);
    const cleanPath = pathname === "/" ? "/index.html" : pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const absolutePath = path.normalize(path.join(publicDir, cleanPath));

    if (!absolutePath.startsWith(publicDir)) {
        return null;
    }

    return absolutePath;
}

const server = http.createServer((req, res) => {
    const filePath = resolvePath(req.url || "/");

    if (!filePath) {
        send(res, 403, "Forbidden");
        return;
    }

    fs.stat(filePath, (statError, stats) => {
        if (statError || !stats.isFile()) {
            send(res, 404, "Not Found");
            return;
        }

        const extension = path.extname(filePath);
        const contentType = mimeTypes[extension] || "application/octet-stream";

        res.writeHead(200, { "Content-Type": contentType });
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(port, () => {
    console.log(`Demo server running at http://localhost:${port}`);
    console.log("Press Ctrl+C to stop.");
});
