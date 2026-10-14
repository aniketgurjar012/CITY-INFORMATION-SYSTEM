"use strict";

// API Settings
const CONFIG = {
    MAX_ITEMS: 10,
    CACHE_HOURS: 24,
    IMAGE_CONCURRENCY: 3,
    SEARCH_DELAY: 300
};

const API = {
    gemini: "https://generativelanguage.googleapis.com/v1beta",
    geocoding: "https://geocoding-api.open-meteo.com/v1/search",
    weather: "https://api.open-meteo.com/v1/forecast",
    commons: "https://commons.wikimedia.org/w/api.php",
    wikipedia: "https://en.wikipedia.org/w/api.php"
};

// Variables
let currentCity = null;
let cityRequestId = 0;
let searchRequestId = 0;
let geminiCounter = 0;
let miniMap = null;
let fullMap = null;
let clockTimer = null;
let toastTimer = null;
let selectedTheme = 0;
let imageQueue = [];
let activeImages = 0;
let imageRequestGeneration = 0;

const modelCache = new Map();
const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);

// Basic Functions
function escapeHTML(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function setText(selector, value) {
    const element = $(selector);
    if (!element) return;
    element.textContent = value === null || value === undefined || value === "" ? "Unavailable" : value;
}

function valid(id) {
    return id === cityRequestId;
}

function normalize(value) {
    return String(value || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "");
}

function formatNumber(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
        return "Unavailable";
    }
    return new Intl.NumberFormat("en-IN").format(value);
}

function shortText(value, maximum = 430) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= maximum) return text;
    return text.slice(0, maximum).replace(/\s+\S*$/, "").trim() + "...";
}

function uniqueItems(items) {
    const seen = new Set();

    return (Array.isArray(items) ? items : []).filter(item => {
        if (!item || typeof item.name !== "string") return false;
        const name = normalize(item.name);
        if (!name || seen.has(name)) return false;
        seen.add(name);
        return true;
    });
}

function showLoader(message) {
    setText("#loaderText", message);
    $("#loader").classList.remove("hidden");
}

function hideLoader() {
    $("#loader").classList.add("hidden");
}

function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
        element.classList.remove("show");
    }, 3500);
}

function emptyState(message) {
    return `<div class="empty-state">
        <i class="fa-solid fa-circle-info"></i>
        ${escapeHTML(message)}
    </div>`;
}

function mapSearchURL(name, city) {
    const query = [name, city.name, city.state, city.country].filter(Boolean).join(", ");
    return "https://www.openstreetmap.org/search?query=" + encodeURIComponent(query);
}

// Fetch API
async function fetchJSON(url, options = {}, timeout = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        }

        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

// Local Storage Cache
function getCache(key) {
    try {
        const raw = localStorage.getItem("cityatlas_v10_" + key);
        if (!raw) return null;

        const data = JSON.parse(raw);

        if (Date.now() > data.expires) {
            localStorage.removeItem("cityatlas_v10_" + key);
            return null;
        }

        return data.value;
    } catch {
        return null;
    }
}

function setCache(key, value) {
    try {
        localStorage.setItem("cityatlas_v10_" + key, JSON.stringify({
            value: value,
            expires: Date.now() + CONFIG.CACHE_HOURS * 3600000
        }));
    } catch {}
}

// Gemini Models
async function getGeminiModels(key) {
    if (modelCache.has(key)) return modelCache.get(key);

    const cacheKey = "model_" + normalize(key.slice(-12));
    const cached = getCache(cacheKey);

    if (cached?.length) {
        modelCache.set(key, cached);
        return cached;
    }

    const data = await fetchJSON(`${API.gemini}/models?pageSize=100`, {
        headers: { "x-goog-api-key": key }
    }, 12000);

    const models = (data.models || [])
        .filter(model => model.supportedGenerationMethods?.includes("generateContent"))
        .filter(model => /gemini/i.test(model.name))
        .filter(model => /flash/i.test(model.name))
        .filter(model => !/image|audio|tts|embedding/i.test(model.name));

    models.sort((a, b) => {
        const version = name => {
            const match = name.match(/gemini-(\d+(?:\.\d+)?)/);
            return match ? Number(match[1]) : 0;
        };
        return version(b.name) - version(a.name);
    });

    const names = models.map(model => model.name);

    if (!names.length) throw new Error("No compatible Gemini model available.");

    modelCache.set(key, names);
    setCache(cacheKey, names);
    return names;
}

