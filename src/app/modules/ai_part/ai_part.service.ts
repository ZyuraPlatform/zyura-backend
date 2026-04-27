import { Request } from "express";
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
const today = new Date().toISOString().split("T")[0];

type TutorCategory = "medical_exam" | "platform_help" | "other";

const outOfScopeReply =
  "I’m here to help with medical exam prep and Zyura platform questions. Please share your exam/topic (e.g., cardiology, pharmacology, OSCE, MCQs, study plan) and I’ll help.";

const normalizeText = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

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
  if (v === "medical_exam" || v === "platform_help" || v === "other") return v;
  return null;
};

const classifyTutorQuestion = async (question: string): Promise<{
  category: TutorCategory;
  inDomain: boolean;
  reasonShort?: string;
}> => {
  if (looksPlatformHelpRelated(question)) {
    return { category: "platform_help", inDomain: true, reasonShort: "keyword_platform" };
  }
  if (looksMedicalExamRelated(question)) {
    return { category: "medical_exam", inDomain: true, reasonShort: "keyword_medical" };
  }

  try {
    const result = await openaiChatJson<any>({
      system: [
        "You are a strict classifier for Zyura AI Tutor.",
        "Decide whether the user question is in scope.",
        "In-scope categories:",
        '- medical_exam: medicine/clinical science, exam prep, MCQs, OSCE, diagnostics, treatments, study strategy for medical exams.',
        '- platform_help: questions about using Zyura features (flashcards, MCQ bank, study plan, notes, uploads, dashboard).',
        "Out-of-scope category:",
        "- other: general trivia, holidays, celebrities, politics, unrelated tech, etc.",
        "",
        'Return ONLY valid JSON exactly matching: {"category":"medical_exam|platform_help|other","inDomain":true|false,"reasonShort":"..."}',
        "",
        "Examples:",
        'Q: "When is Diwali?" -> {"category":"other","inDomain":false,"reasonShort":"holiday_trivia"}',
        'Q: "Explain sensitivity vs specificity with an example" -> {"category":"medical_exam","inDomain":true,"reasonShort":"exam_concept"}',
        'Q: "How do I generate flashcards on Zyura?" -> {"category":"platform_help","inDomain":true,"reasonShort":"zyura_feature"}',
      ].join("\n"),
      user: JSON.stringify({ question }),
      temperature: 0,
    });

    const category = parseTutorCategory(result?.category) ?? "other";
    const inDomain = Boolean(result?.inDomain) && category !== "other";
    const reasonShort = typeof result?.reasonShort === "string" ? result.reasonShort.slice(0, 80) : undefined;
    return { category, inDomain, reasonShort };
  } catch {
    // Fail-safe: do not answer off-topic if classifier fails.
    return { category: "other", inDomain: false, reasonShort: "classifier_failed" };
  }
};

const ensureMcqOptions = (options: any) => {
  // Accepts: array of {option, optionText, explanation?}
  if (Array.isArray(options)) {
    return options
      .filter((o) => o && typeof o === "object")
      .map((o) => ({
        option: String(o.option || "").trim(),
        optionText: String(o.optionText || o.text || "").trim(),
        explanation: o.explanation ? String(o.explanation) : undefined,
      }))
      .filter((o) => o.option && o.optionText);
  }
  // Accepts: object map {A: "...", B: "..."}
  if (options && typeof options === "object") {
    return Object.entries(options)
      .map(([k, v]) => ({
        option: String(k).trim(),
        optionText: String(v || "").trim(),
      }))
      .filter((o) => o.option && o.optionText);
  }
  return [];
};

const normalizeMcqs = (raw: any) => {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.mcqs) ? raw.mcqs : [];
  return arr
    .filter((m: any) => m && typeof m === "object")
    .map((m: any, idx: number) => {
      const options = ensureMcqOptions(m.options);
      const correct = String(m.correctOption || m.correctAnswer || "").trim();
      const difficulty = String(m.difficulty || m.difficultyLevel || "Basic").trim();
      return {
        mcqId: String(m.mcqId || `AI-${idx + 1}`),
        difficulty: (["Basic", "Intermediate", "Advance"].includes(difficulty) ? difficulty : "Basic"),
        question: String(m.question || "").trim(),
        options,
        correctOption: (["A", "B", "C", "D", "E", "F"].includes(correct) ? correct : options?.[0]?.option || "A"),
      };
    })
    .filter((m: any) => m.question && Array.isArray(m.options) && m.options.length >= 2);
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

  const messagesForOpenAI = [
    {
      role: "system" as const,
      content:
        [
          "You are Zyura AI Tutor.",
          "Scope: medical exam prep (medicine/clinical science/OSCE/MCQs/study strategy) and Zyura platform help.",
          "If the user asks anything outside this scope, do NOT answer it; politely redirect them back to medical exam prep or Zyura usage questions.",
          "Be concise, clinically accurate, and explain reasoning step-by-step when needed.",
        ].join("\n"),
    },
    ...history.map((m) => ({
      role: m.type === "HumanMessage" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    })),
    { role: "user" as const, content: qText },
  ];

  const responseText = await openaiChatText({ messages: messagesForOpenAI, temperature: 0.3 });

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

// ai_part.service.ts — replace generate_new_study_plan_from_ai

