// study_planner.route.ts — full replacement

import { Router } from "express";
import auth from "../../middlewares/auth";
import RequestValidator from "../../middlewares/request_validator";
import { study_planner_controller } from "./study_planner.controller";
import { study_planner_validations } from "./study_planner.validation";

const study_planner_router = Router();

study_planner_router.get(
  "/all",
  auth("STUDENT", "PROFESSIONAL"),
  study_planner_controller.get_all_study_plan
);

study_planner_router.put(
  "/update/:planId",
  auth("STUDENT", "PROFESSIONAL"),
  RequestValidator(study_planner_validations.updateStudyPlan),
  study_planner_controller.update_study_plan,
);

// ─── ADD THIS: single plan by ID ──────────────────────────────────────────
study_planner_router.get(
  "/:planId",
  auth("STUDENT", "PROFESSIONAL"),
  study_planner_controller.get_single_study_plan
);

study_planner_router.put(
  "/save-progress",
  auth("STUDENT", "PROFESSIONAL"),
  study_planner_controller.save_study_plan_progress
);

study_planner_router.put(
  "/save-mcq-attempts",
  auth("STUDENT", "PROFESSIONAL"),
  study_planner_controller.save_mcq_attempts
);

study_planner_router.put(
  "/save-clinical-attempt",
  auth("STUDENT", "PROFESSIONAL"),
  study_planner_controller.save_clinical_case_attempt
);

study_planner_router.put(
  "/cancel/:planId",
  auth("STUDENT", "PROFESSIONAL"),
  study_planner_controller.cancel_study_plan
);

study_planner_router.delete(
  "/delete/:planId",
  auth("STUDENT", "PROFESSIONAL"),
  study_planner_controller.delete_study_plan
);

export default study_planner_router;