async function askGemini(prompt) {
    const response = await fetch("/api/gemini", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ prompt: prompt })
    });

    if (!response.ok) {
        throw new Error("Gemini API unavailable");
    }

    return await response.json();
}

// AI City Information
async function getCityGuide(city) {
    const cacheKey = normalize(`${city.name}_${city.state}_${city.country}`);
    const cached = getCache("guide_" + cacheKey);
    if (cached) return cached;

    const prompt = `
You are a professional travel researcher.

DESTINATION:
City: ${city.name}
State: ${city.state}
Country: ${city.country}

Provide a concise, high-quality city travel guide.

Return up to 10 items in each category:
- Iconic famous places
- Renowned hotels
- Famous restaurants
- Famous local dishes

Also provide:
- Short overview
- Short history
- Local food culture
- Best time to visit
- Maximum 4 interesting facts

LANDMARK RULES:
Choose the most iconic and representative attractions.
Prioritize internationally or nationally recognizable landmarks,
famous monuments, forts, palaces, major temples, famous markets,
significant museums and major visitor destinations.
Do not prioritize ordinary mosques, random statues, road intersections,
schools or generic buildings.
For the hero landmark, select ONE of the most widely recognized
and photographed symbols of this city.
Prefer major heritage monuments and iconic attractions.

HOTEL RULES:
Recommend established, reputed hotels.
Prioritize recognized hotel brands and renowned premium 3, 4 and
5-star properties.
Do not invent star ratings.
Exclude PGs, student hostels, lodges and dormitories.

RESTAURANT RULES:
Recommend well-known established restaurants, premium dining
destinations and genuinely iconic local eateries.
Avoid obscure or generic establishments.

FOOD RULES:
Return actual local dishes, not restaurant names.

TRAVEL SEASON:
Provide recommended months and one-line reason.

FACTS:
Maximum 4 specific interesting facts.

GENERAL:
Do not invent locations, businesses or statistics.
Do not confuse similarly named cities.
Do not invent coordinates or image URLs.
Avoid duplicates.
Return fewer results when uncertain.
Return valid JSON only.

JSON FORMAT:
{
    "overview": "",
    "history": "",
    "foodCulture": "",
    "heroLandmark": "",
    "bestTime": {
        "months": "",
        "reason": ""
    },
    "facts": [],
    "places": [
        {
            "name": "",
            "type": "",
            "description": ""
        }
    ],
    "hotels": [
        {
            "name": "",
            "description": "",
            "category": ""
        }
    ],
    "restaurants": [
        {
            "name": "",
            "description": "",
            "category": ""
        }
    ],
    "foods": [
        {
            "name": "",
            "description": ""
        }
    ]
}`;

    const data = await askGemini(prompt);

    const result = {
        overview: String(data.overview || ""),
        history: String(data.history || ""),
        foodCulture: String(data.foodCulture || ""),
        heroLandmark: String(data.heroLandmark || ""),
        bestTime: {
            months: String(data.bestTime?.months || ""),
            reason: String(data.bestTime?.reason || "")
        },
        facts: Array.isArray(data.facts)
            ? data.facts.filter(item => typeof item === "string" && item.trim()).slice(0, 4)
            : [],
        places: uniqueItems(data.places).slice(0, 10),
        hotels: uniqueItems(data.hotels).slice(0, 10),
        restaurants: uniqueItems(data.restaurants).slice(0, 10),
        foods: uniqueItems(data.foods).slice(0, 10)
    };

    setCache("guide_" + cacheKey, result);
    return result;
}

// City Search
async function searchCities(query) {
    const params = new URLSearchParams({
        name: query,
        count: "10",
        language: "en",
        format: "json"
    });

    const data = await fetchJSON(`${API.geocoding}?${params}`, {}, 12000);

    return (data.results || []).map(city => ({
        name: city.name,
        state: city.admin1 || "",
        country: city.country || "",
        latitude: city.latitude,
        longitude: city.longitude,
        population: city.population ?? null,
        timezone: city.timezone || null
    }));
}