const generate_new_study_plan_from_ai = async (req: Request) => {
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
  const defaultTopic = topics[0] || {};

  const baseFilter: Record<string, any> = {};
  if (contentForFilter) baseFilter.contentFor = contentForFilter;
  if (profileTypeFilter) baseFilter.profileType = profileTypeFilter;
  if (defaultTopic.subject) baseFilter.subject = defaultTopic.subject;
  if (defaultTopic.system) baseFilter.system = defaultTopic.system;
  if (defaultTopic.topic) baseFilter.topic = defaultTopic.topic;
  if (defaultTopic.subtopic) baseFilter.subtopic = defaultTopic.subtopic;

  const dailyPlanChunkPrompt = (chunk: typeof chunks[0]) => `
You are a medical study plan generator for the Zyura platform.

Generate ONLY the daily_plan entries for days ${chunk.fromDay} to ${chunk.toDay} (dates ${chunk.fromDate} to ${chunk.toDate}).

Return a JSON array (not wrapped in an object):
[
  {
    "day_number": <number>,
    "date": "<YYYY-MM-DD>",
    "total_hours": <number>,
    "topics": ["<topic string>"],
    "hourly_breakdown": [
      {
        "task_type": "<one of: mcq, flashcard, notes, clinical case, osce>",
        "description": "<task title mentioning subject/topic>",
        "duration_hours": <number>,
        "duration_minutes": <number>,
        "suggest_content": { "contentId": "", "limit": 10 },
        "isCompleted": false
      }
    ],
    "isCompleted": false
  }
]

Topics to cover in this chunk: ${JSON.stringify(chunk.topics)}
Daily study time: ${enrichedInput.daily_study_time || 4} hours/day
Mix task types across days. Return ONLY the JSON array. No markdown.
`.trim();

  // ─── STEP 3: Run all chunk AI calls + DB queries in parallel ──────────────
  const [chunkResults, mcqBank, flashcard, note, clinicalCase, osce] = await Promise.all([
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
    // All DB lookups in parallel
    McqBankModel.findOne(baseFilter).select("_id").sort({ createdAt: -1 }).lean().catch(() => null),
    FlashcardModel.findOne(baseFilter).select("_id").sort({ createdAt: -1 }).lean().catch(() => null),
    notes_model.findOne(baseFilter).select("_id").sort({ createdAt: -1 }).lean().catch(() => null),
    ClinicalCaseModel.findOne(baseFilter).select("_id").sort({ createdAt: -1 }).lean().catch(() => null),
    osce_model.findOne(baseFilter).select("_id").sort({ createdAt: -1 }).lean().catch(() => null),
  ]);

  // ─── STEP 4: Merge chunks + fix dates ─────────────────────────────────────
  const contentIdMap: Record<string, string> = {
    mcq:             mcqBank?._id?.toString()      ?? "",
    mcqs:            mcqBank?._id?.toString()      ?? "",
    flashcard:       flashcard?._id?.toString()    ?? "",
    flashcards:      flashcard?._id?.toString()    ?? "",
    notes:           note?._id?.toString()         ?? "",
    note:            note?._id?.toString()         ?? "",
    "clinical case": clinicalCase?._id?.toString() ?? "",
    clinical_case:   clinicalCase?._id?.toString() ?? "",
    osce:            osce?._id?.toString()         ?? "",
  };

  const rawDailyPlan: any[] = chunkResults.flat();

  // Fix all day numbers + dates + inject contentIds in one pass
  const daily_plan = rawDailyPlan.map((day: any, index: number) => {
    const dayDate = new Date(start);
    dayDate.setDate(start.getDate() + index);

    const hourly_breakdown = Array.isArray(day.hourly_breakdown)
      ? day.hourly_breakdown.map((task: any) => {
          const taskType = String(task.task_type || "").toLowerCase().trim();
          return {
            ...task,
            suggest_content: {
              contentId: contentIdMap[taskType] ?? "",
              limit: task.suggest_content?.limit || 10,
            },
          };
        })
      : [];

    return {
      ...day,
      day_number: index + 1,
      date: dayDate.toISOString().split("T")[0],
      hourly_breakdown,
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

  // ─── STEP 6: Persist + analytics in parallel ──────────────────────────────
  const [result] = await Promise.all([
    study_planner_model.create({
      ...parseData,
      accountId: req?.user?.accountId,
      status: "in_progress",
    }),
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
        "- For EACH option provide a short explanation (1–2 sentences) why it is correct/incorrect.",
      ].join("\n"),
    user: JSON.stringify(payload),
    temperature: 0.3,
  });
  const mcqs = normalizeMcqs(data);
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
          "Rules: 1-3 sentences, clinically accurate, no extra keys.",
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
        "- For EACH option provide a short explanation (1–2 sentences) why it is correct/incorrect.",
      ].join("\n"),
    user: JSON.stringify({ ...payload, fileText: fileText || undefined }),
    temperature: 0.3,
  });
  const mcqs = normalizeMcqs(data);
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
        "- For each MCQ option, provide a short explanation (1–2 sentences) for why it is correct/incorrect.",
        "- Keep outputs concise but useful.",
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
            "Rules: 1-3 sentences, clinically accurate, no extra keys.",
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
              "Rules: 1-3 sentences, clinically accurate, based only on the provided question + correct option text.",
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
  generate_new_study_plan_from_ai,
  generate_flashcard_from_ai,
  generate_mcq_from_ai,
  generate_clinical_case_from_ai,
  get_all_content_title_suggestion_from_db,
  mcq_generator_from_ai,
  generate_note_from_ai,
  generate_recommendation_from_ai
};
