const fs = require("fs");
const path = require("path");
const http = require("http");
const analysis = require("./analysis");
const bundle = require("./bundle");
const csv = require("./site/js/misc");
const chokidar = require("chokidar");
const express = require("express");
const compression = require("compression");
const i18n = require("./i18n");
const axios = require("axios");

function copyItemsToSite(dataDir) {
    const items = analysis.readJSON(`${dataDir}/latest-canonical.json.${analysis.FILE_COMPRESSOR}`).filter((item) => item.name);
    analysis.writeJSON(`site/output/data/latest-canonical.json`, items);
    for (const store of analysis.STORE_KEYS) {
        const storeItems = items.filter((item) => item.store === store);
        analysis.writeJSON(`site/output/data/latest-canonical.${store}.compressed.json`, storeItems, false, 0, true);
    }
    const csvItems = csv.itemsToCSV(items);
    fs.writeFileSync("site/output/data/latest-canonical.csv", csvItems, "utf-8");
    console.log("Copied latest items to site.");
}

function scheduleFunction(hour, minute, second, func) {
    const now = new Date();

    const scheduledTime = new Date();
    scheduledTime.setHours(hour);
    scheduledTime.setMinutes(minute);
    scheduledTime.setSeconds(second);

    if (now > scheduledTime) {
        scheduledTime.setDate(scheduledTime.getDate() + 1);
    }
    const delay = scheduledTime.getTime() - now.getTime();

    console.log("Scheduling next function call: " + scheduledTime.toString());

    setTimeout(async () => {
        await func();
        scheduleFunction(hour, minute, second, func);
    }, delay);
}

function parseArguments() {
    const args = process.argv.slice(2);
    let port = process.env.PORT !== undefined && process.env.PORT != "" ? parseInt(process.env.PORT) : 3000;
    let liveReload = process.env.NODE_ENV === "development" || false;
    let skipDataUpdate = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "-p" || args[i] === "--port") {
            port = parseInt(args[i + 1]);
            i++;
        } else if (args[i] === "-l" || args[i] === "--live-reload") {
            if (process.env.NODE_ENV !== "development") {
                throw new Error("Live reload is only supported in development mode");
            }
            liveReload = true;
        } else if (args[i] === "-s" || args[i] === "--skip-data-update") {
            skipDataUpdate = true;
        } else if (args[i] === "-h" || args[i] === "--help") {
            console.log("Usage: node server.js [-p|--port PORT] [-l|--live-reload]");
            console.log();
            console.log("Options:");
            console.log("  -p, --port PORT         Port to listen on (default: 3000)");
            console.log("  -l, --live-reload       Enable live reload (automatically enabled if NODE_ENV is development)");
            console.log("  -s, --skip-data-update  Skip fetching data");
            process.exit(0);
        }
    }

    return { port, liveReload, skipDataUpdate };
}

function setupLogging() {
    // Poor man's logging framework, wooh...
    const originalConsoleLog = console.log;
    const logStream = fs.createWriteStream("site/output/data/log.txt", { flags: "a" });
    logStream.write("===========================================\n\n");
    console.log = (message) => {
        const formattedMessage = `[${new Date().toISOString()}] ${message}\n`;
        logStream.write(formattedMessage);
        originalConsoleLog.apply(console, [message]);
    };
}

