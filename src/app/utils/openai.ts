import { configs } from "../configs";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  // ```json ... ``` or ``` ... ```
  if (trimmed.startsWith("```")) {
    const firstNewline = trimmed.indexOf("\n");
    const withoutFirstLine = firstNewline === -1 ? trimmed : trimmed.slice(firstNewline + 1);
    const endFence = withoutFirstLine.lastIndexOf("```");
    if (endFence !== -1) return withoutFirstLine.slice(0, endFence).trim();
  }
  return s;
}

function extractFirstJsonValue(s: string): string | null {
  const content = stripCodeFences(s).trim();
  const startObj = content.indexOf("{");
  const startArr = content.indexOf("[");
  const start =
    startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr);
  if (start === -1) return null;

  const open = content[start];
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < content.length; i++) {
    const ch = content[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === open) depth++;
    if (ch === close) depth--;

    if (depth === 0) {
      return content.slice(start, i + 1).trim();
    }
  }

  return null;
}

export async function openaiChatText(opts: {
  messages: ChatMessage[];
  temperature?: number;
}): Promise<string> {
  const apiKey = configs?.openai?.api_key;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const model = configs?.openai?.model || "gpt-4o-mini";
  const timeoutMs = Number((configs as any)?.openai?.timeout_ms) || 120000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  let text: string;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        temperature:
          typeof opts.temperature === "number" ? opts.temperature : 0.2,
      }),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e: any) {
    if (e?.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
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
    // Best-effort: attempt to extract the first JSON object/array (handles code fences + trailing text).
    const extracted = extractFirstJsonValue(content);
    if (extracted) return JSON.parse(extracted) as T;
    throw new Error("Failed to parse JSON from OpenAI response");
  }
}