// Search Suggestions
function setupAutocomplete(inputSelector, boxSelector) {
    const input = $(inputSelector);
    const box = $(boxSelector);
    let timer;
    let sequence = 0;

    input.addEventListener("input", () => {
        clearTimeout(timer);
        const query = input.value.trim();
        const current = ++sequence;

        if (query.length < 2) {
            box.classList.add("hidden");
            box.innerHTML = "";
            return;
        }

        box.innerHTML = `<div class="suggestion-message">Searching destinations...</div>`;
        box.classList.remove("hidden");

        timer = setTimeout(async () => {
            try {
                const cities = await searchCities(query);
                if (current !== sequence) return;

                box.innerHTML = "";

                if (!cities.length) {
                    box.innerHTML = `<div class="suggestion-message">No matching city found.</div>`;
                    return;
                }

                cities.forEach(city => {
                    const button = document.createElement("button");
                    button.className = "suggestion-item";

                    button.innerHTML = `
                        <i class="fa-solid fa-location-dot"></i>
                        <div>
                            <strong>${escapeHTML(city.name)}</strong>
                            <small>${escapeHTML([city.state, city.country].filter(Boolean).join(", "))}</small>
                        </div>`;

                    button.onclick = () => {
                        ++sequence;
                        input.value = city.name;
                        box.classList.add("hidden");
                        openCity(city);
                    };

                    box.appendChild(button);
                });
            } catch (error) {
                console.error("Autocomplete:", error);
                if (current !== sequence) return;
                box.innerHTML = `<div class="suggestion-message">Suggestions unavailable.</div>`;
            }
        }, CONFIG.SEARCH_DELAY);
    });
}

// Handle Search
async function handleSearch(selector) {
    const query = $(selector).value.trim();

    if (!query) {
        toast("Enter a city name.");
        return;
    }

    const id = ++searchRequestId;
    showLoader("Finding destination...");

    try {
        const cities = await searchCities(query);
        if (id !== searchRequestId) return;

        const city = cities.find(item =>
            item.name.toLowerCase() === query.toLowerCase()
        ) || cities[0];

        if (!city) {
            hideLoader();
            toast("Destination not found.");
            return;
        }

        openCity(city);
    } catch (error) {
        console.error("Search:", error);
        if (id !== searchRequestId) return;
        hideLoader();
        toast("Search failed.");
    }
}

// Reset Dashboard
function resetDashboard() {
    imageQueue = [];
    imageRequestGeneration++;

    const bg = $("#dashboardBackground");
    bg.style.backgroundImage = "";
    bg.dataset.priority = "0";

    $("#heroCredit").textContent = "";
    $("#placesGrid").innerHTML = emptyState("Discovering iconic places...");
    $("#hotelsGrid").innerHTML = emptyState("Finding premium hotels...");
    $("#restaurantsGrid").innerHTML = emptyState("Finding restaurants...");
    $("#foodGrid").innerHTML = "";
    $("#forecastGrid").innerHTML = emptyState("Loading forecast...");
    $("#factsGrid").textContent = "Discovering interesting facts...";

    setText("#bestMonths", "Discovering...");
    setText("#bestReason", "Finding the best travel season...");
    setText("#cityDescription", "Researching destination...");
    setText("#historyContent", "Discovering history...");
    setText("#foodDescription", "Discovering local cuisine...");

    const weatherFields = [
        "#temperature", "#humidity", "#wind", "#feelsLike",
        "#humidityDetail", "#windDetail", "#rainChance",
        "#sunrise", "#sunset"
    ];

    weatherFields.forEach(selector => setText(selector, "—"));
    setText("#weatherCondition", "Loading...");
}

// Open City Dashboard
function openCity(city) {
    const id = ++cityRequestId;
    ++searchRequestId;

    currentCity = city;
    resetDashboard();

    $("#homepage").classList.add("hidden");
    $("#dashboard").classList.remove("hidden");
    $("#sidebar").classList.remove("open");
    window.scrollTo(0, 0);

    setText("#cityName", city.name);
    setText("#cityLocation", [city.state, city.country].filter(Boolean).join(", "));
    setText("#population", formatNumber(city.population));
    setText("#cityRegion", city.state);
    setText("#cityCountry", city.country);

    $("#dashboardSearch").value = "";
    $("#homeSuggestions").classList.add("hidden");
    $("#dashboardSuggestions").classList.add("hidden");

    initializeMaps(city);
    updateLocalTime(city.timezone);

    const params = new URLSearchParams({
        city: city.name,
        lat: city.latitude,
        lon: city.longitude,
        state: city.state,
        country: city.country
    });

    history.replaceState({}, "", `${location.pathname}?${params}`);
    hideLoader();

    loadWeather(city, id).catch(console.error);
    loadAIContent(city, id).catch(console.error);
}

