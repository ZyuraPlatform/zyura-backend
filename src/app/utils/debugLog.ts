import http from "http";

type DebugPayload = {
  sessionId: string;
  runId: string;
  hypothesisId: string;
  location: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
};

const ENDPOINT = "http://127.0.0.1:7814/ingest/edff79c1-8132-4b71-8fef-10a009c1a311";
const SESSION_ID = "435ba6";

export function debugLog(payload: Omit<DebugPayload, "sessionId" | "timestamp"> & Partial<Pick<DebugPayload, "timestamp">>) {
  try {
    const body = JSON.stringify({
      sessionId: SESSION_ID,
      timestamp: payload.timestamp ?? Date.now(),
      runId: payload.runId,
      hypothesisId: payload.hypothesisId,
      location: payload.location,
      message: payload.message,
      data: payload.data ?? {},
    });

    const req = http.request(
      ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": SESSION_ID,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        // Drain to avoid socket hangups; ignore output.
        res.on("data", () => {});
        res.on("end", () => {});
      },
    );

    req.on("error", () => {});
    req.write(body);
    req.end();
  } catch {
    // Never throw from debug logging.
  }
}

