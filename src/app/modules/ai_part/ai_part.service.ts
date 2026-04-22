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
  const messagesForOpenAI = [
    {
      role: "system" as const,
      content:
        "You are Zyura AI Tutor. Be concise, clinically accurate, and explain reasoning step-by-step when needed.",
    },
    ...history.map((m) => ({
      role: m.type === "HumanMessage" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    })),
    { role: "user" as const, content: String(question || "") },
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

const generate_new_study_plan_from_ai = async (req: Request) => {
  const isAccount = await isAccountExist(req?.user?.email as string, "profile_id") as any;
  const payload = req?.body;
  if (req?.user?.role == "STUDENT") {
    payload.contentFor = "student";
    payload.profileType = isAccount?.profile_id?.profileType
  }
  if (req?.user?.role == "PROFESSIONAL") {
    payload.contentFor = "professional";
    payload.profileType = isAccount?.profile_id?.professionName
  }
  const data = await openaiChatJson<any>({
    system:
      "You generate a study plan JSON. Output must match the expected schema fields: exam_name, exam_date, exam_type, daily_study_time, topics[].",
    user: JSON.stringify(payload),
    temperature: 0.2,
  });
  const parseData = await study_planner_validations.create.parseAsync(data);
  const result = await study_planner_model.create({
    ...parseData,
    accountId: req?.user?.accountId,
    status: "in_progress",
  });
  await daily_ai_request_model.updateOne(
    { date: today },
    { $inc: { count: 1 } },
    { upsert: true },
  );
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
      "Generate MCQs.\nReturn JSON: {\"mcqs\":[{mcqId,difficulty,question,options:[{option,optionText,explanation?}],correctOption}]}\n- difficulty: Basic|Intermediate|Advance\n- correctOption: A|B|C|D|E|F\nReturn ONLY JSON.",
    user: JSON.stringify(payload),
    temperature: 0.3,
  });
  const mcqs = normalizeMcqs(data);
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
      "Generate MCQs from the prompt/fileText. Return JSON with key mcqs as array. Each item: question, options (A-D), correctAnswer, explanation.",
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
  payload.incorrect_answers = [...body]
  const data = await openaiChatJson<any>({
    system:
      "Return a JSON array of recommended content items based on incorrect answers. Each item should include at least title, subject/system/topic/subtopic when possible.",
    user: JSON.stringify(payload),
    temperature: 0.2,
  });
  // add recommendation
  await my_content_mcq_bank_model.updateOne(
    { _id: contentId },
    { "tracking.recommendedContent": data }
  );

  // update ai count
  await daily_ai_request_model.updateOne(
    { date: today },
    { $inc: { count: 1 } },
    { upsert: true },
  );
  return data;
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
