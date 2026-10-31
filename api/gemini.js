import fs from "fs";
import path from "path";

function loadEnvFile() {
    try {
        const envPath = path.join(process.cwd(), ".env");
        if (!fs.existsSync(envPath)) return {};
        const content = fs.readFileSync(envPath, "utf8");
        const env = {};
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eqIdx = trimmed.indexOf("=");
            if (eqIdx !== -1) {
                const key = trimmed.slice(0, eqIdx).trim();
                const val = trimmed.slice(eqIdx + 1).replace(/^["']|["',]+$/g, "").trim();
                env[key] = val;
            }
        }
        return env;
    } catch {
        return {};
    }
}

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const localEnv = loadEnvFile();
    const rawKeys = [
        process.env.GEMINI_API_KEY_1 || localEnv.GEMINI_API_KEY_1,
        process.env.GEMINI_API_KEY_2 || localEnv.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3 || localEnv.GEMINI_API_KEY_3
    ];

    const keys = [...new Set(
        rawKeys
            .map(k => String(k || "").replace(/^["']|["',]+$/g, "").trim())
            .filter(Boolean)
    )];

    if (!keys.length) {
        return res.status(500).json({ error: "API keys missing" });
    }

    const prompt = req.body?.prompt;
    if (!prompt || typeof prompt !== "string") {
        return res.status(400).json({ error: "Invalid prompt" });
    }

    // Active, high-speed Gemini models (sorted by latency and availability)
    const CANDIDATE_MODELS = [
        "models/gemini-3.5-flash-lite",
        "models/gemini-flash-lite-latest",
        "models/gemini-flash-latest",
        "models/gemini-3.1-flash-lite",
        "models/gemini-3.8-flash"
    ];

    let lastError = "Gemini unavailable";

    for (const key of keys) {
        for (const model of CANDIDATE_MODELS) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 15000);

                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${encodeURIComponent(key)}`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }] }],
                            generationConfig: {
                                temperature: 0.1,
                                responseMimeType: "application/json"
                            }
                        }),
                        signal: controller.signal
                    }
                );

                clearTimeout(timer);

                if (!response.ok) {
                    lastError = `Gemini HTTP ${response.status}`;
                    // If quota exceeded or access forbidden, break to next key
                    if (response.status === 429 || response.status === 403) {
                        break;
                    }
                    continue;
                }

                const data = await response.json();
                const text = data.candidates?.[0]?.content?.parts
                    ?.map(part => part.text || "").join("");

                if (!text) continue;

                let clean = text.trim();
                if (clean.startsWith("```")) {
                    clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
                }

                return res.status(200).json(JSON.parse(clean));

            } catch (error) {
                lastError = error.message;
            }
        }
    }

    return res.status(503).json({ error: lastError });
}
