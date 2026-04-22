import mongoose from "mongoose";
import { professional_profile_type_const_model, student_profile_type_const_model } from "../modules/profile_type_const/profile_type_const.schema";
import { ProfessionalModel } from "../modules/professional/professional.schema";
import { Student_Model } from "../modules/student/student.schema";

const resolveTypeNameFromMaybeId = async (maybeId: unknown) => {
  if (typeof maybeId !== "string") return null;
  if (!mongoose.Types.ObjectId.isValid(maybeId)) return null;

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
  if (!accountId || !role) return { contentFor: undefined, profileType: undefined };

  if (role === "STUDENT") {
    const student = await Student_Model.findOne({ accountId }).select("studentType").lean();
    const current = student?.studentType;

    const resolved = await resolveTypeNameFromMaybeId(current);
    if (resolved?.category === "STUDENT") {
      await Student_Model.updateOne({ accountId }, { $set: { studentType: resolved.typeName } });
      return { contentFor: "student" as const, profileType: resolved.typeName };
    }
    return { contentFor: "student" as const, profileType: typeof current === "string" ? current : undefined };
  }

  if (role === "PROFESSIONAL") {
    const professional = await ProfessionalModel.findOne({ accountId }).select("professionName").lean();
    const current = professional?.professionName;

    const resolved = await resolveTypeNameFromMaybeId(current);
    if (resolved?.category === "PROFESSIONAL") {
      await ProfessionalModel.updateOne({ accountId }, { $set: { professionName: resolved.typeName } });
      return { contentFor: "professional" as const, profileType: resolved.typeName };
    }
    return { contentFor: "professional" as const, profileType: typeof current === "string" ? current : undefined };
  }

  return { contentFor: undefined, profileType: undefined };
}

