import { onlineUsers, getIO } from "../../../socket";

export const notifyAdminsOnNewReport = (reportData: any) => {
  try {
    const io = getIO();
    console.log("=== NOTIFY ADMINS CALLED ===");
    console.log("Total online users:", onlineUsers.size);
    console.log("All online users:", [...onlineUsers.entries()]);
    
    onlineUsers.forEach((userData, socketId) => {
      console.log(`Checking socket ${socketId}, role: "${userData.role}"`);
      if (userData.role === "ADMIN") {
        console.log(`Emitting to admin socket: ${socketId}`);
        io.to(socketId).emit("new-report", reportData);
      }
    });
  } catch (err) {
    console.error("Failed to notify admins about new report:", err);
  }
};

