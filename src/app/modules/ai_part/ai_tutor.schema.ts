import { Schema, model } from "mongoose";

export type AiTutorMessage = {
  type: "HumanMessage" | "AIMessage";
  content: string;
  createdAt: Date;
};

export type AiTutorThread = {
  accountId: string;
  thread_id: string;
  session_title: string;
  messages: AiTutorMessage[];
  createdAt: Date;
  updatedAt: Date;
};

const MessageSchema = new Schema<AiTutorMessage>(
  {
    type: { type: String, enum: ["HumanMessage", "AIMessage"], required: true },
    content: { type: String, required: true },
    createdAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const AiTutorThreadSchema = new Schema<AiTutorThread>(
  {
    accountId: { type: String, required: true, index: true },
    thread_id: { type: String, required: true, unique: true, index: true },
    session_title: { type: String, required: true },
    messages: { type: [MessageSchema], default: [] },
  },
  { timestamps: true, versionKey: false },
);

export const ai_tutor_thread_model = model<AiTutorThread>("ai_tutor_thread", AiTutorThreadSchema);

