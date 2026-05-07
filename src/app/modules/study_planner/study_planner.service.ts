import { Request } from "express";
import { Types } from "mongoose";
import { AppError } from "../../utils/app_error";
import { daily_ai_request_model } from "../analytics/analytics.schema";
import { ai_part_service } from "../ai_part/ai_part.service";
import { ClinicalCaseModel } from "../clinical_case/clinical_case.schema";
import { study_planner_model } from "./study_planner.schema";

const todayStr = () => new Date().toISOString().split("T")[0];

type TaskProgressFields = {
  isCompleted?: boolean;
  attempted_count?: number;
  total_count?: number;
  attempts?: unknown;
  attempted_case_ids?: string[];
};

const stableSnapshotKey = (snapshot: unknown): string => {
  if (!snapshot || typeof snapshot !== "object") return "";
  const s = snapshot as Record<string, unknown>;
  const ordered = {
    contentFor: String(s.contentFor ?? "").trim().toLowerCase(),
    profileType: String(s.profileType ?? "").trim().toLowerCase(),
    subject: String(s.subject ?? "").trim().toLowerCase(),
    system: String(s.system ?? "").trim().toLowerCase(),
    topic: String(s.topic ?? "").trim().toLowerCase(),
    subtopic: String(s.subtopic ?? "").trim().toLowerCase(),
  };
  return JSON.stringify(ordered);
};

const taskProgressKey = (dateStr: string, taskType: string, contentId: string) => {
  const d = String(dateStr ?? "").includes("T")
    ? String(dateStr).split("T")[0]
    : String(dateStr);
  return `${d}|${String(taskType ?? "").toLowerCase()}|${String(contentId ?? "")}`;
};

const taskProgressKeyWithSnapshot = (
  dateStr: string,
  taskType: string,
  contentId: string,
  snapshot: unknown,
) => `${taskProgressKey(dateStr, taskType, contentId)}|${stableSnapshotKey(snapshot)}`;

const buildProgressMap = (oldDaily: unknown): Map<string, TaskProgressFields> => {
  const m = new Map<string, TaskProgressFields>();
  const days = Array.isArray(oldDaily) ? oldDaily : [];
  for (const day of days as any[]) {
    const dateStr = day?.date;
    for (const t of day?.hourly_breakdown ?? []) {
      const sc = t?.suggest_content;
      const cid =
        sc && typeof sc === "object" && "contentId" in sc
          ? String((sc as { contentId?: string }).contentId ?? "")
          : "";
      const key = taskProgressKey(String(dateStr), String(t?.task_type ?? ""), cid);
      const keyWithSnapshot = taskProgressKeyWithSnapshot(
        String(dateStr),
        String(t?.task_type ?? ""),
        cid,
        t?.suggest_content?.filterSnapshot,
      );
      const progress: TaskProgressFields = {
        isCompleted: t?.isCompleted === true,
        attempted_count: t?.attempted_count,
        total_count: t?.total_count,
        attempts: t?.attempts,
        attempted_case_ids: t?.attempted_case_ids,
      };
      m.set(key, {
        ...progress,
      });
      m.set(keyWithSnapshot, { ...progress });
    }
  }
  return m;
};

const mergeDailyPlanProgress = (oldDaily: unknown, newDaily: unknown[]): any[] => {
  const progressByKey = buildProgressMap(oldDaily);
  return newDaily.map((day: any) => {
    const dateStr = day?.date;
    const nextBreakdown = (day?.hourly_breakdown ?? []).map((t: any) => {
      const sc = t?.suggest_content;
      const cid =
        sc && typeof sc === "object" && "contentId" in sc
          ? String((sc as { contentId?: string }).contentId ?? "")
          : "";
      const key = taskProgressKey(String(dateStr), String(t?.task_type ?? ""), cid);
      const keyWithSnapshot = taskProgressKeyWithSnapshot(
        String(dateStr),
        String(t?.task_type ?? ""),
        cid,
        t?.suggest_content?.filterSnapshot,
      );
      const saved = progressByKey.get(keyWithSnapshot) ?? progressByKey.get(key);
      if (!saved) return { ...t };
      const merged = { ...t };
      if (saved.isCompleted !== undefined) merged.isCompleted = saved.isCompleted;
      if (saved.attempted_count !== undefined) merged.attempted_count = saved.attempted_count;
      if (saved.total_count !== undefined) merged.total_count = saved.total_count;
      if (saved.attempts !== undefined) merged.attempts = saved.attempts;
      if (saved.attempted_case_ids !== undefined) {
        merged.attempted_case_ids = saved.attempted_case_ids;
      }
      return merged;
    });
    const isDayCompleted =
      nextBreakdown.length > 0 &&
      nextBreakdown.every((x: any) => x.isCompleted === true);
    return {
      ...day,
      hourly_breakdown: nextBreakdown,
      isCompleted: isDayCompleted,
    };
  });
};

