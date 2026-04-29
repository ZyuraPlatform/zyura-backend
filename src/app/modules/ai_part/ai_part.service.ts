import { Request } from "express";
import { Types } from "mongoose";
import fs from "fs";
import { configs } from "../../configs";
import { AppError } from "../../utils/app_error";
import { isAccountExist } from "../../utils/isAccountExist";
import { daily_ai_request_model } from "../analytics/analytics.schema";
import { ClinicalCaseModel } from "../clinical_case/clinical_case.schema";
import { FlashcardModel } from "../flash_card/flash_card.schema";
import { McqBankModel } from "../mcq_bank/mcq_bank.schema";
import {
  T_MyContent_flashcard,
  T_MyContent_mcq,
  T_MyContent_notes,
} from "../my_content/my_content.interface";
import {
  my_content_clinicalCase_model,
  my_content_flashcard_model,
  my_content_mcq_bank_model,
  my_content_notes_model,
} from "../my_content/my_content.schema";
import { notes_model } from "../notes/notes.schema";
import { osce_model } from "../osce/osce.schema";
import { study_planner_model } from "../study_planner/study_planner.schema";
import { study_planner_validations } from "../study_planner/study_planner.validation";
import { openaiChatJson, openaiChatText } from "../../utils/openai";
import { ai_tutor_thread_model } from "./ai_tutor.schema";
import { normalizeMcqs, normalizeMcqsWithStats, shuffleAndRelabelMcqs } from "./mcqNormalize";
const today = new Date().toISOString().split("T")[0];

type TutorCategory = "medical_exam" | "platform_help" | "writing_assist" | "other";
type TutorIntent = "medical" | "platform" | "writing" | "other";

const outOfScopeReply =
  "I’m here to help with medical exam prep and Zyura platform questions. Please share your exam/topic (e.g., cardiology, pharmacology, OSCE, MCQs, study plan) and I’ll help.";

const normalizeText = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const looksWritingRequest = (q: string) => {
  const s = normalizeText(q);
  if (!s) return false;

  // High-precision patterns for drafting/writing tasks.
  const hasWriteVerb = /\b(write|draft|compose|reply|respond|format|rephrase|edit|polish|create)\b/.test(s);
  const hasWritingNoun = /\b(email|e-mail|message|letter|mail|sms|whatsapp|dm|text|application|cover\s*letter)\b/.test(s);
  const hasGreetingOrSubject = /\b(dear\s+(dr|doctor|sir|madam)|subject\s*:)\b/.test(s);
  const hasRecipientCue = /\b(to|for)\s+(the\s+)?(department|doctor|dr|hospital|clinic|neurology|cardiology|radiology|hr|admin|professor)\b/.test(s);

  // Typical: "write an email to neurology department ..."
  if ((hasWriteVerb && hasWritingNoun) || (hasWritingNoun && hasRecipientCue) || hasGreetingOrSubject) {
    // Avoid misclassifying pure medical explanation requests like:
    // "Explain EMG" (no writing noun/recipient cue)
    return true;
  }
  return false;
};

const looksMedicalExamRelated = (q: string) => {
  const s = normalizeText(q);
  if (!s) return false;
  const keywords = [
    "symptom",
    "sign",
    "diagnos",
    "differential",
    "treat",
    "management",
    "drug",
    "dose",
    "contraindication",
    "side effect",
    "pathophysiolog",
    "anatomy",
    "physiology",
    "pharmacology",
    "microbiology",
    "immunology",
    "histology",
    "biochem",
    "ecg",
    "x-ray",
    "ct",
    "mri",
    "lab value",
    "osce",
    "mcq",
    "nbme",
    "usmle",
    "plab",
    "mrcp",
    "neet",
    "fmge",
    "step 1",
    "step 2",
    "step 3",

    // Broader clinical / diagnostics / neuro-monitoring (avoid false blocks)
    "ssep",
    "mep",
    "emg",
    "ncs",
    "nerve",
    "impulse",
    "evoked potential",
    "intraoperative monitoring",
    "spinal cord",
    "neurologic",
    "neuro",
    "pathway",
    "lesion",
    "reflex",
    "sensory",
    "motor",
    "monitoring",
  ];
  return keywords.some((k) => s.includes(k));
};

const looksPlatformHelpRelated = (q: string) => {
  const s = normalizeText(q);
  if (!s) return false;
  const keywords = [
    "zyura",
    "flashcard",
    "flash card",
    "mcq bank",
    "quiz",
    "study plan",
    "notes",
    "clinical case",
    "tutor",
    "thread",
    "history",
    "upload",
    "dashboard",
  ];
  return keywords.some((k) => s.includes(k));
};

const parseTutorCategory = (v: unknown): TutorCategory | null => {
  if (v === "medical_exam" || v === "platform_help" || v === "writing_assist" || v === "other") return v;
  return null;
};

const classifyTutorQuestion = async (question: string): Promise<{
  category: TutorCategory;
  inDomain: boolean;
  intent: TutorIntent;
  reasonShort?: string;
}> => {
  if (looksWritingRequest(question)) {
    return { category: "writing_assist", inDomain: true, intent: "writing", reasonShort: "keyword_writing" };
  }
  if (looksPlatformHelpRelated(question)) {
    return { category: "platform_help", inDomain: true, intent: "platform", reasonShort: "keyword_platform" };
  }
  if (looksMedicalExamRelated(question)) {
    return { category: "medical_exam", inDomain: true, intent: "medical", reasonShort: "keyword_medical" };
  }

  try {
    const result = await openaiChatJson<any>({
      system: [
        "You are a strict classifier for Zyura AI Tutor.",
        "Decide whether the user question is in scope.",
        "In-scope categories:",
        '- medical_exam: medicine/clinical science, diagnostics, treatments, general medical questions, exam prep, MCQs, OSCE, study strategy for medical exams.',
        '- platform_help: questions about using Zyura features (flashcards, MCQ bank, study plan, notes, uploads, dashboard).',
        '- writing_assist: drafting professional messages/emails/letters related to healthcare or the Zyura platform (templates only; not medical advice).',
        "Out-of-scope category:",
        "- other: general trivia, holidays, celebrities, politics, unrelated tech, etc.",
        "",
        'Return ONLY valid JSON exactly matching: {"category":"medical_exam|platform_help|writing_assist|other","inDomain":true|false,"intent":"medical|platform|writing|other","reasonShort":"..."}',
        "",
        "Examples:",
        'Q: "When is Diwali?" -> {"category":"other","inDomain":false,"reasonShort":"holiday_trivia"}',
        'Q: "Explain SSEPs vs MEPs vs EMG" -> {"category":"medical_exam","inDomain":true,"intent":"medical","reasonShort":"clinical_concept"}',
        'Q: "Explain sensitivity vs specificity with an example" -> {"category":"medical_exam","inDomain":true,"intent":"medical","reasonShort":"exam_concept"}',
        'Q: "How do I generate flashcards on Zyura?" -> {"category":"platform_help","inDomain":true,"intent":"platform","reasonShort":"zyura_feature"}',
        'Q: "Write an email to the neurology department asking for an appointment" -> {"category":"writing_assist","inDomain":true,"intent":"writing","reasonShort":"email_template"}',
      ].join("\n"),
      user: JSON.stringify({ question }),
      temperature: 0,
    });

    const category = parseTutorCategory(result?.category) ?? "other";
    const intent: TutorIntent =
      result?.intent === "medical" || result?.intent === "platform" || result?.intent === "writing" || result?.intent === "other"
        ? result.intent
        : category === "medical_exam"
          ? "medical"
          : category === "platform_help"
            ? "platform"
            : category === "writing_assist"
              ? "writing"
              : "other";
    const inDomain = Boolean(result?.inDomain) && category !== "other";
    const reasonShort = typeof result?.reasonShort === "string" ? result.reasonShort.slice(0, 80) : undefined;
    return { category, inDomain, intent, reasonShort };
  } catch {
    // Fail-safe: do not answer off-topic if classifier fails.
    return { category: "other", inDomain: false, intent: "other", reasonShort: "classifier_failed" };
  }
};

