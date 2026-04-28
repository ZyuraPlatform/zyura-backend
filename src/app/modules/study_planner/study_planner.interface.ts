export type T_StudyPlanner = {
  accountId: string;
  plan_type?: "preference" | "smart";
  goalId?: string;
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
      duration_minutes?: number;
      suggest_content?: {
        contentId: string;
        limit: number;
      };
      duration_hours: number;
      isCompleted: boolean;
    }[];
    isCompleted: boolean;
  }[];
  status: "cancelled" | "completed" | "in_progress";
};
