import { configs } from "../configs";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function openaiChatText(opts: {
  messages: ChatMessage[];
  temperature?: number;
}): Promise<string> {
  const apiKey = configs?.openai?.api_key;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const model = configs?.openai?.model || "gpt-4o-mini";

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: opts.messages,
      temperature: typeof opts.temperature === "number" ? opts.temperature : 0.2,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    // Avoid leaking secrets; only return a short upstream body snippet.
    throw new Error(`OpenAI error ${res.status}: ${text.slice(0, 400)}`);
  }

  const json = JSON.parse(text) as any;
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenAI returned empty content");
  }
  return content;
}

export async function openaiChatJson<T>(opts: {
  system: string;
  user: string;
  temperature?: number;
}): Promise<T> {
  const content = await openaiChatText({
    temperature: opts.temperature,
    messages: [
      { role: "system", content: `${opts.system}\n\nReturn ONLY valid JSON.` },
      { role: "user", content: opts.user },
    ],
  });

  try {
    return JSON.parse(content) as T;
  } catch {
    // Best-effort: attempt to extract the first JSON object/array.
    const startObj = content.indexOf("{");
    const startArr = content.indexOf("[");
    const start =
      startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr);
    if (start !== -1) {
      const slice = content.slice(start).trim();
      return JSON.parse(slice) as T;
    }
    throw new Error("Failed to parse JSON from OpenAI response");
  }
}

