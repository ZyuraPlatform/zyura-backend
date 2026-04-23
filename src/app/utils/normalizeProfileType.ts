import mongoose from "mongoose";
import { professional_profile_type_const_model, student_profile_type_const_model } from "../modules/profile_type_const/profile_type_const.schema";
import { ProfessionalModel } from "../modules/professional/professional.schema";
import { Student_Model } from "../modules/student/student.schema";
import { debugLog } from "./debugLog";

const populateProfessionType = async (maybeId: unknown) => {
  if (typeof maybeId !== "string") return null;
  if (!mongoose.Types.ObjectId.isValid(maybeId)) return null;

  // Manually populate: look up the profession type document by its ObjectId
  const [studentType, professionalType] = await Promise.all([
    student_profile_type_const_model.findById(maybeId).lean(),
    professional_profile_type_const_model.findById(maybeId).lean(),
  ]);

  if (studentType?.typeName) {
    return { category: "STUDENT" as const, typeName: String(studentType.typeName) };
  }
  if (professionalType?.typeName) {
    return { category: "PROFESSIONAL" as const, typeName: String(professionalType.typeName) };
  }
  return null;
};

/**
 * Ensures we always filter content using profileType=typeName (e.g. "Neurology"),
 * even if legacy users have an ObjectId stored in studentType/professionName.
 *
 * Returns the normalized { contentFor, profileType } pair.
 */
export async function getNormalizedContentScopeForAccount(accountId: string, role: string) {
  // #region agent log
  debugLog({runId:'pre-fix',hypothesisId:'H2',location:'normalizeProfileType.ts:entry',message:'getNormalizedContentScopeForAccount entry',data:{hasAccountId:Boolean(accountId),role}});
  // #endregion
  if (!accountId || !role) return { contentFor: undefined, profileType: undefined };

  if (role === "STUDENT") {
    const student = await Student_Model.findOne({ accountId }).select("studentType").lean();
    const current = student?.studentType;

    // Populate: resolve ObjectId → typeName from student_profile_type_const
    const populated = await populateProfessionType(current);
    if (populated?.category === "STUDENT") {
      // #region agent log
      debugLog({runId:'pre-fix',hypothesisId:'H2',location:'normalizeProfileType.ts:student_resolved',message:'Resolved studentType ObjectId -> typeName',data:{resolvedTypeName:populated.typeName}});
      // #endregion
      return { contentFor: "student" as const, profileType: populated.typeName };
    }
    // #region agent log
    debugLog({runId:'pre-fix',hypothesisId:'H2',location:'normalizeProfileType.ts:student_return',message:'Returning student scope',data:{profileType:typeof current==='string'?current:undefined,currentType:typeof current}});
    // #endregion
    return { contentFor: "student" as const, profileType: typeof current === "string" ? current : undefined };
  }

  if (role === "PROFESSIONAL") {
    const professional = await ProfessionalModel.findOne({ accountId }).select("professionName").lean();
    const current = professional?.professionName;

    // Populate: resolve ObjectId → typeName from professional_profile_type_const
    const populated = await populateProfessionType(current);
    if (populated?.category === "PROFESSIONAL") {
      // #region agent log
      debugLog({runId:'pre-fix',hypothesisId:'H2',location:'normalizeProfileType.ts:professional_resolved',message:'Resolved professionName ObjectId -> typeName',data:{resolvedTypeName:populated.typeName}});
      // #endregion
      return { contentFor: "professional" as const, profileType: populated.typeName };
    }
    // #region agent log
    debugLog({runId:'pre-fix',hypothesisId:'H2',location:'normalizeProfileType.ts:professional_return',message:'Returning professional scope',data:{profileType:typeof current==='string'?current:undefined,currentType:typeof current}});
    // #endregion
    return { contentFor: "professional" as const, profileType: typeof current === "string" ? current : undefined };
  }

  // #region agent log
  debugLog({runId:'pre-fix',hypothesisId:'H2',location:'normalizeProfileType.ts:unknown_role',message:'Unknown role for scope',data:{role}});
  // #endregion
  return { contentFor: undefined, profileType: undefined };
}