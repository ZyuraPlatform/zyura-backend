import { model, Schema } from "mongoose";
import { T_Goal, TAccuracy } from "./goal.interface";

// goal.schema.ts — replace SelectedSubjectSchema

const SelectedTopicSchema = new Schema(
  {
    topicName: { type: String, required: true },
    subTopicNames: { type: [String], default: [] },
    fullTopic: { type: Boolean, default: false },
  },
  { _id: false }
);

const SelectedSystemSchema = new Schema(
  {
    systemName: { type: String, required: true },
    topics: { type: [SelectedTopicSchema], default: [] },
    fullSystem: { type: Boolean, default: false },
  },
  { _id: false }
);

const SelectedSubjectSchema = new Schema(
  {
    subjectName: { type: String, required: true },
    systemNames: { type: [String], default: [] }, // kept for backward compat
    systems: { type: [SelectedSystemSchema], default: [] }, // full hierarchy
    fullSubject: { type: Boolean, default: false },
  },
  { _id: false }
);

const goal_schema = new Schema<T_Goal>(
  {
    goalName: {
      type: String,
      required: true,
      trim: true,
    },
    studyHoursPerDay: {
      type: Number,
      required: true,
      min: 0,
    },
    startDate: {
      type: String,
      required: true,
    },
    endDate: {
      type: String,
      required: true,
    },
    selectedSubjects: {
      type: [SelectedSubjectSchema],
      required: true,
      default: [],
    },
    studentId: { type: String, required: true },
    goalStatus: {
      type: String,
      enum: ["EXPIRED", "IN_PROGRESS", "COMPLETED"],
      default: "IN_PROGRESS",
    },

    // accuracy: { type: Number, default: 0 },
    totalMcqs: { type: Number, default: 0 },
    totalCompletedMcqs: { type: Number, default: 0 },
    totalClinicalCases: { type: Number, default: 0 },
    totalCompletedClinicalCases: { type: Number, default: 0 },
    totalOsces: { type: Number, default: 0 },
    totalCompletedOsces: { type: Number, default: 0 },
    totalNotes: { type: Number, default: 0 },
    totalCompletedNotes: { type: Number, default: 0 },
    totalFlashcards: { type: Number, default: 0 },
    totalCompletedFlashcards: { type: Number, default: 0 },

    totalCompletedStudyHours: { type: Number, default: 0 },
    todayStudyHours: { type: Number, default: 0 },
    todayStudyDate: { type: String },
    totalMcqStudyHours: { type: Number, default: 0 },
    totalClinicalCaseStudyHours: { type: Number, default: 0 },
    totalOsceStudyHours: { type: Number, default: 0 },
    streak: { type: Number, default: 0 },
    lastStreakDate: { type: String },
    // oldAttempted: { type: Number, default: 0 },
    // oldCorrect: { type: Number, default: 0 },
    // oldIncorrect: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

const countSchema = new Schema(
  {
    totalAttempted: { type: Number, default: 0 },
    totalCorrect: { type: Number, default: 0 },
    totalIncorrect: { type: Number, default: 0 },
  },
  { _id: false, timestamps: false, versionKey: false },
);

const accuracy_schema = new Schema<TAccuracy>(
  {
    accountId: { type: Schema.Types.ObjectId, required: true, ref: "account" },
    mcq: countSchema,
    clinicalCase: countSchema,
    osce: countSchema,
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export const goal_model = model("goal", goal_schema);
export const accuracy_model = model("accuracy", accuracy_schema);