// Load AI Content
async function loadAIContent(city, id) {
    try {
        const data = await getCityGuide(city);
        if (!valid(id)) return;

        setText("#cityDescription", shortText(data.overview, 470));
        setText("#historyContent", shortText(data.history, 470));
        setText("#foodDescription", shortText(data.foodCulture, 430));
        setText("#bestMonths", data.bestTime.months || "Unavailable");
        setText("#bestReason", data.bestTime.reason || "Reason unavailable");

        renderFacts(data.facts);
        renderPlaces(data.places, city, id);
        renderFoods(data.foods, id);
        renderBusinesses(data.hotels, "#hotelsGrid", "fa-hotel", city, "hotels");
        renderBusinesses(data.restaurants, "#restaurantsGrid", "fa-utensils", city, "restaurants");
        loadIconicBackground(data.heroLandmark, data.places, city, id);

    } catch (error) {
        console.error("Gemini guide:", error);
        if (!valid(id)) return;

        setText("#cityDescription", "City information temporarily unavailable.");
        setText("#historyContent", "History unavailable.");
        setText("#foodDescription", "Cuisine information unavailable.");

        $("#placesGrid").innerHTML = emptyState("Famous places unavailable.");
        $("#hotelsGrid").innerHTML = emptyState("Hotels unavailable.");
        $("#restaurantsGrid").innerHTML = emptyState("Restaurants unavailable.");
        $("#foodGrid").innerHTML = emptyState("Famous food unavailable.");
        $("#factsGrid").textContent = "Facts unavailable.";

        setText("#bestMonths", "Unavailable");
        setText("#bestReason", "Travel information unavailable.");
    }
}

// Fun Facts
function renderFacts(facts) {
    const grid = $("#factsGrid");
    grid.replaceChildren();

    if (!facts.length) {
        grid.textContent = "Specific facts are unavailable.";
        return;
    }

    facts.slice(0, 4).forEach(fact => {
        const item = document.createElement("div");
        item.className = "fact-item";

        const icon = document.createElement("i");
        icon.className = "fa-solid fa-star";

        const text = document.createElement("span");
        text.textContent = fact;

        item.append(icon, text);
        grid.appendChild(item);
    });
}

// Wikimedia Images
async function searchCommons(query) {
    const key = "images_" + normalize(query);
    const cached = getCache(key);
    if (cached) return cached;

    const params = new URLSearchParams({
        action: "query",
        generator: "search",
        gsrsearch: query,
        gsrnamespace: "6",
        gsrlimit: "12",
        prop: "imageinfo",
        iiprop: "url|mime",
        iiurlwidth: "1100",
        format: "json",
        origin: "*"
    });

    const data = await fetchJSON(`${API.commons}?${params}`, {}, 12000);

    const images = Object.values(data.query?.pages || {})
        .map(page => {
            const info = page.imageinfo?.[0];

            return {
                title: page.title.replace(/^File:/i, ""),
                url: info?.thumburl || info?.url,
                source: info?.descriptionurl || "",
                mime: info?.mime || ""
            };
        })
        .filter(image =>
            image.url &&
            image.mime.startsWith("image/") &&
            image.mime !== "image/svg+xml"
        );

    setCache(key, images);
    return images;
}

// Wikipedia Images
async function searchWikipediaImage(name) {
    const params = new URLSearchParams({
        action: "query",
        titles: name,
        prop: "pageimages|info",
        piprop: "thumbnail",
        pithumbsize: "1400",
        inprop: "url",
        format: "json",
        origin: "*"
    });

    const data = await fetchJSON(`${API.wikipedia}?${params}`, {}, 10000);
    const page = Object.values(data.query?.pages || {})[0];

    if (!page?.thumbnail?.source) return null;
    if (normalize(page.title.split("(")[0]) !== normalize(name)) return null;

    return {
        title: page.title,
        url: page.thumbnail.source,
        source: page.fullurl || ""
    };
}

