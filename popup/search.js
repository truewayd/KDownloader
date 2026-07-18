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
        if (!origin || !normalizedQuery) return null;

        const url = new URL(site === "coomerfans" ? "/" : "/artists", origin);
        url.searchParams.set("q", normalizedQuery);
        if (site !== "coomerfans") url.searchParams.set("sort_by", "favorited");
        return url.href;
    }

    globalThis.KDPopupSearch = Object.freeze({ buildSearchUrl });
})();
