const { numberToLocale, parseNumber } = require("./js/misc");
const model = require("./model");
require("./views");
const { ProgressBar } = require("./views/progress-bar");
const { STORE_KEYS } = require("./model/stores");
const { View } = require("./views/view");
const { __ } = require("./browser_i18n");

const DEFAULT_PAGE_SIZE = 20;
const FETCH_PAGE_SIZE = 50;
const INGREDIENT_STORAGE_KEY = "recipeIngredientList";
const TRANSFER_STORAGE_KEY = "recipeShoppingImportPayload";

const DIET_LABELS = [
    { value: "balanced", label: __("Recipes_Diet_Balanced") },
    { value: "high-protein", label: __("Recipes_Diet_HighProtein") },
    { value: "low-carb", label: __("Recipes_Diet_LowCarb") },
    { value: "low-fat", label: __("Recipes_Diet_LowFat") },
    { value: "low-sodium", label: __("Recipes_Diet_LowSodium") },
];

const HEALTH_LABELS = [
    { value: "gluten-free", label: __("Recipes_Health_GlutenFree") },
    { value: "dairy-free", label: __("Recipes_Health_DairyFree") },
    { value: "egg-free", label: __("Recipes_Health_EggFree") },
    { value: "peanut-free", label: __("Recipes_Health_PeanutFree") },
    { value: "tree-nut-free", label: __("Recipes_Health_TreeNutFree") },
    { value: "soy-free", label: __("Recipes_Health_SoyFree") },
    { value: "fish-free", label: __("Recipes_Health_FishFree") },
    { value: "shellfish-free", label: __("Recipes_Health_ShellfishFree") },
    { value: "keto-friendly", label: __("Recipes_Health_Keto") },
];

const progressBar = new ProgressBar(STORE_KEYS.length);

const elements = View.elements(document.body);

const state = {
    results: [],
    filteredResults: [],
    sortedResults: [],
    visibleCount: DEFAULT_PAGE_SIZE,
    detail: null,
    detailExport: null,
    detailServings: null,
    ingredientList: [],
    selectedRecipeIds: new Set(),
    transferActive: false,
};

const DEFAULT_CART_NAME = __("Cart_DefaultName");

const ensureDefaultCart = () => {
    let cart = model.carts.carts.find((entry) => entry.name === DEFAULT_CART_NAME);
    if (!cart) {
        model.carts.add(DEFAULT_CART_NAME);
        cart = model.carts.carts.find((entry) => entry.name === DEFAULT_CART_NAME);
    }
    return cart;
};

const formatValue = (value, unit) => {
    if (value === undefined || value === null || Number.isNaN(value)) return "-";
    return `${numberToLocale(Math.round(value * 100) / 100)} ${unit}`;
};

const parseRange = (minValue, maxValue) => {
    const minRaw = parseNumber(minValue, null);
    const maxRaw = parseNumber(maxValue, null);
    const min = Number.isFinite(minRaw) ? minRaw : null;
    const max = Number.isFinite(maxRaw) ? maxRaw : null;
    if (min === null && max === null) return null;
    return { min, max };
};

const targetFromRange = (range) => {
    if (!range) return null;
    if (range.min != null && range.max != null) return (range.min + range.max) / 2;
    if (range.min != null) return range.min;
    if (range.max != null) return range.max;
    return null;
};

const calculateNutrition = (recipe) => {
    const servings = recipe.yield || 1;
    const calories = (recipe.calories || 0) / servings;
    const protein = (recipe.totalNutrients?.PROCNT?.quantity || 0) / servings;
    const carbs = (recipe.totalNutrients?.CHOCDF?.quantity || 0) / servings;
    const fat = (recipe.totalNutrients?.FAT?.quantity || 0) / servings;
    const proteinPct = calories ? (protein * 4 * 100) / calories : 0;
    const carbsPct = calories ? (carbs * 4 * 100) / calories : 0;
    const fatPct = calories ? (fat * 9 * 100) / calories : 0;

    return {
        servings,
        total_kcal: calories,
        protein_g: protein,
        carbs_g: carbs,
        fat_g: fat,
        protein_pct: proteinPct,
        carbs_pct: carbsPct,
        fat_pct: fatPct,
    };
};

