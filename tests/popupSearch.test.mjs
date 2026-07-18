import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../popup/search.js", import.meta.url), "utf8");
const context = vm.createContext({ URL });
vm.runInContext(source, context);
const { buildSearchUrl } = context.KDPopupSearch;

test("buildSearchUrl creates favorited artist searches", () => {
    assert.equal(
        buildSearchUrl("pawchive", "alice & bob"),
        "https://pawchive.pw/artists?q=alice+%26+bob&sort_by=favorited"
    );
    assert.equal(
        buildSearchUrl("kemono", " creator "),
        "https://kemono.cr/artists?q=creator&sort_by=favorited"
    );
    assert.equal(
        buildSearchUrl("coomer", "creator"),
        "https://coomer.st/artists?q=creator&sort_by=favorited"
    );
});

test("buildSearchUrl creates CoomerFans root searches", () => {
    assert.equal(
        buildSearchUrl("coomerfans", "creator"),
        "https://coomerfans.com/?q=creator"
    );
});

test("buildSearchUrl rejects empty queries and unknown sites", () => {
    assert.equal(buildSearchUrl("pawchive", "  "), null);
    assert.equal(buildSearchUrl("unknown", "creator"), null);
});
