CREATE TABLE "DevAttendanceCode" (
    "sessionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    CONSTRAINT "DevAttendanceCode_pkey" PRIMARY KEY ("sessionId"),
    CONSTRAINT "DevAttendanceCode_sessionId_fkey" FOREIGN KEY ("sessionId")
        REFERENCES "AttendanceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