const calculateMatchScore = (nutrition, targets) => {
    const components = [];
    if (targets.calories != null) {
        components.push(Math.abs(nutrition.total_kcal - targets.calories) / Math.max(targets.calories, 1));
    }
    if (targets.protein != null) {
        components.push(Math.abs(nutrition.protein_g - targets.protein) / Math.max(targets.protein, 1));
    }
    if (targets.carbs != null) {
        components.push(Math.abs(nutrition.carbs_g - targets.carbs) / Math.max(targets.carbs, 1));
    }
    if (targets.fat != null) {
        components.push(Math.abs(nutrition.fat_g - targets.fat) / Math.max(targets.fat, 1));
    }
    if (targets.proteinPct != null) {
        components.push(Math.abs(nutrition.protein_pct - targets.proteinPct) / Math.max(targets.proteinPct, 1));
    }
    if (targets.carbsPct != null) {
        components.push(Math.abs(nutrition.carbs_pct - targets.carbsPct) / Math.max(targets.carbsPct, 1));
    }
    if (targets.fatPct != null) {
        components.push(Math.abs(nutrition.fat_pct - targets.fatPct) / Math.max(targets.fatPct, 1));
    }
    if (components.length === 0) return 0;
    return components.reduce((sum, value) => sum + value, 0) / components.length;
};

const matchesPercentConstraints = (nutrition, constraints) => {
    if (!constraints) return true;
    const checks = [
        { value: nutrition.protein_pct, range: constraints.proteinPct },
        { value: nutrition.carbs_pct, range: constraints.carbsPct },
        { value: nutrition.fat_pct, range: constraints.fatPct },
    ];

    return checks.every(({ value, range }) => {
        if (!range) return true;
        if (range.min != null && value < range.min) return false;
        if (range.max != null && value > range.max) return false;
        return true;
    });
};

const buildSearchPayload = () => {
    const calories = parseRange(elements.kcalMin.value, elements.kcalMax.value);
    const protein = parseRange(elements.proteinMin.value, elements.proteinMax.value);
    const carbs = parseRange(elements.carbsMin.value, elements.carbsMax.value);
    const fat = parseRange(elements.fatMin.value, elements.fatMax.value);
    const percentConstraints = {
        proteinPct: parseRange(elements.proteinPctMin.value, elements.proteinPctMax.value),
        carbsPct: parseRange(elements.carbsPctMin.value, elements.carbsPctMax.value),
        fatPct: parseRange(elements.fatPctMin.value, elements.fatPctMax.value),
    };

    const targets = {
        calories: targetFromRange(calories),
        protein: targetFromRange(protein),
        carbs: targetFromRange(carbs),
        fat: targetFromRange(fat),
        proteinPct: targetFromRange(percentConstraints.proteinPct),
        carbsPct: targetFromRange(percentConstraints.carbsPct),
        fatPct: targetFromRange(percentConstraints.fatPct),
    };

    const excludedIngredients = elements.excluded.value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

    return {
        query: elements.query.value.trim(),
        calories,
        macros: { protein, carbs, fat },
        percentConstraints,
        targets,
        dietLabels: collectSelections(elements.dietLabels),
        healthLabels: collectSelections(elements.healthLabels),
        excludedIngredients,
        from: 0,
        to: FETCH_PAGE_SIZE,
    };
};

const collectSelections = (container) => {
    return [...container.querySelectorAll("input[type='checkbox']")].filter((input) => input.checked).map((input) => input.value);
};

const showApiWarning = (message) => {
    elements.apiWarning.classList.remove("hidden");
    elements.apiWarning.innerText = message;
};

const clearApiWarning = () => {
    elements.apiWarning.classList.add("hidden");
    elements.apiWarning.innerText = "";
};