(async () => {
    const dataDir = "data";
    const { port, liveReload, skipDataUpdate } = parseArguments();

    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir);
    }

    const outputDir = "site/output";

    if (fs.existsSync("site/output/data/log.txt")) {
        fs.copyFileSync("site/output/data/log.txt", "site/log.txt");
    }
    bundle.deleteDirectory(outputDir);
    fs.mkdirSync(outputDir);
    fs.mkdirSync(outputDir + "/data");
    if (fs.existsSync("site/log.txt")) {
        fs.copyFileSync("site/log.txt", "site/output/data/log.txt");
        fs.unlinkSync("site/log.txt");
    }
    setupLogging();
    bundle.bundle("site", outputDir, liveReload);

    if (!skipDataUpdate) {
        analysis.migrateCompression(dataDir, ".json", ".json.br");
        analysis.migrateCompression(dataDir, ".json.gz", ".json.br");

        if (fs.existsSync(`${dataDir}/latest-canonical.json.${analysis.FILE_COMPRESSOR}`)) {
            copyItemsToSite(dataDir);
            analysis.updateData(dataDir, (_newItems) => {
                copyItemsToSite(dataDir);
            });
        } else {
            await analysis.updateData(dataDir);
            copyItemsToSite(dataDir);
        }
        scheduleFunction(5, 0, 0, async () => {
            items = await analysis.updateData(dataDir);
            copyItemsToSite(dataDir);
        });
    } else {
        copyItemsToSite(dataDir);
    }

    const app = express();
    app.use(compression());
    app.use(express.json({ limit: "1mb" }));
    app.use(function (req, res, next) {
        if (req.method == "GET") {
            if (req.path == "/") {
                req.url = "/index.html";
            }
            if (req.path.endsWith(".html")) {
                // Only html files are translated
                let pickedLanguage = req.acceptsLanguages(i18n.locales);
                if (pickedLanguage) {
                    let translatedPath = req.path.substring(0, req.path.length - "html".length) + pickedLanguage + ".html";
                    req.url = translatedPath;
                } // otherwise use default, untranslated file
            }
        }
        next();
    });

    const getEdamamConfig = () => {
        const appId = process.env.EDAMAM_APP_ID;
        const appKey = process.env.EDAMAM_APP_KEY;
        if (!appId || !appKey) {
            throw new Error("Missing EDAMAM_APP_ID or EDAMAM_APP_KEY");
        }
        return { appId, appKey };
    };

    const parseRecipeId = (href) => {
        if (!href) return null;
        const match = href.match(/\/api\/recipes\/v2\/([^?]+)/);
        return match ? match[1] : null;
    };

    const buildRangeParam = (range) => {
        if (!range) return null;
        const min = range.min != null ? range.min : "";
        const max = range.max != null ? range.max : "";
        if (min === "" && max === "") return null;
        return `${min}-${max}`;
    };

    const unitMap = {
        g: { unit: "g", factor: 1 },
        gram: { unit: "g", factor: 1 },
        grams: { unit: "g", factor: 1 },
        kg: { unit: "g", factor: 1000 },
        kilogram: { unit: "g", factor: 1000 },
        kilograms: { unit: "g", factor: 1000 },
        oz: { unit: "g", factor: 28.3495 },
        ounce: { unit: "g", factor: 28.3495 },
        ounces: { unit: "g", factor: 28.3495 },
        lb: { unit: "g", factor: 453.592 },
        pound: { unit: "g", factor: 453.592 },
        pounds: { unit: "g", factor: 453.592 },
        ml: { unit: "ml", factor: 1 },
        milliliter: { unit: "ml", factor: 1 },
        milliliters: { unit: "ml", factor: 1 },
        l: { unit: "ml", factor: 1000 },
        liter: { unit: "ml", factor: 1000 },
        liters: { unit: "ml", factor: 1000 },
        tsp: { unit: "ml", factor: 5 },
        teaspoon: { unit: "ml", factor: 5 },
        teaspoons: { unit: "ml", factor: 5 },
        tbsp: { unit: "ml", factor: 15 },
        tablespoon: { unit: "ml", factor: 15 },
        tablespoons: { unit: "ml", factor: 15 },
        cup: { unit: "ml", factor: 240 },
        cups: { unit: "ml", factor: 240 },
        pinch: { unit: "pcs", factor: 1 },
        dash: { unit: "pcs", factor: 1 },
        clove: { unit: "pcs", factor: 1 },
        cloves: { unit: "pcs", factor: 1 },
        piece: { unit: "pcs", factor: 1 },
        pieces: { unit: "pcs", factor: 1 },
    };

    const normalizeName = (text) => {
        if (!text) return "";
        return text
            .toLowerCase()
            .replace(/\\([^)]*\\)/g, " ")
            .replace(/[^\\p{L}\\p{N}]+/gu, " ")
            .replace(/\\s+/g, " ")
            .trim();
    };

    const normalizeQuantity = (qty) => {
        if (!Number.isFinite(qty)) return 0;
        return Math.round(qty * 100) / 100;
    };

    const normalizeIngredient = (ingredient, scale) => {
        const quantity = ingredient.quantity ?? 1;
        const measureKey = ingredient.measure ? ingredient.measure.toLowerCase() : null;
        const conversion = measureKey ? unitMap[measureKey] : null;
        let unit = conversion?.unit ?? null;
        let qty = conversion ? quantity * conversion.factor : null;

        if (!unit && ingredient.weight) {
            unit = "g";
            qty = ingredient.weight;
        }

        if (!unit) {
            unit = measureKey || "pcs";
            qty = quantity;
        }

        qty *= scale;
        if (unit === "g" && qty >= 1000) {
            qty /= 1000;
            unit = "kg";
        }
        if (unit === "ml" && qty >= 1000) {
            qty /= 1000;
            unit = "l";
        }

        const preferredName = ingredient.food || ingredient.text || "";
        const canonicalFromFood = normalizeName(ingredient.food);
        const canonicalFromText = normalizeName(ingredient.text);
        const canonicalName = canonicalFromFood || canonicalFromText || preferredName.toLowerCase().trim();

        return {
            canonical_name: canonicalName,
            display_name: preferredName,
            qty: normalizeQuantity(qty),
            unit,
            raw_text: ingredient.text,
            aliases: [ingredient.foodCategory, ingredient.food, ingredient.text]
                .filter(Boolean)
                .map((alias) => normalizeName(alias))
                .filter((alias) => alias.length > 0),
        };
    };

    const buildEdamamRecipe = (hit) => {
        const recipe = hit.recipe;
        return {
            id: parseRecipeId(hit._links?.self?.href) || parseRecipeId(recipe.uri) || recipe.uri,
            label: recipe.label,
            image: recipe.image,
            source: recipe.source,
            url: recipe.url,
            yield: recipe.yield,
            calories: recipe.calories,
            totalNutrients: recipe.totalNutrients,
            dietLabels: recipe.dietLabels,
            healthLabels: recipe.healthLabels,
            ingredientLines: recipe.ingredientLines,
        };
    };

    app.post("/recipes/search", async (req, res) => {
        try {
            const { appId, appKey } = getEdamamConfig();
            const { query, calories, macros, dietLabels = [], healthLabels = [], excludedIngredients = [], from = 0, to = 50 } = req.body || {};

            const params = new URLSearchParams({
                type: "public",
                app_id: appId,
                app_key: appKey,
                q: query && query.length ? query : "recipe",
                from: String(from),
                to: String(to),
            });

            const caloriesRange = buildRangeParam(calories);
            if (caloriesRange) params.append("calories", caloriesRange);

            const nutrientMap = {
                protein: "PROCNT",
                carbs: "CHOCDF",
                fat: "FAT",
            };

            if (macros) {
                Object.keys(nutrientMap).forEach((macro) => {
                    const range = buildRangeParam(macros[macro]);
                    if (range) params.append(`nutrients[${nutrientMap[macro]}]`, range);
                });
            }

            dietLabels.forEach((label) => params.append("diet", label));
            healthLabels.forEach((label) => params.append("health", label));
            excludedIngredients.forEach((item) => params.append("excluded", item));

            const response = await axios.get(`https://api.edamam.com/api/recipes/v2?${params.toString()}`);
            const hits = response.data.hits.map((hit) => buildEdamamRecipe(hit));
            res.json({ hits, count: response.data.count });
        } catch (error) {
            res.status(500).json({ message: error.message || "Failed to fetch recipes." });
        }
    });

    app.get("/recipes/:id", async (req, res) => {
        try {
            const { appId, appKey } = getEdamamConfig();
            const id = req.params.id;
            const response = await axios.get(`https://api.edamam.com/api/recipes/v2/${id}?type=public&app_id=${appId}&app_key=${appKey}`);
            const recipe = response.data.recipe;
            res.json({
                recipe: {
                    ...recipe,
                    id,
                },
            });
        } catch (error) {
            res.status(500).json({ message: error.message || "Failed to fetch recipe details." });
        }
    });

    app.post("/recipes/:id/ingredients/export", async (req, res) => {
        try {
            const { appId, appKey } = getEdamamConfig();
            const id = req.params.id;
            const desiredServings = Number(req.body?.desiredServings) || 1;
            const response = await axios.get(`https://api.edamam.com/api/recipes/v2/${id}?type=public&app_id=${appId}&app_key=${appKey}`);
            const recipe = response.data.recipe;
            const baseServings = recipe.yield || 1;
            const scale = desiredServings / baseServings;
            const items = new Map();

            recipe.ingredients.forEach((ingredient) => {
                const normalized = normalizeIngredient(ingredient, scale);
                const key = `${normalized.canonical_name}-${normalized.unit}`;
                const existing = items.get(key);
                if (existing) {
                    existing.qty = normalizeQuantity(existing.qty + normalized.qty);
                    existing.aliases = [...new Set([...(existing.aliases || []), ...(normalized.aliases || [])])];
                    existing.raw_text = existing.raw_text || normalized.raw_text;
                } else {
                    items.set(key, normalized);
                }
            });

            const payloadItems = [...items.values()].map((item) => ({
                name: item.canonical_name,
                display_name: item.display_name,
                qty: item.qty,
                unit: item.unit,
                raw_text: item.raw_text,
                search_terms: [item.canonical_name, item.display_name, ...(item.aliases || [])].filter((entry) => entry && entry.length > 0),
            }));

            res.json({
                source: "edamam",
                recipe_ids: [id],
                items: payloadItems,
            });
        } catch (error) {
            res.status(500).json({ message: error.message || "Failed to export ingredients." });
        }
    });

    app.use(express.static("site/output"));
    const server = http.createServer(app).listen(port, () => {
        console.log(`App listening on port ${port}`);
    });
    if (liveReload) {
        const socketIO = require("socket.io");
        const sockets = [];
        const io = socketIO(server);
        io.on("connection", (socket) => sockets.push(socket));
        let timeoutId = 0;
        chokidar.watch("site/output").on("all", () => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                lastChangeTimestamp = Date.now();
                for (let i = 0; i < sockets.length; i++) {
                    sockets[i].send(`${lastChangeTimestamp}`);
                }
            }, 500);
        });
    }
})();