const normalizeFlashcards = (raw: any) => {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.flashCards) ? raw.flashCards : [];
  return arr
    .filter((c: any) => c && typeof c === "object")
    .map((c: any, idx: number) => ({
      flashCardId: String(c.flashCardId || `FC-${idx + 1}`),
      frontText: String(c.frontText || c.front || "").trim(),
      backText: String(c.backText || c.back || "").trim(),
      explanation: String(c.explanation || " ").trim() || " ",
      difficulty: (["Basic", "Intermediate", "Advance"].includes(String(c.difficulty)) ? String(c.difficulty) : "Basic"),
      image: c.image ? String(c.image) : undefined,
    }))
    .filter((c: any) => c.flashCardId && c.frontText && c.backText && c.explanation);
};

const chat_with_ai_tutor_from_ai = async (req: Request) => {
  const question = req?.body?.question;
  const accountId = String(req?.user?.accountId || "");
  const existingThreadId = (req?.body?.thread_id as string | undefined) || undefined;
  const threadId = existingThreadId || new (require("mongodb").ObjectId)().toString();

  const thread = (await ai_tutor_thread_model.findOne({ thread_id: threadId }).lean()) ??
    (await ai_tutor_thread_model
      .create({
        accountId,
        thread_id: threadId,
        session_title: String(question || "New chat").trim().split(/\s+/).slice(0, 6).join(" "),
        messages: [],
      })
      .then((d) => d.toObject()));

  const history = Array.isArray(thread?.messages) ? thread.messages.slice(-20) : [];

  const qText = String(question || "");
  const classification = await classifyTutorQuestion(qText);
  if (!classification.inDomain) {
    const responseText = outOfScopeReply;

    await ai_tutor_thread_model.updateOne(
      { thread_id: threadId },
      {
        $push: {
          messages: {
            $each: [
              { type: "HumanMessage", content: qText, createdAt: new Date() },
              { type: "AIMessage", content: responseText, createdAt: new Date() },
            ],
          },
        },
      },
      { upsert: true },
    );

    await daily_ai_request_model.updateOne(
      { date: today },
      { $inc: { count: 1 } },
      { upsert: true },
    );

    return { thread_id: threadId, response: responseText };
  }

  const isWritingAssist = classification.category === "writing_assist";
  const systemPrompt = isWritingAssist
    ? [
        "You are Zyura Writing Assistant.",
        "Task: draft short professional templates (emails/messages/letters) related to healthcare or the Zyura platform.",
        "",
        "Rules:",
        "- Do NOT give medical advice, diagnosis, treatment, or interpret clinical results.",
        "- Keep the output concise and practical.",
        "- Use neutral placeholders like [Your Name], [DOB], [Date], [Phone].",
        "- If critical info is missing, make safe assumptions and use placeholders (do not ask back-and-forth questions).",
        "- Output plain text only (no markdown).",
      ].join("\n")
    : [
        "You are Zyura AI Tutor.",
        "Scope: medical/clinical questions, medical exam prep (OSCE/MCQs/study strategy), and Zyura platform help.",
        "If the user asks anything outside this scope, do NOT answer it; politely redirect them back to medical questions or Zyura usage questions.",
        "Be concise, clinically accurate, and explain reasoning step-by-step when needed.",
      ].join("\n");

  const messagesForOpenAI = [
    { role: "system" as const, content: systemPrompt },
    ...history.map((m) => ({
      role: m.type === "HumanMessage" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    })),
    { role: "user" as const, content: qText },
  ];

  const responseText = await openaiChatText({ messages: messagesForOpenAI, temperature: isWritingAssist ? 0.2 : 0.3 });

  await ai_tutor_thread_model.updateOne(
    { thread_id: threadId },
    {
      $push: {
        messages: {
          $each: [
            { type: "HumanMessage", content: String(question || ""), createdAt: new Date() },
            { type: "AIMessage", content: responseText, createdAt: new Date() },
          ],
        },
      },
    },
    { upsert: true },
  );

  await daily_ai_request_model.updateOne(
    { date: today },
    { $inc: { count: 1 } },
    { upsert: true },
  );
  return { thread_id: threadId, response: responseText };
};

const get_all_chat_history_from_ai = async (req: Request) => {
  const thread_id = String(req?.query?.thread_id || "");
  const thread = await ai_tutor_thread_model.findOne({ thread_id }).lean();
  const data = thread
    ? [
      {
        checkpoint_id: null,
        created_at: thread.createdAt?.toISOString?.() || new Date().toISOString(),
        messages: thread.messages || [],
      },
    ]
    : [];
  await daily_ai_request_model.updateOne(
    { date: today },
    { $inc: { count: 1 } },
    { upsert: true },
  );
  return data;
};

const get_all_chat_thread_title_from_ai = async (req: Request) => {
  const accountId = String(req?.user?.accountId || "");
  const threads = await ai_tutor_thread_model
    .find({ accountId })
    .select("thread_id session_title")
    .sort({ updatedAt: -1 })
    .lean();
  const data = { threads: threads.map((t) => ({ thread_id: t.thread_id, session_title: t.session_title })) };
  await daily_ai_request_model.updateOne(
    { date: today },
    { $inc: { count: 1 } },
    { upsert: true },
  );
  return data;
};

/**
 * Smart study plan: AI returns topics per day only. Backend computes each task's
 * `limit` and `duration_*` deterministically; `contentId` is resolved from DB
 * (McqBank, Flashcard, ClinicalCase, Notes) per topic tuple.
 */
const TASK_RATES_SECONDS = {
  mcq: 40,
  flashcard: 180,
  clinical_case: 300,
  note: 900,
} as const;

type DeterministicTaskKey = keyof typeof TASK_RATES_SECONDS;

const DAILY_MIX: readonly DeterministicTaskKey[] = [
  "mcq",
  "flashcard",
  "clinical_case",
  "note",
];

const formatTopicLabel = (t: any): string => {
  if (!t || typeof t !== "object") return "General";
  const parts = [t.subject, t.system, t.topic, t.subtopic]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" · ") : "General";
};

const taskTypeStringForKey = (key: DeterministicTaskKey): string => {
  if (key === "clinical_case") return "clinical case";
  if (key === "note") return "note";
  return key;
};