const get_all_study_plan_from_db = async (req: Request) => {
  const accountId = req?.user?.accountId;
  const created_from = String(req?.query?.created_from || "").trim();
  const query: Record<string, any> = { accountId };
  if (created_from) query.created_from = created_from;
  const result = await study_planner_model
    .find(query)
    .sort("-createdAt")
    .lean();
  return result;
};

// study_planner.service.ts — replace save_study_plan_progress_into_db

const save_study_plan_progress_into_db = async (req: Request) => {
  const { planId, day, suggest_content } = req.body as {
    planId: string;
    day: number;
    suggest_content: string;
  };

  // Step 1: Mark the specific task as completed
  const afterTaskUpdate = await study_planner_model.findOneAndUpdate(
    {
      _id: new Types.ObjectId(planId),
      accountId: req?.user?.accountId,
    },
    {
      $set: {
        "daily_plan.$[d].hourly_breakdown.$[t].isCompleted": true,
      },
    },
    {
      new: true,
      arrayFilters: [
        { "d.day_number": day },
        { "t.suggest_content.contentId": suggest_content },
      ],
    }
  ).lean();

  if (!afterTaskUpdate) {
    throw new AppError("Study plan not found", 404);
  }

  // Step 2: Check if this specific day is fully complete
  const targetDay = afterTaskUpdate.daily_plan.find((d) => d.day_number === day);
  if (!targetDay) {
    throw new AppError("Day not found in plan", 404);
  }

  const isDayCompleted =
    targetDay.hourly_breakdown.length > 0 &&
    targetDay.hourly_breakdown.every((task) => task.isCompleted === true);

  // Step 3: Update that day's isCompleted flag
  const afterDayUpdate = await study_planner_model.findOneAndUpdate(
    {
      _id: new Types.ObjectId(planId),
      accountId: req?.user?.accountId,
    },
    {
      $set: {
        "daily_plan.$[d].isCompleted": isDayCompleted,
      },
    },
    {
      new: true,
      arrayFilters: [{ "d.day_number": day }],
    }
  ).lean();

  if (!afterDayUpdate) {
    throw new AppError("Failed to update day completion", 500);
  }

  // Step 4: Check if ALL days are now complete — only then mark plan as completed
  const allDaysCompleted =
    afterDayUpdate.daily_plan.length > 0 &&
    afterDayUpdate.daily_plan.every((d) => d.isCompleted === true);

  const finalUpdated = await study_planner_model.findOneAndUpdate(
    {
      _id: new Types.ObjectId(planId),
      accountId: req?.user?.accountId,
    },
    {
      $set: {
        status: allDaysCompleted ? "completed" : "in_progress",
      },
    },
    { new: true }
  ).lean();

  return finalUpdated;
};

type McqAttemptBody = {
  questionId: string;
  selectedOption: string;
  isCorrect: boolean;
};

