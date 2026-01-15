const { getQueryParameter, numberToLocale, today } = require("./js/misc");
const models = require("./model");
const { Model } = require("./model/model");
const { View } = require("./views/view");
const { STORE_KEYS, stores } = require("./model/stores");
require("./views");
const { ProgressBar } = require("./views/progress-bar");
const progressBar = new ProgressBar(STORE_KEYS.length);
const { __ } = require("./browser_i18n");

let carts = null;
const DEFAULT_CART_NAME = __("Cart_DefaultName");

class CartModel extends Model {
    constructor(cart, linked) {
        super();
        this.cart = cart;
        this.items = cart.items;
        this._filteredItems = [...this.items];
        this.linked = linked;
    }

    get filteredItems() {
        return this._filteredItems;
    }

    set filteredItems(newItems) {
        this._filteredItems = newItems;
        this.notify();
    }
}

class CartHeader extends View {
    constructor() {
        super();
        this.innerHTML = `
            <h1 class="text-2xl font-bold pb-2 pt-8 text-center">
                <span x-id="name"></span>
            </h1>
            <div x-id="total" class="text-center text-sm text-gray-700"></div>
            <a x-id="share" class="hidden cursor-pointer font-bold text-sm text-primary hover:underline block text-center mt-3">${__(
                "Cart_Teilen"
            )}</a>
            <input x-id="save" class="hidden cursor-pointer font-bold text-sm text-primary block mx-auto mt-3" type="button" value="${__(
                "Cart_Speichern"
            )}">
        `;

        const elements = this.elements;
        elements.save.addEventListener("click", () => {
            const cart = this.model.cart;
            let index = carts.findIndex((c) => c.name === cart.name);
            if (index != -1) {
                let newName = cart.name;
                while (true) {
                    newName = prompt(
                        __("Cart_Warenkorb '{{name}}' existiert bereits. Bitte einen anderen Namen für den zu speichernden Warenkorb eingeben", {
                            name: cart.name,
                        }),
                        cart.name + today()
                    );
                    if (!newName || newName.trim().length == 0) return;
                    newName = newName.trim();
                    if (newName != cart.name) {
                        cart.name = newName;
                        carts.push(cart);
                        break;
                    }
                }
            } else {
                carts.push(cart);
            }
            models.carts.save();
            location.href = location.pathname + "?name=" + encodeURIComponent(cart.name);
        });
    }

    render() {
        const cart = this.model.cart;
        const elements = this.elements;
        elements.name.innerText = __("Cart_Warenkorb {{name}}", { name: cart.name });
        const total = cart.items.reduce((sum, item) => {
            const price = item.priceHistory?.[0]?.price ?? item.price ?? 0;
            const quantity = item.cartQuantity ?? 1;
            return sum + price * quantity;
        }, 0);
        elements.total.innerText = `${__("Cart_Gesamtsumme")}: € ${numberToLocale(total)}`;
        if (this.model.linked) {
            elements.save.classList.remove("hidden");
        } else {
            elements.share.classList.remove("hidden");
            let link = encodeURIComponent(cart.name) + ";";
            for (const cartItem of cart.items) {
                link += cartItem.store + cartItem.id + ";";
            }
            elements.share.href = "cart.html?cart=" + link + (this.stateToUrl ? this.stateToUrl() : "");
        }
    }
}
customElements.define("cart-header", CartHeader);

function loadCart() {
    let cart = null;
    let linked = false;
    const cartName = getQueryParameter("name") || localStorage.getItem("activeCartName") || DEFAULT_CART_NAME;
    if (cartName) {
        for (const c of carts) {
            if (c.name == cartName) {
                cart = c;
                break;
            }
        }
        if (!cart && cartName === DEFAULT_CART_NAME) {
            cart = { name: cartName, items: [] };
            carts.push(cart);
            models.carts.save();
        }
    }

    const cartDesc = getQueryParameter("cart");
    if (cartDesc) {
        let tokens = cartDesc.split(";");
        cart = {
            name: tokens[0],
            items: [],
        };
        for (let i = 1; i < tokens.length; i++) {
            const item = models.items.lookup[tokens[i]];
            if (item) cart.items.push(item);
        }
        linked = true;
    }

    if (cart == null) {
        alert(__("Cart_Warenkorb '{{name}}' existiert nicht.", { name: cartName }));
        location.href = "carts.html";
    }

    if (!linked && cart) {
        localStorage.setItem("activeCartName", cart.name);
    }

    return new CartModel(cart, linked);
}

