export type T_StudyPlanner = {
  accountId: string;
  created_from?: "smart_study" | "smart_study_planner";
  /** User-facing plan title (Smart Study Planner) */
  title?: string;
  /** AI Tutor thread for this plan */
  thread_id?: string;
  /** Goal-style subject selection snapshot at creation */
  selection_snapshot?: unknown;
  exam_name?: string;
  exam_date?: string;
  exam_type?: string;
  start_date?: string;
  daily_study_time?: number;
  topics?: unknown[];
  plan_summary: string;
  total_days: number;
  daily_plan: {
    day_number: number;
    date: string;
    total_hours: number;
    topics: string[];
    hourly_breakdown: {
      task_type: string;
      description: string;
      suggest_content: {
        contentId: string;
        limit: number;
        filterSnapshot?: {
          contentFor?: string;
          profileType?: string;
          subject?: string;
          system?: string;
          topic?: string;
          subtopic?: string;
        };
      };
      duration_hours: number;
      duration_minutes?: number;
      isCompleted: boolean;
      attempted_count?: number;
      total_count?: number;
      attempts?: {
        questionId: string;
        selectedOption: string;
        isCorrect: boolean;
      }[];
      attempted_case_ids?: string[];
    }[];
    isCompleted: boolean;
  }[];
  status: "cancelled" | "completed" | "in_progress";
};