// Image Matching
function imageScore(image, name, city = "") {
    const title = normalize(image.title);
    const target = normalize(name);
    let score = 0;

    if (title.includes(target)) score += 100;

    const words = name.split(/\s+/).map(normalize).filter(word => word.length > 3);
    let matches = 0;

    words.forEach(word => {
        if (title.includes(word)) {
            score += 15;
            matches++;
        }
    });

    if (city && title.includes(normalize(city))) score += 20;

    if (words.length >= 2 && matches < 2 && !title.includes(target)) {
        score -= 100;
    }

    return score;
}

// Check Image
function testImage(url, timeout = 6500) {
    return new Promise(resolve => {
        if (!url) {
            resolve(false);
            return;
        }

        const img = new Image();
        let done = false;

        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve(false);
        }, timeout);

        img.onload = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(img.naturalWidth >= 200 && img.naturalHeight >= 120);
        };

        img.onerror = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(false);
        };

        img.src = url;
    });
}

// Find Image
async function findImage(name, city = "", food = false) {
    const key = "selected_" + normalize(`${name}_${city}_${food}`);
    const cached = getCache(key);

    if (cached && await testImage(cached.url, 3500)) return cached;

    try {
        const wiki = await searchWikipediaImage(name);

        if (wiki && await testImage(wiki.url)) {
            setCache(key, wiki);
            return wiki;
        }
    } catch {}

    try {
        const images = await searchCommons(food ? `${name} food` : `${name} ${city}`);

        const ranked = images
            .map(image => ({
                ...image,
                score: imageScore(image, name, food ? "" : city)
            }))
            .filter(image => image.score >= 65)
            .sort((a, b) => b.score - a.score);

        for (const image of ranked.slice(0, 3)) {
            if (await testImage(image.url)) {
                setCache(key, image);
                return image;
            }
        }
    } catch (error) {
        console.warn("Image search:", error.message);
    }

    return null;
}

// Image Queue
function queueImage(task) {
    imageQueue.push({
        task: task,
        generation: imageRequestGeneration
    });
    processImageQueue();
}

function processImageQueue() {
    while (activeImages < CONFIG.IMAGE_CONCURRENCY && imageQueue.length) {
        const item = imageQueue.shift();

        if (item.generation !== imageRequestGeneration) continue;

        activeImages++;

        Promise.resolve()
            .then(item.task)
            .catch(console.warn)
            .finally(() => {
                activeImages--;
                processImageQueue();
            });
    }
}

function createImageWrapper(icon) {
    const wrapper = document.createElement("div");
    wrapper.className = "place-image";
    wrapper.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    return wrapper;
}

// Load Card Photos
function loadCardImage(wrapper, name, city, id, food = false) {
    queueImage(async () => {
        if (!valid(id)) return;

        const image = await findImage(name, city, food);
        if (!valid(id) || !image) return;

        const img = document.createElement("img");
        img.src = image.url;
        img.alt = name;
        img.loading = "lazy";

        img.onerror = () => {
            wrapper.innerHTML = food
                ? '<i class="fa-solid fa-bowl-food"></i>'
                : '<i class="fa-solid fa-landmark"></i>';
        };

        wrapper.replaceChildren(img);
    });
}

// Dashboard Background
function applyBackground(image, id, priority = 1) {
    if (!valid(id) || !image?.url) return;

    const bg = $("#dashboardBackground");
    const oldPriority = Number(bg.dataset.priority || 0);

    if (priority < oldPriority) return;

    bg.dataset.priority = String(priority);
    const safeURL = image.url.replaceAll('"', "%22");
    bg.style.backgroundImage = `url("${safeURL}")`;

    const credit = $("#heroCredit");
    credit.replaceChildren();

    if (image.source) {
        const link = document.createElement("a");
        link.href = image.source;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "View photograph source";
        credit.appendChild(link);
    }
}

