export function createPagefindLoader({
    languageConfigs,
    pageUrl,
    importModule = (moduleUrl) => import(moduleUrl)
}) {
    const configsById = new Map(languageConfigs.map((config) => [config.id, config]));
    let activeModule = null;
    let activeLanguage = null;

    async function load(language) {
        if (language === activeLanguage && activeModule) {
            return activeModule;
        }

        const config = configsById.get(language);
        if (!config) {
            throw new Error(`No Pagefind configuration is available for language: ${language}`);
        }

        if (activeModule) {
            await activeModule.destroy();
            activeModule = null;
            activeLanguage = null;
        }

        const pagefindModuleUrl = new URL("pagefind.js", config.pagefindBaseUrl).href;
        const pagefind = await importModule(pagefindModuleUrl);
        for (const method of ["destroy", "options", "init", "search"]) {
            if (typeof pagefind[method] !== "function") {
                throw new Error(`Invalid Pagefind module for ${language}: missing ${method}()`);
            }
        }

        await pagefind.destroy();
        const crossOrigin = new URL(config.pagefindBaseUrl).origin !== new URL(pageUrl).origin;
        await pagefind.options({
            basePath: config.pagefindBaseUrl,
            noWorker: crossOrigin
        });
        await pagefind.init();
        activeModule = pagefind;
        activeLanguage = language;
        return pagefind;
    }

    return {
        load,
        get activeLanguage() {
            return activeLanguage;
        }
    };
}