(async () => {
    await models.load(() => progressBar.addStep());
    carts = models.carts.carts;
    const cart = loadCart();

    const elements = View.elements(document.body);
    const cartHeader = elements.cartHeader;
    cartHeader.model = cart;

    const cartFilter = elements.cartFilter;
    const cartList = cart.linked ? elements.linkedCartList : elements.cartList;
    STORE_KEYS.forEach((store) => {
        cartFilter.elements[store].checked = true;
    });
    cartList.elements.numItemsLabel.innerHTML = `<strong>${__("Cart_Artikel")}:</strong>`;
    cartList.elements.enableChart.checked = models.items.length < 2000;
    cartList.elements.chart.elements.sumStores.checked = models.items.length < 2000;

    if (cart.items.length == 0) {
        elements.noItems.classList.remove("hidden");
    } else {
        cartFilter.classList.remove("hidden");
        cartList.classList.remove("hidden");
    }

    cartList.removeCallback = (item) => {
        models.carts.save();
        cartHeader.render();
    };
    cartList.upCallback = (item) => models.carts.save();
    cartList.downCallback = (item) => models.carts.save();
    cartList.quantityCallback = (item) => {
        models.carts.save();
        cartHeader.render();
    };

    const productsFilter = elements.productsFilter;
    const productsList = elements.productsList;
    if (!cart.linked) {
        productsFilter.classList.remove("hidden");
        productsList.classList.remove("hidden");
    }

    productsList.addCallback = (item) => {
        const existing = cart.items.find((cartItem) => cartItem.store === item.store && cartItem.id === item.id);
        if (existing) {
            existing.cartQuantity = (existing.cartQuantity ?? 1) + 1;
        } else {
            item.cartQuantity = 1;
            cart.items.push(item);
        }
        models.carts.save();
        cartFilter.filter();
        cartFilter.classList.remove("hidden");
        cartList.classList.remove("hidden");
        cartHeader.render();
    };

    const itemsFilter = cartFilter;
    const itemsList = cartList;
    const itemsChart = cartList.querySelector("items-chart");
    itemsList.elements.sort.value = "store-and-name";
    let baseUrl = location.href.split("&")[0];

    const stateToUrl = () => {
        const filterState = itemsFilter.shareableState;
        const listState = itemsList.shareableState;
        const chartState = itemsChart.shareableState;
        const chartedItems = cart.filteredItems
            .filter((item) => item.chart)
            .map((item) => item.store + item.id)
            .join(";");
        return baseUrl + "&f=" + filterState + "&l=" + listState + "&c=" + chartState + "&d=" + chartedItems;
    };
    cartHeader.stateToUrl = stateToUrl;
    itemsFilter.addEventListener("x-change", () => {
        const url = stateToUrl();
        history.pushState({}, null, url);
        cartHeader.render();
    });
    itemsList.addEventListener("x-change", () => {
        const url = stateToUrl();
        history.pushState({}, null, url);
        cartHeader.render();
    });

    const f = getQueryParameter("f");
    const l = getQueryParameter("l");
    const c = getQueryParameter("c");
    const d = getQueryParameter("d");

    if (f) itemsFilter.shareableState = f;
    if (l) itemsList.shareableState = l;
    if (c) itemsChart.shareableState = c;
    if (d) {
        cart.items.lookup = {};
        for (const item of cart.items) cart.items.lookup[item.store + item.id] = item;
        for (const id of d.split(";")) {
            cart.items.lookup[id].chart = true;
        }
        const url = stateToUrl();
        history.pushState({}, null, url);
        cartHeader.render();
    }
    cartList.model = cartFilter.model = cart;
    productsList.model = productsFilter.model = models.items;
    if (c || d) itemsChart.render();
    cartFilter.filter();
})();
