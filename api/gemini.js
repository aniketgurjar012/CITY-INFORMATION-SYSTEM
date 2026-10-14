export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const keys = [
        process.env.GEMINI_API_KEY_1,
        process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3
    ].filter(Boolean);

    if (!keys.length) {
        return res.status(500).json({ error: "API keys missing" });
    }

    const prompt = req.body?.prompt;

    if (!prompt || typeof prompt !== "string") {
        return res.status(400).json({ error: "Invalid prompt" });
    }

    let lastError = "Gemini unavailable";

    for (const key of keys) {
        try {
            const modelResponse = await fetch(
                "https://generativelanguage.googleapis.com/v1beta/models",
                { headers: { "x-goog-api-key": key } }
            );

            if (!modelResponse.ok) continue;

            const modelData = await modelResponse.json();

            const models = (modelData.models || [])
                .filter(model => model.supportedGenerationMethods?.includes("generateContent"))
                .filter(model => /gemini/i.test(model.name))
                .filter(model => /flash/i.test(model.name))
                .filter(model => !/image|audio|tts|embedding/i.test(model.name));

            for (const model of models) {
                try {
                    const response = await fetch(
                        `https://generativelanguage.googleapis.com/v1beta/${model.name}:generateContent`,
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "x-goog-api-key": key
                            },
                            body: JSON.stringify({
                                contents: [{ parts: [{ text: prompt }] }],
                                generationConfig: {
                                    temperature: 0.1,
                                    responseMimeType: "application/json"
                                }
                            })
                        }
                    );

                    if (!response.ok) {
                        lastError = `Gemini HTTP ${response.status}`;
                        continue;
                    }

                    const data = await response.json();

                    const text = data.candidates?.[0]?.content?.parts
                        ?.map(part => part.text || "").join("");

                    if (!text) continue;

                    return res.status(200).json(JSON.parse(text));

                } catch (error) {
                    lastError = error.message;
                }
            }
        } catch (error) {
            lastError = error.message;
        }
    }

    return res.status(503).json({ error: lastError });
}