const descriptionForKey = (
  key: DeterministicTaskKey,
  topicLabel: string,
): string => {
  const title =
    key === "mcq"
      ? "MCQ"
      : key === "flashcard"
        ? "Flashcards"
        : key === "clinical_case"
          ? "Clinical case"
          : "Notes";
  return `${title} — ${topicLabel}`;
};

type TaskIdAndCap = { id: string; cap: number };

const emptyPerTask = (): Record<DeterministicTaskKey, TaskIdAndCap> => ({
  mcq: { id: "", cap: 0 },
  flashcard: { id: "", cap: 0 },
  clinical_case: { id: "", cap: 0 },
  note: { id: "", cap: 0 },
});

/**
 * Equal time slice per task type, count = floor(slice/rate) capped by bank capacity.
 * Leftover seconds spill to other types (cheapest rate first) until caps or leftover < min rate.
 */
const buildDeterministicHourlyBreakdown = (
  perTask: Record<DeterministicTaskKey, TaskIdAndCap>,
  dailyStudyHours: number,
  topicLabel: string,
): { hourly_breakdown: any[]; total_hours: number } => {
  const safeHours =
    Number.isFinite(dailyStudyHours) && dailyStudyHours > 0 ? dailyStudyHours : 4;
  const dailySec = safeHours * 3600;
  const sliceSec = dailySec / DAILY_MIX.length;

  const counts: Record<DeterministicTaskKey, number> = {
    mcq: 0,
    flashcard: 0,
    clinical_case: 0,
    note: 0,
  };

  for (const key of DAILY_MIX) {
    const rate = TASK_RATES_SECONDS[key];
    const cap = perTask[key]?.cap ?? 0;
    const raw = Math.floor(sliceSec / rate);
    counts[key] = Math.min(Math.max(0, raw), cap);
  }

  let used = DAILY_MIX.reduce(
    (s, k) => s + counts[k] * TASK_RATES_SECONDS[k],
    0,
  );
  let leftover = Math.max(0, dailySec - used);

  const orderByRate = [...DAILY_MIX].sort(
    (a, b) => TASK_RATES_SECONDS[a] - TASK_RATES_SECONDS[b],
  );

  let guard = 0;
  const MAX_SPILL = 500000;
  while (leftover > 0 && guard < MAX_SPILL) {
    guard += 1;
    let progressed = false;
    for (const k of orderByRate) {
      const rate = TASK_RATES_SECONDS[k];
      const cap = perTask[k]?.cap ?? 0;
      if (counts[k] >= cap) continue;
      if (leftover < rate) continue;
      counts[k] += 1;
      leftover -= rate;
      progressed = true;
    }
    if (!progressed) break;
  }

  const hourly_breakdown: any[] = [];
  let totalSecondsAll = 0;

  for (const key of DAILY_MIX) {
    const rate = TASK_RATES_SECONDS[key];
    const limit = counts[key];
    const totalSeconds = limit * rate;
    totalSecondsAll += totalSeconds;

    const duration_hours = Math.floor(totalSeconds / 3600);
    const duration_minutes = Math.round((totalSeconds % 3600) / 60);

    const contentId = perTask[key]?.id ?? "";

    hourly_breakdown.push({
      task_type: taskTypeStringForKey(key),
      description: descriptionForKey(key, topicLabel),
      duration_hours,
      duration_minutes,
      suggest_content: {
        contentId,
        limit,
      },
      isCompleted: false,
    });
  }

  const total_hours = Math.round((totalSecondsAll / 3600) * 100) / 100;
  return { hourly_breakdown, total_hours };
};

// ai_part.service.ts — replace generate_new_study_plan_from_ai

/**
 * Runs AI + deterministic assembly for a study plan (steps 1–5).
 * Does not persist. Used by create and by study_planner update/regenerate.
 */
