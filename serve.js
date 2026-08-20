import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pagesDir = path.join(__dirname, "dist", "pages");
const r2Dir = path.join(__dirname, "dist", "r2");
const pagesPort = Number(process.env.PORT || 4173);
const r2Port = Number(process.env.R2_PORT || 4174);

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

function send(res, status, body, contentType = "text/plain; charset=utf-8", headers = {}) {
    res.writeHead(status, { "Content-Type": contentType, ...headers });
    res.end(body);
}

function resolvePath(rootDir, urlPath) {
    const pathname = decodeURIComponent(urlPath.split("?")[0]);
    const cleanPath = pathname === "/" ? "/index.html" : pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const absolutePath = path.normalize(path.join(rootDir, cleanPath));

    if (absolutePath !== rootDir && !absolutePath.startsWith(`${rootDir}${path.sep}`)) {
        return null;
    }

    return absolutePath;
}

function createStaticServer({ rootDir, cors = false }) {
    return http.createServer((req, res) => {
        const filePath = resolvePath(rootDir, req.url || "/");
        const commonHeaders = cors
            ? {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Expose-Headers": "ETag, Content-Length, Content-Range, Accept-Ranges"
            }
            : {};

        if (!filePath) {
            send(res, 403, "Forbidden", undefined, commonHeaders);
            return;
        }

        fs.stat(filePath, (statError, stats) => {
            if (statError || !stats.isFile()) {
                send(res, 404, "Not Found", undefined, commonHeaders);
                return;
            }

            const extension = path.extname(filePath);
            const contentType = mimeTypes[extension] || "application/octet-stream";
            const urlPath = (req.url || "").split("?")[0];
            const cacheControl = urlPath.includes("/releases/")
                ? "public, max-age=31536000, immutable"
                : "no-store";

            res.writeHead(200, {
                "Content-Type": contentType,
                "Cache-Control": cacheControl,
                ...commonHeaders
            });
            fs.createReadStream(filePath).pipe(res);
        });
    });
}

const pagesServer = createStaticServer({ rootDir: pagesDir });
const r2Server = createStaticServer({ rootDir: r2Dir, cors: true });

pagesServer.listen(pagesPort, () => {
    console.log(`Pages preview running at http://localhost:${pagesPort}`);
});
r2Server.listen(r2Port, () => {
    console.log(`R2 preview running at http://localhost:${r2Port}`);
    console.log("Press Ctrl+C to stop both servers.");
});
