import { Request } from "express";
import { report_model } from "./report.schema";
import { getIO, onlineUsers } from "../../../socket";

const get_all_report_from_db_for_admin = async (req: Request): Promise<any> => {
  const { page = "1", limit = "10", searchTerm = "", status = "" } = req.query;

  const pageNumber = parseInt(page as string);
  const pageSize = parseInt(limit as string);
  const skip = (pageNumber - 1) * pageSize;

  const filter: any = {};

  if (searchTerm) {
    const regex = new RegExp(searchTerm as string, "i");
    filter.$or = [
      { name: { $regex: regex } },
      { "report.questionBankId": { $regex: regex } },
      { "report.mcqId": { $regex: regex } },
      { "report.text": { $regex: regex } }
    ];
  }

  if (status) {
    filter.status = status;
  }

  const result = await report_model
    .find(filter)
    .skip(skip)
    .limit(pageSize)
    .sort({ createdAt: -1 })
    .lean();

  const total = await report_model.countDocuments(filter);

  const meta = {
    page: pageNumber,
    limit: pageSize,
    skip,
    total,
    totalPages: Math.ceil(total / pageSize),
  };

  return { data: result, meta };
};

const get_all_report_for_reporter_from_db = async (req: Request): Promise<any> => {
  const accountId = req?.user?.accountId;
  const result = await report_model.find({ accountId }).lean();
  return result;
};

const update_report_status_on_db = async (req: Request): Promise<any> => {
  const { reportId } = req?.params;
  const { status, note = "" } = req?.body;
  const result = await report_model.findByIdAndUpdate(reportId, { status, note }, { new: true });
  return result;
};

const delete_report_from_db = async (reportId: string): Promise<any> => {
  const result = await report_model.findByIdAndDelete({ _id: reportId });
  return result;
};

// ✅ mark single report as read + emit "report-read" to all admin sockets for cross-tab sync
const mark_report_as_read_in_db = async (reportId: string): Promise<any> => {
  const result = await report_model.findByIdAndUpdate(
    reportId,
    { read: true },
    { new: true }
  );

  // Emit to all connected admins — enables cross-tab auto-dismiss
  console.log("🔍 Marking report", reportId, "as read, emitting to admins");
  try {
    const io = getIO();
    onlineUsers.forEach((userData, socketId) => {
      if (userData.role === "ADMIN") {
        io.to(socketId).emit("report-read", {
          reportId,
          // ✅ include questionBankId so frontend can deep-link to report detail page
          questionBankId: result?.report?.questionBankId,
          mcqId: result?.report?.mcqId,
        });
      }
    });
  } catch (err) {
    console.error("Failed to emit report-read event:", err);
  }

  return result;
};

export const report_service = {
  get_all_report_from_db_for_admin,
  get_all_report_for_reporter_from_db,
  update_report_status_on_db,
  delete_report_from_db,
  mark_report_as_read_in_db,
};