const save_mcq_attempts_into_db = async (req: Request) => {
  const { planId, day, suggest_content, total_count, attempts } =
    req.body as {
      planId: string;
      day: number;
      suggest_content: string;
      total_count: number;
      attempts: McqAttemptBody[];
    };

  if (
    !planId ||
    day == null ||
    typeof suggest_content !== "string" ||
    !suggest_content.trim() ||
    typeof total_count !== "number" ||
    total_count < 0 ||
    !Array.isArray(attempts)
  ) {
    throw new AppError("Invalid MCQ attempts payload", 400);
  }

  const planBefore = await study_planner_model
    .findOne({
      _id: new Types.ObjectId(planId),
      accountId: req?.user?.accountId,
    })
    .lean();

  if (!planBefore) {
    throw new AppError("Study plan not found", 404);
  }

  const dayBefore = planBefore.daily_plan.find((d) => d.day_number === day);
  if (!dayBefore) {
    throw new AppError("Day not found in plan", 404);
  }
  const taskBefore = dayBefore?.hourly_breakdown?.find((t: any) => {
    const cid = t.suggest_content?.contentId;
    return cid === suggest_content;
  });
  if (!taskBefore) {
    throw new AppError("Task not found in plan", 404);
  }
  const existingIsCompleted = taskBefore?.isCompleted === true;

  // Merge attempts by questionId so a subsequent partial save cannot overwrite prior progress.
  const existingAttempts: McqAttemptBody[] = Array.isArray((taskBefore as any)?.attempts)
    ? ((taskBefore as any).attempts as McqAttemptBody[])
    : [];

  const byQuestionId = new Map<string, McqAttemptBody>();
  for (const a of existingAttempts) {
    const qid = String(a?.questionId ?? "").trim();
    if (!qid) continue;
    byQuestionId.set(qid, {
      questionId: qid,
      selectedOption: String(a?.selectedOption ?? "").trim(),
      isCorrect: Boolean(a?.isCorrect),
    });
  }
  for (const a of attempts) {
    const qid = String(a?.questionId ?? "").trim();
    if (!qid) continue;
    byQuestionId.set(qid, {
      questionId: qid,
      selectedOption: String(a?.selectedOption ?? "").trim(),
      isCorrect: Boolean(a?.isCorrect),
    });
  }

  const mergedAttempts = Array.from(byQuestionId.values());
  const attempted_count = mergedAttempts.length;
  const isTaskComplete =
    existingIsCompleted ||
    (total_count > 0 && attempted_count === total_count);

  const afterTaskUpdate = await study_planner_model
    .findOneAndUpdate(
      {
        _id: new Types.ObjectId(planId),
        accountId: req?.user?.accountId,
      },
      {
        $set: {
          "daily_plan.$[d].hourly_breakdown.$[t].attempted_count": attempted_count,
          "daily_plan.$[d].hourly_breakdown.$[t].total_count": total_count,
          "daily_plan.$[d].hourly_breakdown.$[t].attempts": mergedAttempts,
          "daily_plan.$[d].hourly_breakdown.$[t].isCompleted": isTaskComplete,
        },
      },
      {
        new: true,
        arrayFilters: [
          { "d.day_number": day },
          { "t.suggest_content.contentId": suggest_content },
        ],
      },
    )
    .lean();

  if (!afterTaskUpdate) {
    throw new AppError("Study plan not found", 404);
  }

  const targetDay = afterTaskUpdate.daily_plan.find((d) => d.day_number === day);
  if (!targetDay) {
    throw new AppError("Day not found in plan", 404);
  }

  const isDayCompleted =
    targetDay.hourly_breakdown.length > 0 &&
    targetDay.hourly_breakdown.every((task) => task.isCompleted === true);

  const afterDayUpdate = await study_planner_model
    .findOneAndUpdate(
      {
        _id: new Types.ObjectId(planId),
        accountId: req?.user?.accountId,
      },
      {
        $set: {
          "daily_plan.$[d].isCompleted": isDayCompleted,
        },
      },
      {
        new: true,
        arrayFilters: [{ "d.day_number": day }],
      },
    )
    .lean();

  if (!afterDayUpdate) {
    throw new AppError("Failed to update day completion", 500);
  }

  const allDaysCompleted =
    afterDayUpdate.daily_plan.length > 0 &&
    afterDayUpdate.daily_plan.every((d) => d.isCompleted === true);

  const finalUpdated = await study_planner_model
    .findOneAndUpdate(
      {
        _id: new Types.ObjectId(planId),
        accountId: req?.user?.accountId,
      },
      {
        $set: {
          status: allDaysCompleted ? "completed" : "in_progress",
        },
      },
      { new: true },
    )
    .lean();

  return finalUpdated;
};

const buildClinicalFilterFromSnapshot = (snapshot: unknown): Record<string, unknown> => {
  if (!snapshot || typeof snapshot !== "object") return {};
  const s = snapshot as Record<string, unknown>;
  const pick = (k: string) => String(s[k] ?? "").trim();
  const filter: Record<string, unknown> = {};
  const contentFor = pick("contentFor");
  const profileType = pick("profileType");
  const subject = pick("subject");
  const system = pick("system");
  const topic = pick("topic");
  const subtopic = pick("subtopic");
  if (contentFor) filter.contentFor = contentFor;
  if (profileType) filter.profileType = profileType;
  if (subject) filter.subject = subject;
  if (system) filter.system = system;
  if (topic) filter.topic = topic;
  if (subtopic) filter.subtopic = subtopic;
  return filter;
};