const searchRecipes = async () => {
    const payload = buildSearchPayload();
    state.visibleCount = DEFAULT_PAGE_SIZE;
    clearApiWarning();

    try {
        const response = await fetch("/recipes/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: response.statusText }));
            showApiWarning(error.message || __("Recipes_Error_Api"));
            state.results = [];
            state.filteredResults = [];
            state.sortedResults = [];
            renderResults();
            return;
        }
        const data = await response.json();
        const enriched = data.hits.map((recipe) => {
            const nutrition = calculateNutrition(recipe);
            return {
                ...recipe,
                ...nutrition,
                match_score: calculateMatchScore(nutrition, payload.targets),
            };
        });
        state.results = enriched;
        state.filteredResults = enriched.filter((recipe) => matchesPercentConstraints(recipe, payload.percentConstraints));
        applySort();
    } catch (error) {
        showApiWarning(__("Recipes_Error_Api"));
    }
};

const applySort = () => {
    const sortType = elements.sort.value;
    const targetCalories = targetFromRange(parseRange(elements.kcalMin.value, elements.kcalMax.value));
    const results = [...state.filteredResults];

    if (sortType === "best-match") {
        results.sort((a, b) => a.match_score - b.match_score);
    } else if (sortType === "protein-pct") {
        results.sort((a, b) => b.protein_pct - a.protein_pct);
    } else if (sortType === "carbs-pct") {
        results.sort((a, b) => a.carbs_pct - b.carbs_pct);
    } else if (sortType === "calories-low") {
        results.sort((a, b) => a.total_kcal - b.total_kcal);
    } else if (sortType === "calories-closest") {
        const target = targetCalories ?? 0;
        results.sort((a, b) => Math.abs(a.total_kcal - target) - Math.abs(b.total_kcal - target));
    }

    state.sortedResults = results;
    renderResults();
};

const shuffleResults = () => {
    const shuffled = [...state.filteredResults];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    state.sortedResults = shuffled;
    state.visibleCount = DEFAULT_PAGE_SIZE;
    renderResults();
};

const renderResults = () => {
    const results = state.sortedResults.slice(0, state.visibleCount);
    elements.results.innerHTML = "";

    elements.resultsCount.innerText = state.sortedResults.length;

    if (state.sortedResults.length === 0) {
        elements.noResults.classList.remove("hidden");
    } else {
        elements.noResults.classList.add("hidden");
    }

    results.forEach((recipe) => {
        const card = document.createElement("div");
        card.className = "bg-white border border-gray-200 rounded-xl p-4 shadow-sm flex flex-col gap-3";
        card.innerHTML = `
            <div class="flex flex-col gap-2">
                ${recipe.image ? `<img class="rounded-lg object-cover w-full h-40" src="${recipe.image}" alt="${recipe.label}" />` : ""}
                <div>
                    <h3 class="text-base font-semibold">${recipe.label}</h3>
                    <div class="text-xs text-gray-500">${recipe.source || ""}</div>
                </div>
                <div class="text-xs text-gray-600">
                    <div>${__("Recipes_KcalPerServing")}: <strong>${numberToLocale(Math.round(recipe.total_kcal))}</strong></div>
                    <div>${__("Recipes_Protein")}: ${formatValue(recipe.protein_g, "g")} (${numberToLocale(recipe.protein_pct)}%)</div>
                    <div>${__("Recipes_Carbs")}: ${formatValue(recipe.carbs_g, "g")} (${numberToLocale(recipe.carbs_pct)}%)</div>
                    <div>${__("Recipes_Fat")}: ${formatValue(recipe.fat_g, "g")} (${numberToLocale(recipe.fat_pct)}%)</div>
                </div>
            </div>
            <button data-recipe-id="${recipe.id}" class="mt-auto rounded-lg border border-primary text-primary px-3 py-2 text-xs font-semibold">${__(
            "Recipes_ViewDetails"
        )}</button>
        `;
        elements.results.appendChild(card);
    });

    elements.loadMore.classList.toggle("hidden", state.sortedResults.length <= state.visibleCount);

    elements.results.querySelectorAll("button[data-recipe-id]").forEach((button) => {
        button.addEventListener("click", () => loadRecipeDetail(button.dataset.recipeId));
    });
};

