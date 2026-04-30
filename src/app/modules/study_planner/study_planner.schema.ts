import { Schema, model } from "mongoose";
import { T_StudyPlanner } from "./study_planner.interface";

export interface IMcqAttemptEntry {
  questionId: string;
  selectedOption: string;
  isCorrect: boolean;
}

export interface IHourlyBreakdown {
  task_type: string;
  description: string;
  duration_hours: number;
  duration_minutes: number;
  suggest_content: {
    contentId: string;
    limit: number;
  };
  isCompleted: boolean;
  /** MCQ progress: how many questions answered in this bank task */
  attempted_count?: number;
  /** MCQ progress: total questions in the bank */
  total_count?: number;
  /** Per-question attempt snapshot for resume / review */
  attempts?: IMcqAttemptEntry[];
}
export interface IDailyPlanEntry {
  day_number: number;
  date: string; // ISO date string
  total_hours: number;
  topics: string[];
  hourly_breakdown: IHourlyBreakdown[];
  isCompleted: boolean;
}
const SuggestContentSchema = new Schema({
  contentId: { type: String, },
  limit: { type: Number, },
}, { _id: false });

const McqAttemptEntrySchema = new Schema<IMcqAttemptEntry>(
  {
    questionId: { type: String, required: true },
    selectedOption: { type: String, required: true },
    isCorrect: { type: Boolean, required: true },
  },
  { _id: false },
);

const HourlyBreakdownSchema = new Schema<IHourlyBreakdown>(
  {
    task_type: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    duration_hours: { type: Number, required: true, min: 0 },
    duration_minutes: { type: Number, required: true, min: 0 },
    suggest_content: { type: SuggestContentSchema, required: false },
    isCompleted: { type: Boolean, default: false },
    attempted_count: { type: Number, required: false, min: 0 },
    total_count: { type: Number, required: false, min: 0 },
    attempts: { type: [McqAttemptEntrySchema], required: false, default: undefined },
  },
  { _id: false },
);

const DailyPlanEntrySchema = new Schema<IDailyPlanEntry>(
  {
    day_number: Number,
    date: String,
    total_hours: Number,
    topics: [String],
    hourly_breakdown: [HourlyBreakdownSchema],
    isCompleted: { type: Boolean, default: false },
  },
  { _id: false },
);
const study_planner_schema = new Schema<T_StudyPlanner>(
  {
    accountId: { type: String, required: true },
    created_from: {
      type: String,
      enum: ["smart_study", "smart_study_planner"],
      required: false,
    },
    title: { type: String, required: false },
    thread_id: { type: String, required: false, index: true },
    selection_snapshot: { type: Schema.Types.Mixed, required: false },
    exam_name: { type: String, required: false },
    exam_date: { type: String, required: false },
    exam_type: { type: String, required: false },
    start_date: { type: String, required: false },
    daily_study_time: { type: Number, required: false },
    topics: { type: [Schema.Types.Mixed], required: false },
    plan_summary: String,
    total_days: Number,
    daily_plan: [DailyPlanEntrySchema],
    status: { type: String, enum: ["in_progress", "completed", "cancelled"], default: "in_progress" },
  },
  { timestamps: true, versionKey: false },
);

export const study_planner_model = model("study_planner", study_planner_schema);