const build_study_plan_payload_from_ai_request = async (req: Request) => {
  const isAccount = await isAccountExist(req?.user?.email as string, "profile_id") as any;
  const payload = req?.body;

  let profileContext: Record<string, any> = {};

  if (req?.user?.role === "STUDENT") {
    payload.contentFor = "student";
    payload.profileType = isAccount?.profile_id?.profileType;
    const pref = isAccount?.profile_id?.preference;
    profileContext = {
      studentType: isAccount?.profile_id?.studentType,
      university: isAccount?.profile_id?.university,
      yearOfStudy: isAccount?.profile_id?.year_of_study,
      preparingFor: isAccount?.profile_id?.preparingFor,
      preferredSubjects: pref?.subject ?? [],
      preferredTopics: pref?.topic ?? [],
      preferredSubTopics: pref?.subTopic ?? [],
      systemPreference: pref?.systemPreference ?? [],
    };
  }

  if (req?.user?.role === "PROFESSIONAL") {
    payload.contentFor = "professional";
    payload.profileType = isAccount?.profile_id?.professionName;
    profileContext = {
      professionName: isAccount?.profile_id?.professionName,
      institution: isAccount?.profile_id?.institution,
      experience: isAccount?.profile_id?.experience,
    };
  }

  const startDate = payload.start_date || new Date().toISOString().split("T")[0];
  const enrichedInput = { ...payload, start_date: startDate, userProfile: profileContext };

  // ─── STEP 1: Generate plan metadata + topic list only (fast, small response) ──
  const metaPrompt = `
You are a medical study plan generator for the Zyura platform.

Generate ONLY the plan metadata and topics list as valid JSON. Do NOT include daily_plan.

Schema:
{
  "exam_name": "<string>",
  "exam_date": "<YYYY-MM-DD>",
  "exam_type": "<string>",
  "daily_study_time": <number>,
  "plan_summary": "<1-sentence summary>",
  "total_days": <number — exact days from start_date to exam_date inclusive>,
  "topics": [
    { "subject": "<string>", "system": "<string>", "topic": "<string>", "subtopic": "<string>" }
  ]
}

Rules:
- topics list must have enough entries to cover all days (aim for 1 topic per day or group).
- Return ONLY valid JSON. No markdown, no explanation.
`.trim();

  const metaData = await openaiChatJson<any>({
    system: metaPrompt,
    user: JSON.stringify(enrichedInput),
    temperature: 0.2,
  });

  const totalDays: number = metaData.total_days || 30;
  const topics: any[] = Array.isArray(metaData.topics) ? metaData.topics : [];

  // ─── STEP 2: Fetch content IDs + split days into chunks — run in parallel ──
  const CHUNK_SIZE = 20; // Each AI call handles 20 days max
  const chunks: Array<{ fromDay: number; toDay: number; fromDate: string; toDate: string; topics: any[] }> = [];

  const start = new Date(startDate);
  for (let i = 0; i < totalDays; i += CHUNK_SIZE) {
    const fromDay = i + 1;
    const toDay = Math.min(i + CHUNK_SIZE, totalDays);

    const fromDate = new Date(start);
    fromDate.setDate(start.getDate() + i);

    const toDate = new Date(start);
    toDate.setDate(start.getDate() + toDay - 1);

    // Distribute topics evenly across chunks
    const topicsPerChunk = Math.ceil(topics.length / Math.ceil(totalDays / CHUNK_SIZE));
    const chunkIndex = Math.floor(i / CHUNK_SIZE);
    const chunkTopics = topics.slice(chunkIndex * topicsPerChunk, (chunkIndex + 1) * topicsPerChunk);

    chunks.push({
      fromDay,
      toDay,
      fromDate: fromDate.toISOString().split("T")[0],
      toDate: toDate.toISOString().split("T")[0],
      topics: chunkTopics.length ? chunkTopics : topics,
    });
  }

  const contentForFilter = payload.contentFor || "student";
  const profileTypeFilter = payload.profileType;

  const topicKey = (t: any) =>
    [
      String(t?.subject ?? ""),
      String(t?.system ?? ""),
      String(t?.topic ?? ""),
      String(t?.subtopic ?? ""),
    ].join("__");

  // Unique topic tuples from metadata (used to resolve contentIds per topic)
  const uniqueTopics = Array.from(
    new Map(
      topics
        .filter((t) => t && typeof t === "object")
        .map((t) => [topicKey(t), t]),
    ).values(),
  );

  const cleanStr = (v: unknown) => String(v ?? "").trim();

  const buildBaseFilterForTopic = (t: any): Record<string, any> => {
    const f: Record<string, any> = {};
    if (contentForFilter) f.contentFor = contentForFilter;
    if (profileTypeFilter) f.profileType = profileTypeFilter;
    if (t?.subject) f.subject = cleanStr(t.subject);
    if (t?.system) f.system = cleanStr(t.system);
    if (t?.topic) f.topic = cleanStr(t.topic);
    if (t?.subtopic) f.subtopic = cleanStr(t.subtopic);
    return f;
  };

  /**
   * When the exact topic tuple doesn't exist in content collections, we still want
   * to link something usable rather than leaving tasks unstartable.
   *
   * We keep `contentFor` stable, but progressively relax:
   * - drop profileType
   * - drop subtopic
   * - drop topic
   * - drop system
   *
   * This is intentionally conservative: we never drop `subject` or `contentFor`.
   */
  const buildCandidateFilters = (t: any): Record<string, any>[] => {
    const base = buildBaseFilterForTopic(t);
    const candidates: Record<string, any>[] = [];

    const push = (f: Record<string, any>) => {
      // Deduplicate by stable JSON key (field order stable here).
      const key = JSON.stringify(f);
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(f);
      }
    };

    const seen = new Set<string>();

    // Exact
    push({ ...base });
    // Without profileType
    if ("profileType" in base) {
      const { profileType: _pt, ...noPt } = base;
      push(noPt);
    }
    // Without subtopic (and without profileType)
    if ("subtopic" in base) {
      const { subtopic: _st, ...noSubtopic } = base;
      push(noSubtopic);
      if ("profileType" in noSubtopic) {
        const { profileType: _pt2, ...noSubtopicNoPt } = noSubtopic;
        push(noSubtopicNoPt);
      }
    }
    // Without topic (and without profileType)
    if ("topic" in base) {
      const { topic: _t, ...noTopic } = base;
      delete (noTopic as any).subtopic;
      push(noTopic);
      if ("profileType" in noTopic) {
        const { profileType: _pt3, ...noTopicNoPt } = noTopic;
        push(noTopicNoPt);
      }
    }
    // Without system (and without profileType)
    if ("system" in base) {
      const { system: _s, ...noSystem } = base;
      delete (noSystem as any).topic;
      delete (noSystem as any).subtopic;
      push(noSystem);
      if ("profileType" in noSystem) {
        const { profileType: _pt4, ...noSystemNoPt } = noSystem;
        push(noSystemNoPt);
      }
    }

    return candidates;
  };

  const resolveFirst = async <T>(
    findOne: (f: Record<string, any>) => Promise<T | null>,
    filters: Record<string, any>[],
  ): Promise<T | null> => {
    for (const f of filters) {
      // eslint-disable-next-line no-await-in-loop
      const doc = await findOne(f).catch(() => null);
      if (doc) return doc;
    }
    return null;
  };

  const dailyPlanChunkPrompt = (chunk: typeof chunks[0]) => `
You are a medical study plan generator for the Zyura platform.

Generate ONLY the daily_plan entries for days ${chunk.fromDay} to ${chunk.toDay} (dates ${chunk.fromDate} to ${chunk.toDate}).

Return a JSON array (not wrapped in an object). Each element MUST have ONLY:
- "day_number": <number>,
- "date": "<YYYY-MM-DD>",
- "topics": ["<short topic focus strings for that day>"]

Do NOT include hourly_breakdown, durations, or suggest_content limits — the server builds exactly four tasks per day (MCQ, flashcards, clinical case, notes) with computed time and item counts.

Topics to cover in this chunk: ${JSON.stringify(chunk.topics)}
Daily study time context (hours/day): ${enrichedInput.daily_study_time || 4}
Return ONLY the JSON array. No markdown.
`.trim();

  // ─── STEP 3: Run all chunk AI calls + DB queries in parallel ──────────────
  const [chunkResults, topicContentIndex] = await Promise.all([
    // All daily_plan chunks generated simultaneously
    Promise.all(
      chunks.map((chunk) =>
        openaiChatJson<any[]>({
          system: dailyPlanChunkPrompt(chunk),
          user: JSON.stringify({ exam: metaData.exam_name, topics: chunk.topics }),
          temperature: 0.2,
        }).catch(() => [] as any[])
      )
    ),
    // Resolve content IDs per unique topic tuple (multi-topic correctness)
    Promise.all(
      uniqueTopics.map(async (t: any) => {
        const candidates = buildCandidateFilters(t);

        const [mcqBank, flashcard, note, clinicalCase] = await Promise.all([
          resolveFirst(
            (f) =>
              McqBankModel.findOne(f)
                .select("_id mcqs")
                .sort({ createdAt: -1 })
                .lean(),
            candidates,
          ),
          resolveFirst(
            (f) =>
              FlashcardModel.findOne(f)
                .select("_id flashCards")
                .sort({ createdAt: -1 })
                .lean(),
            candidates,
          ),
          resolveFirst(
            (f) => notes_model.findOne(f).select("_id").sort({ createdAt: -1 }).lean(),
            candidates,
          ),
          resolveFirst(
            (f) =>
              ClinicalCaseModel.findOne(f).select("_id").sort({ createdAt: -1 }).lean(),
            candidates,
          ),
        ]);

        const mb = mcqBank as { _id?: unknown; mcqs?: unknown[] } | null;
        const fc = flashcard as { _id?: unknown; flashCards?: unknown[] } | null;

        return {
          key: topicKey(t),
          perTask: {
            mcq: {
              id: mb?._id?.toString() ?? "",
              cap: Array.isArray(mb?.mcqs) ? mb.mcqs.length : 0,
            },
            flashcard: {
              id: fc?._id?.toString() ?? "",
              cap: Array.isArray(fc?.flashCards) ? fc.flashCards.length : 0,
            },
            note: {
              id: note?._id?.toString() ?? "",
              cap: note ? 1 : 0,
            },
            clinical_case: {
              id: clinicalCase?._id?.toString() ?? "",
              cap: clinicalCase ? 1 : 0,
            },
          } satisfies Record<DeterministicTaskKey, TaskIdAndCap>,
        };
      }),
    ),
  ]);

  // ─── STEP 4: Merge chunks + fix dates ─────────────────────────────────────
  const contentIndex = new Map<string, Record<DeterministicTaskKey, TaskIdAndCap>>();
  for (const row of topicContentIndex || []) {
    if (row?.key) contentIndex.set(String(row.key), row.perTask ?? emptyPerTask());
  }

  const rawDailyPlanFlat: any[] = chunkResults.flat();
  const dailyStudyHoursNum =
    Number(enrichedInput.daily_study_time ?? metaData.daily_study_time ?? 4) || 4;

  const daily_plan = Array.from({ length: totalDays }, (_, index) => {
    const dayDate = new Date(start);
    dayDate.setDate(start.getDate() + index);

    const dayFromAi = rawDailyPlanFlat[index] || {};
    const topicForDay = topics.length
      ? topics[index % topics.length]
      : null;
    const perTask = topicForDay
      ? (contentIndex.get(topicKey(topicForDay)) ?? emptyPerTask())
      : emptyPerTask();

    const topicLabel = formatTopicLabel(topicForDay);
    const { hourly_breakdown, total_hours } = buildDeterministicHourlyBreakdown(
      perTask,
      dailyStudyHoursNum,
      topicLabel,
    );

    const topicsStrings: string[] =
      Array.isArray(dayFromAi.topics) && dayFromAi.topics.length
        ? dayFromAi.topics.map((x: any) => String(x))
        : topicForDay
          ? [formatTopicLabel(topicForDay)]
          : [];

    return {
      ...dayFromAi,
      day_number: index + 1,
      date: dayDate.toISOString().split("T")[0],
      total_hours,
      topics: topicsStrings,
      hourly_breakdown,
      isCompleted: false,
    };
  });

  // ─── STEP 5: Assemble final plan + validate ────────────────────────────────
  const finalPlan = {
    exam_name: metaData.exam_name,
    exam_date: metaData.exam_date,
    exam_type: metaData.exam_type,
    daily_study_time: metaData.daily_study_time,
    topics: metaData.topics,
    plan_summary: metaData.plan_summary,
    total_days: totalDays,
    daily_plan,
  };

  let parseData: any;
  try {
    parseData = await study_planner_validations.create.parseAsync(finalPlan);
  } catch {
    // If validation fails, use the raw assembled plan rather than re-calling AI
    parseData = finalPlan;
  }

  return { parseData, startDate, payload };
};

