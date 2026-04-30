import { onlineUsers, getIO } from "../../../socket";

export const notifyAdminsOnNewReport = (reportData: any) => {
  try {
    const io = getIO();
    console.log("=== NOTIFY ADMINS CALLED ===");
    console.log("Total online users:", onlineUsers.size);
    console.log("All online users:", [...onlineUsers.entries()]);

    // ✅ Only emit if report is not already marked as read
    if (reportData?.read === true) {
      console.log("Report already read, skipping notification.");
      return;
    }

    onlineUsers.forEach((userData, socketId) => {
      console.log(`Checking socket ${socketId}, role: "${userData.role}"`);
      if (userData.role === "ADMIN") {
        console.log(`Emitting to admin socket: ${socketId}`);
        io.to(socketId).emit("new-report", reportData);
        console.log("✅ Emitted new-report to admin", socketId, ":", reportData._id);
      }
    });
  } catch (err) {
    console.error("Failed to notify admins about new report:", err);
  }
};