const loadRecipeDetail = async (recipeId) => {
    if (!recipeId) return;
    elements.detail.innerHTML = __("Recipes_Loading");
    try {
        const response = await fetch(`/recipes/${recipeId}`);
        if (!response.ok) {
            elements.detail.innerHTML = __("Recipes_Error_Detail");
            return;
        }
        const data = await response.json();
        state.detail = data.recipe;
        state.detailServings = Math.max(1, Math.round(data.recipe.yield || 1));
        state.selectedRecipeIds.add(recipeId);
        await refreshDetailExport();
        renderDetail();
    } catch (error) {
        elements.detail.innerHTML = __("Recipes_Error_Detail");
    }
};

const refreshDetailExport = async () => {
    if (!state.detail) return;
    const recipeId = state.detail.id;
    const desiredServings = state.detailServings || state.detail.yield || 1;
    try {
        const response = await fetch(`/recipes/${recipeId}/ingredients/export`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ desiredServings }),
        });
        if (!response.ok) return;
        const payload = await response.json();
        state.detailExport = payload;
    } catch (error) {
        state.detailExport = null;
    }
};

const renderDetail = () => {
    if (!state.detail) {
        elements.detail.innerHTML = __("Recipes_SelectHint");
        return;
    }
    const recipe = state.detail;
    const nutrition = calculateNutrition(recipe);

    const ingredientPreview = state.detailExport?.items || [];

    elements.detail.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
                ${recipe.image ? `<img class="rounded-lg object-cover w-full" src="${recipe.image}" alt="${recipe.label}" />` : ""}
            </div>
            <div class="md:col-span-2 flex flex-col gap-3">
                <div>
                    <h3 class="text-lg font-semibold">${recipe.label}</h3>
                    <div class="text-xs text-gray-500">${__("Recipes_Source")}: ${recipe.source || ""}</div>
                </div>
                <div class="text-sm text-gray-700">
                    <div>${__("Recipes_NutritionSummary")}: ${numberToLocale(Math.round(nutrition.total_kcal))} kcal</div>
                    <div>${__("Recipes_Protein")}: ${formatValue(nutrition.protein_g, "g")} (${numberToLocale(nutrition.protein_pct)}%)</div>
                    <div>${__("Recipes_Carbs")}: ${formatValue(nutrition.carbs_g, "g")} (${numberToLocale(nutrition.carbs_pct)}%)</div>
                    <div>${__("Recipes_Fat")}: ${formatValue(nutrition.fat_g, "g")} (${numberToLocale(nutrition.fat_pct)}%)</div>
                </div>
                <div class="flex flex-wrap items-center gap-2 text-sm">
                    <span>${__("Recipes_BaseServings")}: ${numberToLocale(recipe.yield || 1)}</span>
                    <label class="flex items-center gap-2">
                        ${__("Recipes_Servings")}
                        <input x-id="servingsInput" class="w-20 rounded-lg border border-gray-300 px-2 py-1 text-sm" type="number" min="1" value="${
                            state.detailServings || recipe.yield || 1
                        }" />
                    </label>
                </div>
                <div class="flex flex-wrap gap-2">
                    <button x-id="addIngredients" class="rounded-lg bg-primary text-white px-3 py-2 text-sm font-semibold">${__(
                        "Recipes_AddIngredients"
                    )}</button>
                    ${
                        recipe.url
                            ? `<a class="rounded-lg border border-gray-300 px-3 py-2 text-sm" href="${recipe.url}" target="_blank">${__(
                                  "Recipes_ViewSource"
                              )}</a>`
                            : ""
                    }
                </div>
            </div>
        </div>
        <div class="mt-4">
            <h4 class="text-sm font-semibold mb-2">${__("Recipes_Ingredients")}</h4>
            <ul class="list-disc list-inside text-sm text-gray-700">
                ${(recipe.ingredientLines || []).map((line) => `<li>${line}</li>`).join("")}
            </ul>
        </div>
        <div class="mt-4">
            <h4 class="text-sm font-semibold mb-2">${__("Recipes_ScaledIngredients")}</h4>
            <ul class="list-disc list-inside text-sm text-gray-700">
                ${
                    ingredientPreview.length
                        ? ingredientPreview
                              .map((item) => `<li>${numberToLocale(item.qty)} ${item.unit} ${item.display_name || item.name}</li>`)
                              .join("")
                        : `<li>${__("Recipes_NoScaledIngredients")}</li>`
                }
            </ul>
        </div>
    `;

    const servingsInput = elements.detail.querySelector("[x-id='servingsInput']");
    const addIngredientsButton = elements.detail.querySelector("[x-id='addIngredients']");

    servingsInput.addEventListener("change", async () => {
        const value = parseNumber(servingsInput.value, 1);
        state.detailServings = Math.max(1, value || 1);
        await refreshDetailExport();
        renderDetail();
    });

    addIngredientsButton.addEventListener("click", () => {
        if (!state.detailExport) return;
        addToIngredientList(state.detailExport);
    });
};

const addToIngredientList = (payload) => {
    if (!payload?.items?.length) return;
    const updated = [...state.ingredientList];

    payload.items.forEach((item) => {
        const key = `${item.name}-${item.unit}`;
        const existing = updated.find((entry) => `${entry.name}-${entry.unit}` === key);
        if (existing) {
            existing.qty += item.qty;
            existing.search_terms = [...new Set([...(existing.search_terms || []), ...(item.search_terms || [])])];
        } else {
            updated.push({
                name: item.name,
                display_name: item.display_name || item.name,
                qty: item.qty,
                unit: item.unit,
                raw_text: item.raw_text,
                search_terms: item.search_terms || [item.name],
                notes: item.notes || "",
            });
        }
    });

    state.ingredientList = updated;
    saveIngredientList();
    renderIngredientList();
};

const saveIngredientList = () => {
    localStorage.setItem(INGREDIENT_STORAGE_KEY, JSON.stringify(state.ingredientList, null, 2));
};

const loadIngredientList = () => {
    const stored = localStorage.getItem(INGREDIENT_STORAGE_KEY);
    state.ingredientList = stored ? JSON.parse(stored) : [];
};

const renderIngredientList = () => {
    if (!state.ingredientList.length) {
        elements.ingredientEmpty.classList.remove("hidden");
        elements.ingredientList.classList.add("hidden");
        elements.ingredientList.innerHTML = "";
        return;
    }

    elements.ingredientEmpty.classList.add("hidden");
    elements.ingredientList.classList.remove("hidden");

    elements.ingredientList.innerHTML = `
        <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
                <thead>
                    <tr class="text-xs text-gray-500">
                        <th class="py-2">${__("Recipes_Qty")}</th>
                        <th class="py-2">${__("Recipes_Unit")}</th>
                        <th class="py-2">${__("Recipes_Name")}</th>
                        <th class="py-2"></th>
                    </tr>
                </thead>
                <tbody>
                    ${state.ingredientList
                        .map(
                            (item, index) => `
                        <tr class="border-t">
                            <td class="py-2 pr-2">${numberToLocale(Math.round(item.qty * 100) / 100)}</td>
                            <td class="py-2 pr-2">${item.unit}</td>
                            <td class="py-2 pr-2">${item.display_name || item.name}</td>
                            <td class="py-2 text-right">
                                <button data-index="${index}" data-action="search" class="rounded-lg border border-gray-300 px-2 py-1 text-xs">${__(
                                "Recipes_SearchProducts"
                            )}</button>
                                <button data-index="${index}" data-action="remove" class="rounded-lg border border-gray-300 px-2 py-1 text-xs">${__(
                                "Recipes_Remove"
                            )}</button>
                            </td>
                        </tr>
                    `
                        )
                        .join("")}
                </tbody>
            </table>
        </div>
    `;

    elements.ingredientList.querySelectorAll("button[data-action]").forEach((button) => {
        button.addEventListener("click", () => {
            const index = parseInt(button.dataset.index, 10);
            const item = state.ingredientList[index];
            if (!item) return;
            if (button.dataset.action === "remove") {
                state.ingredientList.splice(index, 1);
                saveIngredientList();
                renderIngredientList();
                return;
            }
            if (button.dataset.action === "search") {
                activateTransfer();
                searchProducts(item);
            }
        });
    });
};

const activateTransfer = () => {
    state.transferActive = true;
    elements.productSearchSection.classList.remove("hidden");
    elements.transferHint.classList.remove("hidden");
    elements.transferHint.innerText = __("Recipes_TransferHint", { name: DEFAULT_CART_NAME });
    localStorage.setItem(
        TRANSFER_STORAGE_KEY,
        JSON.stringify(
            {
                source: "edamam",
                recipe_ids: [...state.selectedRecipeIds],
                items: state.ingredientList.map((item) => ({
                    name: item.name,
                    qty: item.qty,
                    unit: item.unit,
                    search_terms: item.search_terms,
                    notes: item.notes,
                })),
            },
            null,
            2
        )
    );
};

const searchProducts = (ingredient) => {
    const term = ingredient.search_terms?.find((value) => value.length >= 3) || ingredient.name || ingredient.raw_text || "";
    elements.productsFilter.elements.query.value = term;
    elements.productsFilter.fireChangeEvent();
    elements.productSearchSection.scrollIntoView({ behavior: "smooth", block: "start" });
};

const initializeCheckboxes = () => {
    const createTag = (entry) => {
        const label = document.createElement("label");
        label.className =
            "inline-flex items-center gap-1 rounded-full bg-gray-100 border border-gray-300 px-2 py-1 text-xs font-medium text-gray-600";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = entry.value;
        input.className = "rounded";
        label.appendChild(input);
        label.appendChild(document.createTextNode(entry.label));
        return label;
    };

    DIET_LABELS.forEach((entry) => elements.dietLabels.appendChild(createTag(entry)));
    HEALTH_LABELS.forEach((entry) => elements.healthLabels.appendChild(createTag(entry)));
};

const setupProductSearch = () => {
    elements.productsFilter.model = model.items;
    elements.productsList.model = model.items;
    elements.productsList.addCallback = (item) => {
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
};

const resetFilters = () => {
    elements.query.value = "";
    [
        elements.kcalMin,
        elements.kcalMax,
        elements.proteinMin,
        elements.proteinMax,
        elements.carbsMin,
        elements.carbsMax,
        elements.fatMin,
        elements.fatMax,
        elements.proteinPctMin,
        elements.proteinPctMax,
        elements.carbsPctMin,
        elements.carbsPctMax,
        elements.fatPctMin,
        elements.fatPctMax,
    ].forEach((input) => (input.value = ""));
    elements.excluded.value = "";
    elements.dietLabels.querySelectorAll("input").forEach((input) => (input.checked = false));
    elements.healthLabels.querySelectorAll("input").forEach((input) => (input.checked = false));
};

(async () => {
    initializeCheckboxes();
    loadIngredientList();

    await model.load(() => progressBar.addStep());
    setupProductSearch();
    renderIngredientList();

    elements.search.addEventListener("click", searchRecipes);
    elements.reset.addEventListener("click", () => {
        resetFilters();
        searchRecipes();
    });
    elements.sort.addEventListener("change", applySort);
    elements.shuffle.addEventListener("click", shuffleResults);
    elements.loadMore.addEventListener("click", () => {
        state.visibleCount += DEFAULT_PAGE_SIZE;
        renderResults();
    });
    elements.transfer.addEventListener("click", activateTransfer);
})();