const generate_new_study_plan_from_ai = async (req: Request) => {
  const { parseData, startDate, payload } = await build_study_plan_payload_from_ai_request(req);

  // ─── STEP 6: Persist + analytics in parallel ──────────────────────────────
  const created_from =
    payload?.created_from === "smart_study_planner"
      ? "smart_study_planner"
      : "smart_study";

  const persistPlanPromise: Promise<unknown> =
    created_from === "smart_study_planner"
      ? (async () => {
          const threadId = new Types.ObjectId().toString();
          const planTitle = String(
            payload?.title ??
              payload?.exam_name ??
              parseData?.exam_name ??
              "Smart Study Plan",
          )
            .trim()
            .slice(0, 120);
          const sessionTitle = (planTitle.slice(0, 80) || "Study plan").trim();

          await ai_tutor_thread_model.create({
            accountId: String(req?.user?.accountId ?? ""),
            thread_id: threadId,
            session_title: sessionTitle,
            messages: [],
          });

          const doc = await study_planner_model.create({
            ...parseData,
            accountId: req?.user?.accountId,
            created_from: "smart_study_planner",
            status: "in_progress",
            title: planTitle,
            thread_id: threadId,
            selection_snapshot: payload?.selection_snapshot,
            exam_name: parseData.exam_name ?? payload?.exam_name,
            exam_date: parseData.exam_date ?? payload?.exam_date,
            exam_type: parseData.exam_type ?? payload?.exam_type ?? "",
            start_date: startDate,
            daily_study_time:
              parseData.daily_study_time ??
              Number(payload?.daily_study_time ?? 0),
            topics: parseData.topics ?? payload?.topics,
          });
          return doc.toObject();
        })()
      : study_planner_model
          .create({
            ...parseData,
            accountId: req?.user?.accountId,
            created_from: "smart_study",
            status: "in_progress",
          })
          .then((d) => d.toObject());

  const [result] = await Promise.all([
    persistPlanPromise,
    daily_ai_request_model.updateOne(
      { date: today },
      { $inc: { count: 1 } },
      { upsert: true }
    ),
  ]);

  return result;
};


const generate_flashcard_from_ai = async (req: Request) => {
  const payload = req.body;
  const fileText =
    req.file && fs.existsSync(req.file.path)
      ? fs.readFileSync(req.file.path).toString("utf8").slice(0, 20000)
      : "";

  const data = await openaiChatJson<any>({
    system:
      "Generate flashcards.\nReturn JSON: {\"flashCards\":[{flashCardId,frontText,backText,explanation,difficulty}]}.\n- difficulty must be one of: Basic, Intermediate, Advance.\nReturn ONLY JSON.",
    user: JSON.stringify({ ...payload, fileText: fileText || undefined }),
    temperature: 0.3,
  });
  const flashCards = normalizeFlashcards(data);
  // saving payload
  const finalPayload: Partial<T_MyContent_flashcard> = {
    title: payload?.quiz_name,
    subject: payload?.subject,
    system: payload?.system,
    topic: payload?.topic,
    subtopic: payload?.sub_topic,
    flashCards,
    studentId: req?.user?.accountId,
  };

  const result = await my_content_flashcard_model.create(finalPayload);
  await daily_ai_request_model.updateOne(
    { date: today },
    { $inc: { count: 1 } },
    { upsert: true },
  );
  return result;
};