const save_clinical_case_attempt_into_db = async (req: Request) => {
  const { planId, day, suggest_content, caseId } = req.body as {
    planId: string;
    day: number;
    suggest_content: string;
    caseId: string;
  };

  if (
    !planId ||
    day == null ||
    typeof suggest_content !== "string" ||
    !suggest_content.trim() ||
    typeof caseId !== "string" ||
    !caseId.trim()
  ) {
    throw new AppError("Invalid clinical attempt payload", 400);
  }

  const planBefore = await study_planner_model
    .findOne({
      _id: new Types.ObjectId(planId),
      accountId: req?.user?.accountId,
    })
    .lean();

  if (!planBefore) {
    throw new AppError("Study plan not found", 404);
  }

  const dayBefore = planBefore.daily_plan.find((d) => d.day_number === day);
  if (!dayBefore) {
    throw new AppError("Day not found in plan", 404);
  }

  const taskBefore = dayBefore?.hourly_breakdown?.find((t: any) => {
    const cid = t?.suggest_content?.contentId;
    return String(cid ?? "") === suggest_content;
  });
  if (!taskBefore) {
    throw new AppError("Task not found in plan", 404);
  }

  const existingAttemptedCaseIds: string[] = Array.isArray((taskBefore as any)?.attempted_case_ids)
    ? ((taskBefore as any).attempted_case_ids as string[])
    : [];
  const mergedIds = Array.from(
    new Set(
      [...existingAttemptedCaseIds, caseId]
        .map((x) => String(x ?? "").trim())
        .filter(Boolean),
    ),
  );

  const limitFromTask = Number(taskBefore?.suggest_content?.limit ?? 0);
  const total_count = limitFromTask > 0 ? limitFromTask : mergedIds.length;
  const attempted_count = mergedIds.length;
  const isTaskComplete = total_count > 0 && attempted_count >= total_count;

  const afterTaskUpdate = await study_planner_model
    .findOneAndUpdate(
      {
        _id: new Types.ObjectId(planId),
        accountId: req?.user?.accountId,
      },
      {
        $set: {
          "daily_plan.$[d].hourly_breakdown.$[t].attempted_case_ids": mergedIds,
          "daily_plan.$[d].hourly_breakdown.$[t].attempted_count": attempted_count,
          "daily_plan.$[d].hourly_breakdown.$[t].total_count": total_count,
          "daily_plan.$[d].hourly_breakdown.$[t].isCompleted": isTaskComplete,
        },
      },
      {
        new: true,
        arrayFilters: [
          { "d.day_number": day },
          { "t.suggest_content.contentId": suggest_content },
        ],
      },
    )
    .lean();

  if (!afterTaskUpdate) {
    throw new AppError("Study plan not found", 404);
  }

  const targetDay = afterTaskUpdate.daily_plan.find((d) => d.day_number === day);
  if (!targetDay) {
    throw new AppError("Day not found in plan", 404);
  }

  const isDayCompleted =
    targetDay.hourly_breakdown.length > 0 &&
    targetDay.hourly_breakdown.every((task) => task.isCompleted === true);

  const afterDayUpdate = await study_planner_model
    .findOneAndUpdate(
      {
        _id: new Types.ObjectId(planId),
        accountId: req?.user?.accountId,
      },
      {
        $set: {
          "daily_plan.$[d].isCompleted": isDayCompleted,
        },
      },
      {
        new: true,
        arrayFilters: [{ "d.day_number": day }],
      },
    )
    .lean();

  if (!afterDayUpdate) {
    throw new AppError("Failed to update day completion", 500);
  }

  const allDaysCompleted =
    afterDayUpdate.daily_plan.length > 0 &&
    afterDayUpdate.daily_plan.every((d) => d.isCompleted === true);

  const finalUpdated = await study_planner_model
    .findOneAndUpdate(
      {
        _id: new Types.ObjectId(planId),
        accountId: req?.user?.accountId,
      },
      {
        $set: {
          status: allDaysCompleted ? "completed" : "in_progress",
        },
      },
      { new: true },
    )
    .lean();

  const snapshot = taskBefore?.suggest_content?.filterSnapshot;
  const clinicalFilter = buildClinicalFilterFromSnapshot(snapshot);
  let next_case_id: string | null = null;
  let content_exhausted = false;

  if (!isTaskComplete && Object.keys(clinicalFilter).length > 0) {
    const excludedObjectIds: Types.ObjectId[] = [];
    for (const id of mergedIds) {
      try {
        excludedObjectIds.push(new Types.ObjectId(id));
      } catch {
        // Ignore malformed ids and continue.
      }
    }

    const nextCase = await ClinicalCaseModel.findOne({
      ...clinicalFilter,
      _id: {
        $nin: excludedObjectIds,
      },
    })
      .sort("-createdAt")
      .select("_id")
      .lean();

    if (nextCase?._id) {
      next_case_id = String(nextCase._id);
    } else {
      content_exhausted = true;
    }
  }

  return {
    plan: finalUpdated,
    attempted_count,
    total_count,
    task_completed: isTaskComplete,
    next_case_id,
    content_exhausted,
  };
};

