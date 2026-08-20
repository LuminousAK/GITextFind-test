import fs from "node:fs";
import path from "node:path";

function normalizeLanguageId(value) {
    return String(value ?? "").trim().toLowerCase();
}

function uniqueLanguageIds(values) {
    return Array.from(new Set(values.map(normalizeLanguageId).filter(Boolean)));
}

export function parseReleaseArgs(argv) {
    const result = { local: false, configPath: null };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--local") {
            result.local = true;
            continue;
        }
        if (arg === "--config") {
            result.configPath = argv[index + 1] ?? null;
            index += 1;
            continue;
        }
        if (arg.startsWith("--config=")) {
            result.configPath = arg.slice("--config=".length);
            continue;
        }
        throw new Error(`Unknown release argument: ${arg}`);
    }

    if (!result.local && !result.configPath) {
        throw new Error("Production release preparation requires --config=deploy/cloudflare.local.json.");
    }
    if (result.local && result.configPath) {
        throw new Error("Use either --local or --config, not both.");
    }

    return result;
}

export function validateProductionBaseUrl(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`Invalid R2 public base URL: ${value}`);
    }

    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:") {
        throw new Error("Production R2 public base URL must use HTTPS.");
    }
    if (url.pathname !== "/" || url.search || url.hash) {
        throw new Error("R2 public base URL must be an origin with no path, query, or fragment.");
    }
    const reservedExampleHost = ["example.com", "example.net", "example.org"]
        .some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    if (
        reservedExampleHost
        || hostname === "localhost"
        || hostname.endsWith(".localhost")
        || hostname.endsWith(".example")
        || hostname.endsWith(".invalid")
        || hostname.endsWith(".test")
        || hostname.includes("<")
        || hostname === "r2.dev"
        || hostname.endsWith(".r2.dev")
        || url.username
        || url.password
    ) {
        throw new Error("Production releases require a real R2 custom domain; example and r2.dev hosts are rejected.");
    }

    return url.href;
}

export function normalizeRuntimeConfig(rawConfig, { local = false, availableLanguageIds = [] } = {}) {
    const available = uniqueLanguageIds(availableLanguageIds);
    const languages = uniqueLanguageIds(rawConfig.languages ?? available);
    if (languages.length === 0) {
        throw new Error("Runtime configuration must enable at least one language.");
    }

    const missing = languages.filter((language) => !available.includes(language));
    if (missing.length > 0) {
        throw new Error(`Missing local language manifest(s): ${missing.join(", ")}`);
    }

    const defaultLanguage = normalizeLanguageId(rawConfig.defaultLanguage) || languages[0];
    if (!languages.includes(defaultLanguage)) {
        throw new Error(`Default language is not enabled: ${defaultLanguage}`);
    }

    const comparisonLanguages = uniqueLanguageIds(rawConfig.comparisonLanguages ?? ["chs", "en"])
        .filter((language) => languages.includes(language));
    const dataBaseUrl = local
        ? "http://localhost:4174/"
        : validateProductionBaseUrl(rawConfig.r2PublicBaseUrl);

    return {
        schemaVersion: 1,
        dataBaseUrl,
        languages,
        defaultLanguage,
        comparisonLanguages
    };
}

export function loadReleaseConfig(configPath) {
    const resolvedPath = path.resolve(configPath);
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Cloudflare release configuration not found: ${resolvedPath}`);
    }

    return JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
}