const generate_mcq_from_ai = async (req: Request) => {
  const body = req?.body;
  const payload: any = {
    quiz_name: body?.quiz_name,
    subject: body?.subject,
    system: body?.system,
    topic: body?.topic,
    sub_topic: body?.sub_topic,
    question_type: body?.question_type,
    question_count: body?.question_count,
    difficulty_level: body?.difficulty_level,
  };
  // find mcq bank;
  payload.question_count = Number(payload?.question_count);

  if (payload?.question_type == "hybrid") {
    const mcqBank = await McqBankModel.findById(body?.mcq_bank_id).lean();

    if (!mcqBank) {
      throw new AppError("MCQ Bank not found", 404);
    }

    const limit = Math.round(payload.question_count / 2);

    // return N questions from bank
    const selectedQuestions = mcqBank.mcqs.slice(0, limit);

    payload.mcq_list = JSON.stringify(selectedQuestions);
  }
  const data = await openaiChatJson<any>({
    system:
      [
        "Generate MCQs.",
        "Return ONLY valid JSON: {\"mcqs\":[{mcqId,difficulty,question,options:[{option,optionText,explanation}],correctOption}]}",
        "- difficulty: Basic|Intermediate|Advance",
        "- correctOption: A|B|C|D|E|F",
        "- For EACH option provide 3–5 sentences: (1) why this option is correct/incorrect, (2) mechanism/pathophysiology/pharmacology rationale, (3) one clinical pearl or differentiator vs other options.",
        "- For the CORRECT option, end with a one-line key takeaway.",
        "- Do not be repetitive across options. Use exam-grade clinical wording. Avoid filler.",
      ].join("\n"),
    user: JSON.stringify(payload),
    temperature: 0.3,
  });
  let { mcqs, dropped } = normalizeMcqsWithStats(data);
  const total = Array.isArray(data?.mcqs) ? data.mcqs.length : Array.isArray(data) ? data.length : 0;
  const droppedRatio = total > 0 ? dropped / total : 1;

  // One-shot repair pass if AI returns malformed labels (common: "a", "(B)", "Option C", numeric index).
  if (mcqs.length === 0 || droppedRatio >= 0.25) {
    const repair = await openaiChatJson<any>({
      system: [
        "You previously generated MCQs but the output was invalid or inconsistent.",
        "Fix and return ONLY valid JSON with the exact shape:",
        "{\"mcqs\":[{\"mcqId\":\"...\",\"difficulty\":\"Basic|Intermediate|Advance\",\"question\":\"...\",\"options\":[{\"option\":\"A|B|C|D|E|F\",\"optionText\":\"...\",\"explanation\":\"...\"}],\"correctOption\":\"A|B|C|D|E|F\"}]}",
        "",
        "Hard rules:",
        "- Every options[i].option MUST be a single uppercase letter A-F.",
        "- correctOption MUST match one of the provided options[].option for that MCQ.",
        "- Use 4 options (A-D) unless more are genuinely needed.",
        "- Return ONLY JSON. No markdown. No extra keys.",
      ].join("\n"),
      user: JSON.stringify({
        input: payload,
        previousResponse: data,
      }),
      temperature: 0,
    });
    ({ mcqs, dropped } = normalizeMcqsWithStats(repair));
  }

  // Randomize option ordering + correctOption label (prevents always-"A" answers).
  mcqs = shuffleAndRelabelMcqs(mcqs as any) as any;

  // Guarantee at least the correct option has an explanation (fallback fill).
  try {
    const missing = mcqs
      .map((m: any, idx: number) => {
        const correct = String(m?.correctOption ?? "").trim();
        const opts = Array.isArray(m?.options) ? m.options : [];
        const correctOpt = opts.find((o: any) => String(o?.option ?? "").trim() === correct);
        const explanation = String(correctOpt?.explanation ?? "").trim();
        return explanation
          ? null
          : {
              key: String(m?.mcqId ?? "").trim() || `idx:${idx}`,
              question: String(m?.question ?? ""),
              correctOption: correct,
              optionText: String(correctOpt?.optionText ?? ""),
            };
      })
      .filter(Boolean);

    if (missing.length) {
      const fill = await openaiChatJson<any>({
        system: [
          "Fill in missing explanations for the correct option only.",
          "Return ONLY JSON: {\"items\":[{\"key\":\"...\",\"correctExplanation\":\"...\"}]}",
          "Rules: 3-5 sentences, clinically accurate: rationale, mechanism/pearl, then a one-line key takeaway at the end. No extra keys.",
        ].join("\n"),
        user: JSON.stringify({ items: missing }),
        temperature: 0,
      });

      const map = new Map<string, string>();
      if (Array.isArray(fill?.items)) {
        for (const it of fill.items) {
          const k = String(it?.key ?? "").trim();
          const expl = String(it?.correctExplanation ?? "").trim();
          if (k && expl) map.set(k, expl);
        }
      }

      for (let idx = 0; idx < mcqs.length; idx++) {
        const m: any = mcqs[idx];
        const key = String(m?.mcqId ?? "").trim() || `idx:${idx}`;
        const add = map.get(key);
        if (!add) continue;
        const correct = String(m?.correctOption ?? "").trim();
        if (!Array.isArray(m?.options)) continue;
        const correctOpt = m.options.find((o: any) => String(o?.option ?? "").trim() === correct);
        if (correctOpt && !String(correctOpt?.explanation ?? "").trim()) {
          correctOpt.explanation = add;
        }
      }
    }
  } catch {
    // best-effort only
  }
  // save it later
  const finalPayload: Partial<T_MyContent_mcq> = {
    title: payload?.quiz_name || data?.title,
    subject: payload?.subject,
    system: payload?.system,
    topic: payload?.topic,
    subtopic: payload?.sub_topic,
    mcqs,
    studentId: req?.user?.accountId,
    tracking: {
      totalMcqCount: Number(payload?.question_count),
      totalAttemptCount: 0,
      correctMcqCount: 0,
      wrongMcqCount: 0,
      timeTaken: "0",
      progress: 0,
      correctPercentage: 0,
      wrongPercentage: 0,
      unattemptedPercentage: 0,
      recommendedContent: [],
    },
  };
  const result = await my_content_mcq_bank_model.create(finalPayload);
  await daily_ai_request_model.updateOne(
    { date: today },
    { $inc: { count: 1 } },
    { upsert: true },
  );
  return result;
};

const generate_clinical_case_from_ai = async (req: Request) => {
  const payload = req?.body;
  const fileText =
    req.file && fs.existsSync(req.file.path)
      ? fs.readFileSync(req.file.path).toString("utf8").slice(0, 20000)
      : "";

  const data = await openaiChatJson<any>({
    system:
      "Generate a clinical case.\nReturn JSON: {\"clinical_case\":{caseTitle,patientPresentation,historyOfPresentIllness,physicalExamination,laboratoryResults:[{name,value}],imaging,diagnosisQuestion:{question,diagnosisOptions:[{optionName:\"A\"|\"B\"|\"C\"|\"D\",optionValue,supportingEvidence:[],refutingEvidence:[]}]},correctOption:{optionName:\"A\"|\"B\"|\"C\"|\"D\",explanation},difficultyLevel:\"Basic\"|\"Intermediate\"|\"Advance\",mcqs:[{question,options:[{option,optionText,explanation?}],correctOption}],subject,system,topic,subtopic}}\nReturn ONLY JSON.",
    user: JSON.stringify({ ...payload, fileText: fileText || undefined }),
    temperature: 0.3,
  });
  // save it later
  if (data?.clinical_case?.mcqs && Array.isArray(data.clinical_case.mcqs)) {
    try {
      data.clinical_case.mcqs = shuffleAndRelabelMcqs(data.clinical_case.mcqs as any) as any;
    } catch {
      // best-effort only
    }
  }
  const finalPayload: Partial<T_MyContent_mcq> = {
    ...data?.clinical_case,
    studentId: req?.user?.accountId,
  };
  const result = await my_content_clinicalCase_model.create(finalPayload);
  await daily_ai_request_model.updateOne(
    { date: today },
    { $inc: { count: 1 } },
    { upsert: true },
  );
  return result;
};