// Famous Landmark Background
async function loadIconicBackground(heroLandmark, places, city, id) {
    const names = [heroLandmark, ...places.map(place => place.name)].filter(Boolean);
    const unique = [...new Set(names)];

    for (const name of unique.slice(0, 4)) {
        if (!valid(id)) return;

        const image = await findImage(name, city.name);
        if (!valid(id)) return;

        if (image) {
            applyBackground(image, id, 2);
            return;
        }
    }

    try {
        const image = await searchWikipediaImage(city.name);

        if (image && await testImage(image.url)) {
            applyBackground(image, id, 1);
        }
    } catch {}
}

// Famous Places
function renderPlaces(places, city, id) {
    const grid = $("#placesGrid");
    grid.replaceChildren();

    if (!places.length) {
        grid.innerHTML = emptyState("No famous places identified.");
        return;
    }

    places.forEach(place => {
        const card = document.createElement("article");
        card.className = "place-card";

        const image = createImageWrapper("fa-landmark");
        const details = document.createElement("div");
        details.className = "place-details";

        const title = document.createElement("h3");
        title.textContent = place.name;

        const description = document.createElement("p");
        description.textContent = shortText(place.description, 125);

        const link = document.createElement("a");
        link.href = mapSearchURL(place.name, city);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.innerHTML = 'Find on Map <i class="fa-solid fa-arrow-right"></i>';

        details.append(title, description, link);
        card.append(image, details);
        grid.appendChild(card);

        loadCardImage(image, place.name, city.name, id);
    });
}

// Famous Food
function renderFoods(foods, id) {
    const grid = $("#foodGrid");
    grid.replaceChildren();

    if (!foods.length) {
        grid.innerHTML = emptyState("Local food information unavailable.");
        return;
    }

    foods.forEach(food => {
        const card = document.createElement("article");
        card.className = "food-card";

        const image = createImageWrapper("fa-bowl-food");
        const details = document.createElement("div");
        details.className = "food-details";

        const title = document.createElement("h3");
        title.textContent = food.name;

        const description = document.createElement("p");
        description.textContent = shortText(food.description, 125);

        details.append(title, description);
        card.append(image, details);
        grid.appendChild(card);

        loadCardImage(image, food.name, "", id, true);
    });
}

// Hotels and Restaurants
function renderBusinesses(items, selector, icon, city, type) {
    const grid = $(selector);
    grid.replaceChildren();

    if (!items.length) {
        grid.innerHTML = emptyState(
            type === "hotels"
                ? "No renowned hotels confidently identified."
                : "No famous restaurants confidently identified."
        );
        return;
    }

    items.forEach(item => {
        const card = document.createElement("article");
        card.className = "listing-card";

        const symbol = document.createElement("i");
        symbol.className = `fa-solid ${icon}`;

        const tag = document.createElement("span");
        tag.className = "listing-tag";
        tag.textContent = item.category || "Recommended";

        const title = document.createElement("h3");
        title.textContent = item.name;

        const description = document.createElement("p");
        description.textContent = shortText(item.description, 150);

        const link = document.createElement("a");
        link.href = mapSearchURL(item.name, city);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.innerHTML = 'Find Location <i class="fa-solid fa-arrow-right"></i>';

        card.append(symbol, tag, title, description, link);
        grid.appendChild(card);
    });
}

// Weather Codes
function weatherInfo(code) {
    if (code === 0) return ["Clear Sky", "fa-sun"];
    if ([1, 2].includes(code)) return ["Partly Cloudy", "fa-cloud-sun"];
    if (code === 3) return ["Cloudy", "fa-cloud"];
    if ([45, 48].includes(code)) return ["Foggy", "fa-smog"];
    if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return ["Rainy", "fa-cloud-rain"];
    if ([71, 73, 75, 85, 86].includes(code)) return ["Snowy", "fa-snowflake"];
    if ([95, 96, 99].includes(code)) return ["Thunderstorm", "fa-cloud-bolt"];
    return ["Unavailable", "fa-cloud"];
}

// Time Format
function formatTime(value) {
    if (!value) return "Unavailable";

    const time = value.split("T")[1];
    if (!time) return "Unavailable";

    const [hour, minute] = time.split(":");
    const h = Number(hour);
    return `${h % 12 || 12}:${minute} ${h >= 12 ? "PM" : "AM"}`;
}