const cancel_study_plan_from_db = async (req: Request) => {
  const { planId } = req.params as {
    planId: string;
  };

  const result = await study_planner_model.findOneAndUpdate(
    {
      _id: new Types.ObjectId(planId)
    },
    {
      $set: {
        status: "cancelled",
      },
    },
    {
      new: true,
      upsert: true
    }
  ).lean();

  return result;
};

const delete_study_plan_from_db = async (req: Request) => {
  const { planId } = req.params as {
    planId: string;
  };
  const result = await study_planner_model.findOneAndDelete(
    {
      _id: new Types.ObjectId(planId)
    }
  ).lean();

  return result;
};


// Add to study_planner.service.ts (inside the service object too)

const get_single_study_plan_from_db = async (req: Request) => {
  const { planId } = req.params as { planId: string };
  const accountId = req?.user?.accountId;

  const result = await study_planner_model
    .findOne({ _id: new Types.ObjectId(planId), accountId })
    .lean();

  if (!result) {
    throw new AppError("Study plan not found", 404);
  }

  return result;
};

const update_study_plan_in_db = async (req: Request) => {
  const { planId } = req.params as { planId: string };
  const accountId = req?.user?.accountId;

  if (!planId || !accountId) {
    throw new AppError("Invalid request", 400);
  }

  const existing = await study_planner_model
    .findOne({ _id: new Types.ObjectId(planId), accountId })
    .lean();

  if (!existing) {
    throw new AppError("Study plan not found", 404);
  }

  const { parseData, startDate } =
    await ai_part_service.build_study_plan_payload_from_ai_request(req);

  const mergedDaily = mergeDailyPlanProgress(
    existing.daily_plan,
    parseData.daily_plan as unknown[],
  );

  const allDaysCompleted =
    mergedDaily.length > 0 &&
    mergedDaily.every(
      (d: any) =>
        Array.isArray(d.hourly_breakdown) &&
        d.hourly_breakdown.length > 0 &&
        d.hourly_breakdown.every((t: any) => t.isCompleted === true),
    );

  const planTitle = String(
    req.body?.title ??
      req.body?.exam_name ??
      parseData?.exam_name ??
      "Study plan",
  )
    .trim()
    .slice(0, 120);

  const updated = await study_planner_model
    .findOneAndUpdate(
      { _id: new Types.ObjectId(planId), accountId },
      {
        $set: {
          title: planTitle || existing.title,
          exam_name: parseData.exam_name ?? req.body?.exam_name,
          exam_date: parseData.exam_date ?? req.body?.exam_date,
          exam_type: parseData.exam_type ?? req.body?.exam_type ?? "",
          start_date: startDate,
          daily_study_time: Number(
            parseData.daily_study_time ?? req.body?.daily_study_time ?? 0,
          ),
          topics: parseData.topics ?? req.body?.topics,
          plan_summary: parseData.plan_summary,
          total_days: parseData.total_days,
          daily_plan: mergedDaily,
          selection_snapshot: req.body?.selection_snapshot,
          status: allDaysCompleted ? "completed" : "in_progress",
        },
      },
      { new: true },
    )
    .lean();

  await daily_ai_request_model.updateOne(
    { date: todayStr() },
    { $inc: { count: 1 } },
    { upsert: true },
  );

  return updated;
};

// ─── Add to the exported object ───────────────────────────────────────────
export const study_planner_service = {
  get_all_study_plan_from_db,
  get_single_study_plan_from_db,   // ← new
  save_study_plan_progress_into_db,
  save_mcq_attempts_into_db,
  save_clinical_case_attempt_into_db,
  cancel_study_plan_from_db,
  delete_study_plan_from_db,
  update_study_plan_in_db,
};