const get_all_content_title_suggestion_from_db = async (req: Request) => {
  const key = req?.query?.key || "mcq" as any;

  const modelMap: any = {
    mcq: {
      model: McqBankModel,
      arrayField: "mcqs",
    },
    flashcard: {
      model: FlashcardModel,
      arrayField: "flashCards",
    },
    clinicalcase: {
      model: ClinicalCaseModel,
      titleField: "caseTitle",
    },
    osce: {
      model: osce_model,
      titleField: "name",
    },
    notes: {
      model: notes_model,
      titleField: "title",
    },
  };

  if (!modelMap[key]) {
    return {
      success: false,
      message: "Invalid key",
    };
  }

  const config = modelMap[key];

  let result;

  // ✅ MCQ & Flashcard → array length only
  if (config.arrayField) {
    result = await config.model.aggregate([
      {
        $project: {
          title: 1,
          subject: 1,
          system: 1,
          topic: 1,
          subtopic: 1,
          totalItems: { $size: `$${config.arrayField}` },
          contentFor: 1,
          profileType: 1,
        },
      },
    ]);
  }
  // ✅ Others → normal title mapping
  else {
    result = await config.model
      .find({})
      .select(`${config.titleField} subject system topic subtopic contentFor profileType`)
      .lean()
      .then((data: any[]) =>
        data.map((item) => ({
          ...item,
          title: item[config.titleField],
        })),
      );
  }

  await daily_ai_request_model.updateOne(
    { date: today },
    { $inc: { count: 1 } },
    { upsert: true },
  );

  return result;
};

const mcq_generator_from_ai = async (req: Request) => {
  const payload = req?.body;
  const fileText =
    req.file && fs.existsSync(req.file.path)
      ? fs.readFileSync(req.file.path).toString("utf8").slice(0, 20000)
      : "";

  const data = await openaiChatJson<any>({
    system:
      [
        "Generate MCQs from the prompt/fileText.",
        "Return ONLY valid JSON: {\"mcqs\":[{mcqId,difficulty,question,options:[{option,optionText,explanation}],correctOption}]}",
        "- options must be labeled A-D (or A-F if needed).",
        "- difficulty: Basic|Intermediate|Advance",
        "- correctOption: A|B|C|D|E|F",
        "- For EACH option provide 3–5 sentences: (1) why this option is correct/incorrect, (2) mechanism/pathophysiology/pharmacology rationale, (3) one clinical pearl or differentiator vs other options.",
        "- For the CORRECT option, end with a one-line key takeaway.",
        "- Do not be repetitive across options. Use exam-grade clinical wording. Avoid filler.",
      ].join("\n"),
    user: JSON.stringify({ ...payload, fileText: fileText || undefined }),
    temperature: 0.3,
  });
  let { mcqs, dropped } = normalizeMcqsWithStats(data);
  const total = Array.isArray(data?.mcqs) ? data.mcqs.length : Array.isArray(data) ? data.length : 0;
  const droppedRatio = total > 0 ? dropped / total : 1;

  if (mcqs.length === 0 || droppedRatio >= 0.25) {
    const repair = await openaiChatJson<any>({
      system: [
        "You previously generated MCQs but the output was invalid or inconsistent.",
        "Fix and return ONLY valid JSON with the exact shape:",
        "{\"mcqs\":[{\"mcqId\":\"...\",\"difficulty\":\"Basic|Intermediate|Advance\",\"question\":\"...\",\"options\":[{\"option\":\"A|B|C|D|E|F\",\"optionText\":\"...\",\"explanation\":\"...\"}],\"correctOption\":\"A|B|C|D|E|F\"}]}",
        "",
        "Hard rules:",
        "- Every options[i].option MUST be a single uppercase letter A-F.",
        "- correctOption MUST match one of the provided options[].option for that MCQ.",
        "- Use 4 options (A-D) unless more are genuinely needed.",
        "- Return ONLY JSON. No markdown. No extra keys.",
      ].join("\n"),
      user: JSON.stringify({
        input: { ...payload, fileText: fileText || undefined },
        previousResponse: data,
      }),
      temperature: 0,
    });
    ({ mcqs, dropped } = normalizeMcqsWithStats(repair));
  }

  // Randomize option ordering + correctOption label (prevents always-"A" answers).
  mcqs = shuffleAndRelabelMcqs(mcqs as any) as any;

  const finalPayload: Partial<T_MyContent_mcq> = {
    title: payload?.quiz_name || data?.title,
    subject: payload?.subject,
    system: payload?.system,
    topic: payload?.topic,
    subtopic: payload?.sub_topic,
    mcqs,
    studentId: req?.user?.accountId,
    tracking: {
      totalMcqCount: Number(payload?.q_count),
      totalAttemptCount: 0,
      correctMcqCount: 0,
      wrongMcqCount: 0,
      timeTaken: "0",
      progress: 0,
      correctPercentage: 0,
      wrongPercentage: 0,
      unattemptedPercentage: 0,
      recommendedContent: [],
    },
  };
  const result = await my_content_mcq_bank_model.create(finalPayload);
  await daily_ai_request_model.updateOne(
    { date: today },
    { $inc: { count: 1 } },
    { upsert: true },
  );
  return result;
};

const generate_note_from_ai = async (req: Request) => {
  const payload = req?.body;
  const fileText =
    req.file && fs.existsSync(req.file.path)
      ? fs.readFileSync(req.file.path).toString("utf8").slice(0, 20000)
      : "";

  const data = await openaiChatJson<any>({
    system:
      "Generate study notes.\nReturn JSON: {\"note\":\"<string>\"}\nReturn ONLY JSON.",
    user: JSON.stringify({ ...payload, fileText: fileText || undefined }),
    temperature: 0.2,
  });
  const finalPayload: Partial<T_MyContent_notes> = {
    note: String(data?.note || data?.content || data?.text || ""),
    studentId: req?.user?.accountId,
  };
  const result = await my_content_notes_model.create(finalPayload);
  await daily_ai_request_model.updateOne(
    { date: today },
    { $inc: { count: 1 } },
    { upsert: true },
  );
  return result;
};