// Live Weather
async function loadWeather(city, id) {
    const params = new URLSearchParams({
        latitude: city.latitude,
        longitude: city.longitude,
        current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max",
        timezone: "auto",
        forecast_days: "6"
    });

    try {
        const data = await fetchJSON(`${API.weather}?${params}`, {}, 12000);
        if (!valid(id)) return;

        const current = data.current;
        const daily = data.daily;

        if (!current || !daily) throw new Error("Weather unavailable.");

        const [condition, icon] = weatherInfo(current.weather_code);

        setText("#temperature", `${Math.round(current.temperature_2m)}°C`);
        setText("#weatherCondition", condition);
        $("#weatherIcon").className = `fa-solid ${icon}`;

        setText("#humidity", `${current.relative_humidity_2m}%`);
        setText("#wind", `${current.wind_speed_10m} km/h`);
        setText("#feelsLike", `${Math.round(current.apparent_temperature)}°C`);
        setText("#humidityDetail", `${current.relative_humidity_2m}%`);
        setText("#windDetail", `${current.wind_speed_10m} km/h`);

        const rain = daily.precipitation_probability_max?.[0];
        setText("#rainChance", rain == null ? "Unavailable" : `${rain}%`);
        setText("#sunrise", formatTime(daily.sunrise?.[0]));
        setText("#sunset", formatTime(daily.sunset?.[0]));

        updateLocalTime(data.timezone);
        renderForecast(daily);

    } catch (error) {
        console.error("Weather:", error);
        if (!valid(id)) return;

        setText("#weatherCondition", "Unavailable");
        $("#forecastGrid").innerHTML = emptyState("Weather forecast unavailable.");
    }
}

// Six Day Forecast
function renderForecast(daily) {
    const grid = $("#forecastGrid");
    grid.replaceChildren();

    daily.time.forEach((date, index) => {
        const [, icon] = weatherInfo(daily.weather_code[index]);

        const day = new Date(`${date}T12:00:00`).toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric"
        });

        const rain = daily.precipitation_probability_max?.[index];
        const card = document.createElement("div");
        card.className = "forecast-day";

        card.innerHTML = `
            <span>${escapeHTML(day)}</span>
            <i class="fa-solid ${icon}"></i>
            <strong>
                ${Math.round(daily.temperature_2m_max[index])}° /
                ${Math.round(daily.temperature_2m_min[index])}°
            </strong>
            <span class="rain-probability">
                <i class="fa-solid fa-cloud-rain"></i>
                ${rain == null ? "—" : `${rain}%`} rain
            </span>`;

        grid.appendChild(card);
    });
}

// Local Time
function updateLocalTime(timezone) {
    clearInterval(clockTimer);

    if (!timezone) {
        setText("#localTime", "Unavailable");
        return;
    }

    function update() {
        try {
            const time = new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                hour: "2-digit",
                minute: "2-digit",
                hour12: true
            }).format(new Date());

            setText("#localTime", time);
        } catch {
            setText("#localTime", "Unavailable");
        }
    }

    update();
    clockTimer = setInterval(update, 30000);
}

// Maps
function initializeMaps(city) {
    const coordinates = [city.latitude, city.longitude];

    if (miniMap) {
        miniMap.remove();
        miniMap = null;
    }

    if (fullMap) {
        fullMap.remove();
        fullMap = null;
    }

    miniMap = L.map("miniMap", {
        zoomControl: false,
        scrollWheelZoom: false,
        dragging: false
    }).setView(coordinates, 11);

    fullMap = L.map("fullMap").setView(coordinates, 12);

    const tiles = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
    const attribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

    L.tileLayer(tiles, {
        attribution: attribution,
        maxZoom: 19
    }).addTo(miniMap);

    L.tileLayer(tiles, {
        attribution: attribution,
        maxZoom: 19
    }).addTo(fullMap);

    L.marker(coordinates).addTo(miniMap);
    L.marker(coordinates).addTo(fullMap).bindPopup(escapeHTML(city.name));

    $("#osmLink").href =
        `https://www.openstreetmap.org/?mlat=${city.latitude}&mlon=${city.longitude}#map=12/${city.latitude}/${city.longitude}`;

    setTimeout(() => {
        miniMap?.invalidateSize();
        fullMap?.invalidateSize();
    }, 350);
}

