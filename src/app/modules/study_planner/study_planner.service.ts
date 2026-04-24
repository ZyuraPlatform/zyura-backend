import { Request } from "express";
import { Types } from "mongoose";
import { AppError } from "../../utils/app_error";
import { study_planner_model } from "./study_planner.schema";

const get_all_study_plan_from_db = async (req: Request) => {
  const accountId = req?.user?.accountId;
  const result = await study_planner_model
    .find({ accountId })
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

// ─── Add to the exported object ───────────────────────────────────────────
export const study_planner_service = {
  get_all_study_plan_from_db,
  get_single_study_plan_from_db,   // ← new
  save_study_plan_progress_into_db,
  cancel_study_plan_from_db,
  delete_study_plan_from_db,
};