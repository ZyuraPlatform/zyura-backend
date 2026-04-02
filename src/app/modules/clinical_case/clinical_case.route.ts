import { Router } from "express";
import auth from "../../middlewares/auth";
import RequestValidator from "../../middlewares/request_validator";
import { clinical_case_controllers } from "./clinical_case.controller";
import { clinical_case_validations } from "./clinical_case.validation";

const clinical_route = Router();

clinical_route.post(
  "/create-new",
  auth("ADMIN"),
  RequestValidator(clinical_case_validations.create),
  clinical_case_controllers.create_new_clinical_case,
);
clinical_route.get(
  "/",
  auth("ADMIN", "STUDENT", "PROFESSIONAL", "MENTOR"),
  clinical_case_controllers.get_all_clinical_case,
);
clinical_route.get(
  "/:caseId",
  auth("ADMIN", "STUDENT", "PROFESSIONAL", "MENTOR"),
  clinical_case_controllers.get_single_clinical_case,
);
clinical_route.patch(
  "/:caseId",
  auth("ADMIN", "PROFESSIONAL", "MENTOR"),
  RequestValidator(clinical_case_validations.update),
  clinical_case_controllers.update_clinical_case_by_id,
);
clinical_route.delete(
  "/:caseId",
  auth("ADMIN", "PROFESSIONAL", "MENTOR"),
  clinical_case_controllers.delete_clinical_case_by_id,
);

export default clinical_route;
