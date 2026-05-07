// study_planner.controller.ts — full replacement

import httpStatus from "http-status";
import catchAsync from "../../utils/catch_async";
import manageResponse from "../../utils/manage_response";
import { study_planner_service } from "./study_planner.service";

const get_all_study_plan = catchAsync(async (req, res) => {
  const result = await study_planner_service.get_all_study_plan_from_db(req);
  manageResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Study plans fetched successfully",
    data: result,
  });
});

// ─── ADD THIS ─────────────────────────────────────────────────────────────
const get_single_study_plan = catchAsync(async (req, res) => {
  const result = await study_planner_service.get_single_study_plan_from_db(req);
  manageResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Study plan fetched successfully",
    data: result,
  });
});

const save_study_plan_progress = catchAsync(async (req, res) => {
  const result = await study_planner_service.save_study_plan_progress_into_db(req);
  manageResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Progress saved successfully",
    data: result,
  });
});

const save_mcq_attempts = catchAsync(async (req, res) => {
  const result = await study_planner_service.save_mcq_attempts_into_db(req);
  manageResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "MCQ attempts saved successfully",
    data: result,
  });
});

const save_clinical_case_attempt = catchAsync(async (req, res) => {
  const result = await study_planner_service.save_clinical_case_attempt_into_db(req);
  manageResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Clinical case attempt saved successfully",
    data: result,
  });
});

const cancel_study_plan = catchAsync(async (req, res) => {
  const result = await study_planner_service.cancel_study_plan_from_db(req);
  manageResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Study plan cancelled successfully",
    data: result,
  });
});

const delete_study_plan = catchAsync(async (req, res) => {
  const result = await study_planner_service.delete_study_plan_from_db(req);
  manageResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Study plan deleted successfully",
    data: result,
  });
});

const update_study_plan = catchAsync(async (req, res) => {
  const result = await study_planner_service.update_study_plan_in_db(req);
  manageResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Study plan updated successfully",
    data: result,
  });
});

export const study_planner_controller = {
  get_all_study_plan,
  get_single_study_plan,   // ← new
  save_study_plan_progress,
  save_mcq_attempts,
  save_clinical_case_attempt,
  cancel_study_plan,
  delete_study_plan,
  update_study_plan,
};