const generate_recommendation_from_ai = async (req: Request) => {
  const contentId = req?.params?.contentId;
  // find content exist or not
  const isMyMcqExist = await my_content_mcq_bank_model.findById(contentId).lean();
  if (!isMyMcqExist) {
    throw new AppError("Content not found", 404);
  }
  // get user profile
  const payload: any = {};
  const isAccount = await isAccountExist(req?.user?.email as string, "profile_id") as any;
  const body = req?.body;
  const roleMeta =
    req?.user?.role === "STUDENT"
      ? { content_for: "student", profile_type: isAccount?.profile_id?.studentType }
      : req?.user?.role === "PROFESSIONAL"
        ? { content_for: "professional", profile_type: isAccount?.profile_id?.professionName }
        : {};

  // build structure
  payload.original_quiz_metadata = {
    subject: isMyMcqExist?.subject,
    system: isMyMcqExist?.system,
    topic: isMyMcqExist?.topic,
    sub_topic: isMyMcqExist?.subtopic,
    ...roleMeta,
    exam_format: "USMLE"
  };
  payload.incorrect_answers = Array.isArray(body) ? body : [];
  const data = await openaiChatJson<any>({
    system:
      [
        "You generate AI Study Recommendations for a medical exam prep platform.",
        "Given the quiz metadata and the user's incorrect answers, return ONLY a single JSON object with this shape:",
        "{",
        '  "post_quiz_recommendations": {',
        '    "weak_area_level": "<string>",',
        '    "weak_area_name": "<string>",',
        '    "why_this_is_commonly_missed": "<string>",',
        '    "what_to_review": "<string>",',
        '    "how_to_practice": "<string>",',
        '    "suggested_references": "<string>",',
        '    "mcqs": [ { "mcqId": "<string>", "difficulty": "Basic|Intermediate|Advance", "question": "<string>", "options": [ { "option": "A|B|C|D|E|F", "optionText": "<string>", "explanation": "<string>" } ], "correctOption": "A|B|C|D|E|F" } ]',
        "  },",
        '  "clinical_case": <object|null>,',
        '  "flashcards": { "flashcards": [ { "flashCardId": "<string>", "frontText": "<string>", "backText": "<string>", "explanation": "<string>", "difficulty": "Basic|Intermediate|Advance" } ] } | null,',
        '  "notes": { "title": "<string>", "note": "<string>" } | null',
        "}",
        "",
        "Rules:",
        "- If you cannot produce a section, set it to null (do not omit keys).",
        "- MCQs must be clinically accurate and aligned with the weak area.",
        "- For each MCQ option, provide 3–5 sentences: rationale, mechanism/pearl vs distractors; for the correct option end with a one-line key takeaway.",
        "- Do not be repetitive. Exam-grade clinical wording.",
      ].join("\n"),
    user: JSON.stringify(payload),
    temperature: 0.2,
  });
  const normalizedData =
    data && typeof data === "object" && !Array.isArray(data)
      ? {
          post_quiz_recommendations: data.post_quiz_recommendations ?? null,
          clinical_case: data.clinical_case ?? null,
          flashcards: data.flashcards ?? null,
          notes: data.notes ?? null,
        }
      : {
          post_quiz_recommendations: null,
          clinical_case: null,
          flashcards: null,
          notes: null,
        };

  // Randomize recommended MCQ correctOption labels too.
  try {
    const recMcqs = normalizedData?.post_quiz_recommendations?.mcqs;
    if (Array.isArray(recMcqs) && recMcqs.length && normalizedData.post_quiz_recommendations) {
      normalizedData.post_quiz_recommendations.mcqs = shuffleAndRelabelMcqs(recMcqs as any) as any;
    }
  } catch {
    // best-effort only
  }

  // Ensure at least the correct option has an explanation for each recommended MCQ.
  try {
    const mcqs = normalizedData?.post_quiz_recommendations?.mcqs;
    if (Array.isArray(mcqs) && mcqs.length) {
      const missing = mcqs
        .map((m: any, idx: number) => {
          const correct = String(m?.correctOption ?? "").trim();
          const opts = Array.isArray(m?.options) ? m.options : [];
          const correctOpt = opts.find((o: any) => String(o?.option ?? "").trim() === correct);
          const explanation = String(correctOpt?.explanation ?? "").trim();
          return explanation
            ? null
            : {
                key: String(m?.mcqId ?? "").trim() || `idx:${idx}`,
                question: String(m?.question ?? ""),
                correctOption: correct,
                optionText: String(correctOpt?.optionText ?? ""),
              };
        })
        .filter(Boolean);

      if (missing.length) {
        const fill = await openaiChatJson<any>({
          system: [
            "Fill in missing explanations for the correct option only.",
            "Return ONLY JSON: {\"items\":[{\"key\":\"...\",\"correctExplanation\":\"...\"}]}",
            "Rules: 3-5 sentences, clinically accurate: rationale, mechanism/pearl, then a one-line key takeaway at the end. No extra keys.",
          ].join("\n"),
          user: JSON.stringify({ items: missing }),
          temperature: 0,
        });

        const map = new Map<string, string>();
        if (Array.isArray(fill?.items)) {
          for (const it of fill.items) {
            const id = String(it?.key ?? "").trim();
            const expl = String(it?.correctExplanation ?? "").trim();
            if (id && expl) map.set(id, expl);
          }
        }

        for (let idx = 0; idx < mcqs.length; idx++) {
          const m = mcqs[idx];
          const key = String(m?.mcqId ?? "").trim() || `idx:${idx}`;
          const add = map.get(key);
          if (!add) continue;
          const correct = String(m?.correctOption ?? "").trim();
          if (!Array.isArray(m?.options)) continue;
          const correctOpt = m.options.find((o: any) => String(o?.option ?? "").trim() === correct);
          if (correctOpt && !String(correctOpt?.explanation ?? "").trim()) {
            correctOpt.explanation = add;
          }
        }

        // Final fallback: if still missing, generate from question + correct choice text.
        const stillMissing = mcqs
          .map((m: any, idx: number) => {
            const correct = String(m?.correctOption ?? "").trim();
            const opts = Array.isArray(m?.options) ? m.options : [];
            const correctOpt = opts.find((o: any) => String(o?.option ?? "").trim() === correct);
            const explanation = String(correctOpt?.explanation ?? "").trim();
            return explanation
              ? null
              : {
                  idx,
                  question: String(m?.question ?? ""),
                  correctOption: correct,
                  optionText: String(correctOpt?.optionText ?? ""),
                };
          })
          .filter(Boolean);

        if (stillMissing.length) {
          const fill2 = await openaiChatJson<any>({
            system: [
              "Write correct-answer explanations for MCQs.",
              "Return ONLY JSON: {\"items\":[{\"idx\":0,\"correctExplanation\":\"...\"}]}",
              "Rules: 3-5 sentences, clinically accurate, based only on the provided question + correct option text; end with a one-line key takeaway.",
            ].join("\n"),
            user: JSON.stringify({ items: stillMissing }),
            temperature: 0,
          });

          const map2 = new Map<number, string>();
          if (Array.isArray(fill2?.items)) {
            for (const it of fill2.items) {
              const idx = Number(it?.idx);
              const expl = String(it?.correctExplanation ?? "").trim();
              if (Number.isFinite(idx) && expl) map2.set(idx, expl);
            }
          }

          for (const [idx, expl] of map2.entries()) {
            const m = mcqs[idx];
            const correct = String(m?.correctOption ?? "").trim();
            if (!Array.isArray(m?.options)) continue;
            const correctOpt = m.options.find((o: any) => String(o?.option ?? "").trim() === correct);
            if (correctOpt && !String(correctOpt?.explanation ?? "").trim()) {
              correctOpt.explanation = expl;
            }
          }
        }
      }
    }
  } catch {
    // If filling fails, we still return the base recommendations.
  }
  // add recommendation
  await my_content_mcq_bank_model.updateOne(
    { _id: contentId },
    { "tracking.recommendedContent": normalizedData }
  );

  // update ai count
  await daily_ai_request_model.updateOne(
    { date: today },
    { $inc: { count: 1 } },
    { upsert: true },
  );
  return normalizedData;
}
export const ai_part_service = {
  chat_with_ai_tutor_from_ai,
  get_all_chat_history_from_ai,
  get_all_chat_thread_title_from_ai,
  build_study_plan_payload_from_ai_request,
  generate_new_study_plan_from_ai,
  generate_flashcard_from_ai,
  generate_mcq_from_ai,
  generate_clinical_case_from_ai,
  get_all_content_title_suggestion_from_db,
  mcq_generator_from_ai,
  generate_note_from_ai,
  generate_recommendation_from_ai
};
