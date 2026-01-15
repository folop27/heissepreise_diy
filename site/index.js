// Process redirects before running anything else
if (location.href.includes("heissepreise.github.io")) {
    location.href = "https://heisse-preise.io";
    return;
}

const { getQueryParameter } = require("./js/misc");
const model = require("./model");
require("./views");

const { STORE_KEYS } = require("./model/stores");
const { ProgressBar } = require("./views/progress-bar");
const { __ } = require("./browser_i18n");
const progressBar = new ProgressBar(STORE_KEYS.length);

const DEFAULT_CART_NAME = __("Cart_DefaultName");

const ensureDefaultCart = () => {
    let cart = model.carts.carts.find((entry) => entry.name === DEFAULT_CART_NAME);
    if (!cart) {
        model.carts.add(DEFAULT_CART_NAME);
        cart = model.carts.carts.find((entry) => entry.name === DEFAULT_CART_NAME);
    }
    return cart;
};

(async () => {
    await model.load(() => progressBar.addStep());
    const itemsFilter = document.querySelector("items-filter");
    const itemsList = document.querySelector("items-list");
    const itemsChart = document.querySelector("items-chart");

    itemsList.addCallback = (item) => {
        const cart = ensureDefaultCart();
        const existing = cart.items.find((cartItem) => cartItem.store === item.store && cartItem.id === item.id);
        if (existing) {
            existing.cartQuantity = (existing.cartQuantity ?? 1) + 1;
        } else {
            item.cartQuantity = 1;
            cart.items.push(item);
        }
        model.carts.save();
        localStorage.setItem("activeCartName", cart.name);
    };

    const stateToUrl = (event) => {
        const filterState = itemsFilter.shareableState;
        const listState = itemsList.shareableState;
        const chartState = itemsChart.shareableState;
        const chartedItems = model.items.filteredItems
            .filter((item) => item.chart)
            .map((item) => item.store + item.id)
            .join(";");

        history.replaceState({}, null, location.pathname + "?f=" + filterState + "&l=" + listState + "&c=" + chartState + "&d=" + chartedItems);
    };

    itemsFilter.addEventListener("x-change", stateToUrl);
    itemsList.addEventListener("x-change", stateToUrl);

    const f = getQueryParameter("f");
    const l = getQueryParameter("l");
    const c = getQueryParameter("c");
    const d = getQueryParameter("d");
    if (f) itemsFilter.shareableState = f;
    if (l) itemsList.shareableState = l;
    if (c) itemsChart.shareableState = c;
    if (d) {
        for (const id of d.split(";")) {
            model.items.lookup[id].chart = true;
        }
    }
    itemsFilter.model = itemsList.model = model.items;
    itemsFilter.fireChangeEvent();
})();
