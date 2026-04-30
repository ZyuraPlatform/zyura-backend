import { z } from "zod";

/** Same shape as create-study-plan body (ai_part) + optional title/start_date for smart planner */
const updateStudyPlan = z.object({
  title: z.string().optional(),
  exam_name: z.string(),
  exam_date: z.string(),
  exam_type: z.string(),
  daily_study_time: z.number(),
  start_date: z.string().optional(),
  topics: z.array(
    z.object({
      subject: z.string(),
      system: z.string(),
      topic: z.string(),
      subtopic: z.string(),
    }),
  ),
  selection_snapshot: z.unknown().optional(),
  created_from: z.enum(["smart_study", "smart_study_planner"]).optional(),
});

const create = z.object({
  plan_summary: z.string(),
  total_days: z.number(),
  daily_plan: z.array(
    z.object({
      day_number: z.number(),
      date: z.string(), // if you want: z.string().datetime()
      total_hours: z.number(),
      topics: z.array(z.string()),
      hourly_breakdown: z.array(
        z.object({
          task_type: z.string(),
          description: z.string(),
          duration_hours: z.number().optional(),
          duration_minutes: z.number().optional(),
          suggest_content: z.object({
            contentId: z.string(),
            limit: z.number(),
          }),
        }),
      ),
    }),
  ),
});

export const study_planner_validations = { create, updateStudyPlan };
