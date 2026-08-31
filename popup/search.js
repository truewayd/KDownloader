(() => {
    const SEARCH_ORIGINS = Object.freeze({
        pawchive: "https://pawchive.pw",
        kemono: "https://kemono.cr",
        coomer: "https://coomer.st",
        coomerfans: "https://coomerfans.com",
    });

    function buildSearchUrl(site, query) {
        const origin = SEARCH_ORIGINS[site];
        const normalizedQuery = String(query || "").trim();
        if (!origin || !normalizedQuery || normalizedQuery.length > 512) return null;

        const url = new URL(site === "coomerfans" ? "/" : "/artists", origin);
        url.searchParams.set("q", normalizedQuery);
        if (site !== "coomerfans") url.searchParams.set("sort_by", "favorited");
        return url.href;
    }

    function parseCreatorUrl(value) {
        try {
            const raw = String(value || "").trim();
            if (!raw || raw.length > 8192) return null;
            const url = new URL(raw);
            if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
            const host = url.hostname.toLowerCase();
            const parts = url.pathname.split("/").filter(Boolean);

            if ((host === "coomerfans.com" || host.endsWith(".coomerfans.com")) &&
                parts[0] === "u" && (parts.length === 3 || parts.length === 4) &&
                /^[a-z0-9_-]{1,64}$/i.test(parts[1]) && parts[2].length <= 512) {
                const creatorName = parts[3] ? decodeURIComponent(parts[3]) : "";
                if (creatorName.length > 512) return null;
                return {
                    origin: "https://coomerfans.com",
                    host,
                    service: parts[1].toLowerCase(),
                    userId: parts[2],
                    creatorName,
                    source: "coomerfans",
                };
            }

            const originByHost = {
                "pawchive.pw": "https://pawchive.pw",
                "kemono.cr": "https://kemono.cr",
                "coomer.st": "https://coomer.st",
            };
            if (!originByHost[host]
                || parts.length !== 3
                || parts[1] !== "user"
                || !/^[a-z0-9_-]{1,64}$/i.test(parts[0])
                || parts[2].length > 512) return null;
            return {
                origin: originByHost[host],
                host,
                service: parts[0].toLowerCase(),
                userId: parts[2],
            };
        } catch (error) {
            return null;
        }
    }

    globalThis.KDPopupSearch = Object.freeze({ buildSearchUrl, parseCreatorUrl });
})();
