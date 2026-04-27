type McqOptionLabel = "A" | "B" | "C" | "D" | "E" | "F";

const OPTION_LABELS: McqOptionLabel[] = ["A", "B", "C", "D", "E", "F"];

const normalizeOptionLabel = (raw: unknown): McqOptionLabel | null => {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Common variants: "a", "(A)", "Option A", "A.", "Answer: B"
  const m = s.match(/[A-F]/i);
  if (!m) return null;
  const letter = m[0].toUpperCase() as McqOptionLabel;
  return OPTION_LABELS.includes(letter) ? letter : null;
};

const normalizeCorrectOption = (
  raw: unknown,
  available: McqOptionLabel[],
): McqOptionLabel | null => {
  const direct = normalizeOptionLabel(raw);
  if (direct && available.includes(direct)) return direct;

  // Accept numeric correctOption: 0.. (0-indexed) or 1.. (1-indexed)
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  const asInt = Math.trunc(n);
  if (String(asInt) !== String(n).trim()) return null;

  if (asInt >= 0 && asInt < available.length) return available[asInt];
  const oneIdx = asInt - 1;
  if (oneIdx >= 0 && oneIdx < available.length) return available[oneIdx];

  return null;
};

const ensureMcqOptions = (options: any) => {
  // Accepts: array of strings -> assume A.. by index
  if (Array.isArray(options) && options.every((o) => typeof o === "string")) {
    return options
      .map((text: string, idx: number) => ({
        option: OPTION_LABELS[idx] ?? null,
        optionText: String(text || "").trim(),
      }))
      .filter((o) => o.option && o.optionText)
      .map((o) => ({ ...o, option: o.option as McqOptionLabel }));
  }

  // Accepts: array of {option, optionText, explanation?}
  if (Array.isArray(options)) {
    const normalized = options
      .filter((o) => o && typeof o === "object")
      .map((o, idx: number) => ({
        option: normalizeOptionLabel((o as any).option) ?? (OPTION_LABELS[idx] ?? null),
        optionText: String((o as any).optionText || (o as any).text || "").trim(),
        explanation: (o as any).explanation ? String((o as any).explanation).trim() : undefined,
      }))
      .filter((o) => o.option && o.optionText);

    // De-duplicate by option label (keep first)
    const seen = new Set<string>();
    return normalized
      .filter((o) => {
        const key = String(o.option);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((o) => ({ ...o, option: o.option as McqOptionLabel }));
  }

  // Accepts: object map {A: "...", B: "..."}
  if (options && typeof options === "object") {
    return Object.entries(options)
      .map(([k, v]) => ({
        option: normalizeOptionLabel(k),
        optionText: String(v || "").trim(),
      }))
      .filter((o) => o.option && o.optionText);
  }

  return [];
};

export function normalizeMcqsWithStats(raw: any): { mcqs: any[]; dropped: number } {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.mcqs) ? raw.mcqs : [];
  let dropped = 0;

  const mcqs = arr
    .filter((m: any) => m && typeof m === "object")
    .map((m: any, idx: number) => {
      const options = ensureMcqOptions((m as any).options);
      const available = options.map((o: any) => o.option).filter(Boolean) as McqOptionLabel[];
      const correctRaw = (m as any).correctOption ?? (m as any).correctAnswer ?? (m as any).answer ?? (m as any).answerKey;
      const correctOption = normalizeCorrectOption(correctRaw, available);
      const difficulty = String((m as any).difficulty || (m as any).difficultyLevel || "Basic").trim();
      const question = String((m as any).question || "").trim();

      if (!question || !Array.isArray(options) || options.length < 2 || !correctOption) {
        dropped++;
        return null;
      }

      return {
        mcqId: String((m as any).mcqId || `AI-${idx + 1}`),
        difficulty: (["Basic", "Intermediate", "Advance"].includes(difficulty) ? difficulty : "Basic"),
        question,
        options,
        correctOption,
      };
    })
    .filter(Boolean);

  return { mcqs, dropped };
}

export function normalizeMcqs(raw: any) {
  return normalizeMcqsWithStats(raw).mcqs;
}