// Sidebar Navigation
function navigateToSection(id) {
    const section = document.getElementById(id);
    if (!section) return;

    section.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });

    $$(".sidebar-link").forEach(button => {
        button.classList.toggle("active", button.dataset.target === id);
    });

    $("#sidebar").classList.remove("open");

    if (id === "mapSection") {
        setTimeout(() => fullMap?.invalidateSize(), 450);
    }
}

// Colour Themes
function applyTheme(index) {
    const dashboard = $("#dashboard");

    dashboard.classList.remove(
        "theme-ocean",
        "theme-sunset",
        "theme-aurora"
    );

    const themes = ["", "theme-ocean", "theme-sunset", "theme-aurora"];

    if (themes[index]) {
        dashboard.classList.add(themes[index]);
    }
}

function changeTheme() {
    selectedTheme = (selectedTheme + 1) % 4;
    applyTheme(selectedTheme);
    localStorage.setItem("cityatlas_color_theme", selectedTheme);
}

// Share City
async function shareCity() {
    if (!currentCity) return;

    try {
        if (navigator.share) {
            await navigator.share({
                title: `Explore ${currentCity.name} | CityAtlas`,
                url: location.href
            });
        } else {
            await navigator.clipboard.writeText(location.href);
            toast("City link copied!");
        }
    } catch (error) {
        if (error.name !== "AbortError") {
            toast("Unable to share city.");
        }
    }
}

// Back to Homepage
function goHome() {
    ++cityRequestId;
    ++searchRequestId;

    currentCity = null;
    imageQueue = [];
    imageRequestGeneration++;
    clearInterval(clockTimer);

    $("#dashboard").classList.add("hidden");
    $("#homepage").classList.remove("hidden");
    $("#sidebar").classList.remove("open");

    history.replaceState({}, "", location.pathname);
    window.scrollTo(0, 0);
}

// Shared City Link
function loadSharedCity() {
    const params = new URLSearchParams(location.search);
    const name = params.get("city");
    const lat = params.get("lat");
    const lon = params.get("lon");

    if (!name || lat === null || lon === null) return;

    const latitude = Number(lat);
    const longitude = Number(lon);

    if (!Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180) {
        return;
    }

    openCity({
        name: name,
        latitude: latitude,
        longitude: longitude,
        state: params.get("state") || "",
        country: params.get("country") || "",
        population: null,
        timezone: null
    });
}

// Button Events
function setupEvents() {
    setupAutocomplete("#homeSearch", "#homeSuggestions");
    setupAutocomplete("#dashboardSearch", "#dashboardSuggestions");

    $("#homeSearchForm").addEventListener("submit", event => {
        event.preventDefault();
        handleSearch("#homeSearch");
    });

    $("#dashboardSearchForm").addEventListener("submit", event => {
        event.preventDefault();
        handleSearch("#dashboardSearch");
    });

    $$(".sidebar-link").forEach(button => {
        button.onclick = () => navigateToSection(button.dataset.target);
    });

    $$("[data-target].gradient-btn").forEach(button => {
        button.onclick = () => navigateToSection(button.dataset.target);
    });

    $("#changeTheme").onclick = changeTheme;
    $("#shareBtn").onclick = shareCity;
    $("#backHome").onclick = goHome;

    $("#dashboardLogo").onclick = event => {
        event.preventDefault();
        goHome();
    };

    $("#homeLogo").onclick = event => {
        event.preventDefault();
        goHome();
    };

    $("#sidebarToggle").onclick = () => {
        $("#sidebar").classList.toggle("open");
    };

    $("#homeMenu").onclick = () => {
        $("#homeNav").classList.toggle("open");
    };

    document.addEventListener("click", event => {
        if (!event.target.closest(".search-container")) {
            $("#homeSuggestions").classList.add("hidden");
        }

        if (!event.target.closest(".dashboard-search-container")) {
            $("#dashboardSuggestions").classList.add("hidden");
        }
    });
}

// Start Website
function initializeApp() {
    $("#currentYear").textContent = new Date().getFullYear();

    const savedTheme = Number(
        localStorage.getItem("cityatlas_color_theme") || 0
    );

    if (Number.isInteger(savedTheme) && savedTheme >= 0 && savedTheme < 4) {
        selectedTheme = savedTheme;
        applyTheme(selectedTheme);
    }

    setupEvents();
    loadSharedCity();
}

document.addEventListener("DOMContentLoaded", initializeApp);