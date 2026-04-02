import { Request } from "express";
import { AppError } from "../../utils/app_error";
import { buildGoalContentFilter } from "../../utils/findContentQueryBuilder";
import { Account_Model } from "../auth/auth.schema";
import { goal_model } from "../goal/goal.schema";
import { ProfessionalModel } from "../professional/professional.schema";
import { professional_profile_type_const_model, student_profile_type_const_model } from "../profile_type_const/profile_type_const.schema";
import { Student_Model } from "../student/student.schema";
import { ClinicalCaseModel } from "./clinical_case.schema";

const create_new_clinical_case_and_save_on_db = async (req: Request) => {
  const payload = req?.body;
  const result = await ClinicalCaseModel.create(payload);


  // update content count
  if (payload?.contentFor == "student") {
    await student_profile_type_const_model.findOneAndUpdate(
      { typeName: payload?.profileType },
      { $inc: { totalContent: 1 } },
    );
  }
  if (payload?.contentFor == "professional") {
    await professional_profile_type_const_model.findOneAndUpdate(
      { typeName: payload?.profileType },
      { $inc: { totalContent: 1 } },
    );
  }
  return result;
};

const get_all_clinical_case_from_db = async (req: Request) => {
  const user = await Account_Model.findById(req?.user?.accountId).lean();
  const query = req?.query as any;

  let {
    page = 1,
    limit = 10,
    searchTerm = "",
    contentFor,
    subject,
    system,
    topic,
    subtopic,
  } = query;

  const filter: any = {};

  // 🧠 Role-based filters
  if (req?.user?.role === "STUDENT") {
    const student = await Student_Model.findOne({
      accountId: req?.user?.accountId,
    });
    filter.contentFor = "student";
    filter.profileType = student?.studentType;
  }

  if (req?.user?.role === "PROFESSIONAL") {
    const professional = await ProfessionalModel.findOne({
      accountId: req?.user?.accountId,
    });
    filter.contentFor = "professional";
    filter.profileType = professional?.professionName;
  }

  // 🔍 Global search
  if (searchTerm) {
    filter.$or = [{ caseTitle: { $regex: searchTerm, $options: "i" } }];
  }

  // 🎯 Individual filters (regex-based – unchanged)
  if (contentFor) filter.contentFor = contentFor;
  if (subject) filter.subject = { $regex: subject, $options: "i" };
  if (system) filter.system = { $regex: system, $options: "i" };
  if (topic) filter.topic = { $regex: topic, $options: "i" };
  if (subtopic) filter.subtopic = { $regex: subtopic, $options: "i" };

  // 🎯 Apply Goal-based Filter
  const goal = await goal_model.findOne({
    studentId: req?.user?.accountId,
    goalStatus: "IN_PROGRESS",
  });

  const finalFilter = buildGoalContentFilter(goal, filter);

  // 🔢 Pagination
  const skip = (Number(page) - 1) * Number(limit);

  const [result, total] = await Promise.all([
    ClinicalCaseModel.find(finalFilter)
      .sort("-createdAt")
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    ClinicalCaseModel.countDocuments(finalFilter),
  ]);

  const finalResult = result.map((item: any) => {
    const isComplete =
      user?.finishedClinicalCaseIds?.some(
        (id: any) => id.toString() === item._id.toString(),
      ) || false;

    return {
      ...item, // item is now a plain object
      isComplete,
    };
  });

  return {
    data: finalResult,
    meta: {
      page: Number(page),
      limit: Number(limit),
      skip,
      total,
      totalPages: Math.ceil(total / Number(limit)),
    },
  };
};

const get_single_clinical_case_from_db = async (caseId: string) => {
  const isCaseExist = await ClinicalCaseModel.findById(caseId).lean();
  if (!isCaseExist) {
    throw new AppError("Case not found!!", 404);
  }
  return isCaseExist;
};

const update_clinical_case_by_id_into_db = async (req: Request) => {
  const { caseId } = req?.params;
  const payload = req?.body;
  const isCaseExist = await ClinicalCaseModel.findById(caseId).lean();
  if (!isCaseExist) {
    throw new AppError("Case not found!!", 404);
  }
  const result = await ClinicalCaseModel.findByIdAndUpdate(caseId, payload, {
    new: true,
  });
  return result;
};
const delete_clinical_case_by_id_from_db = async (caseId: string) => {
  const result = await ClinicalCaseModel.findByIdAndDelete(caseId);
  if (!result) {
    throw new AppError("Case not found!!", 404);
  }
  await student_profile_type_const_model.findOneAndUpdate(
    { typeName: result?.profileType },
    { $inc: { totalContent: -1 } },
  );
  await professional_profile_type_const_model.findOneAndUpdate(
    { typeName: result?.profileType },
    { $inc: { totalContent: -1 } },
  );
  return result;
};

export const clinical_case_services = {
  create_new_clinical_case_and_save_on_db,
  get_all_clinical_case_from_db,
  get_single_clinical_case_from_db,
  update_clinical_case_by_id_into_db,
  delete_clinical_case_by_id_from_db,
};
