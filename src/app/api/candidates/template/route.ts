import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { apiHandler, requireUser } from "@/lib/authz";

// Blank sample sheet for candidate import (meeting 00:58: "sample sheet format download").
export const GET = apiHandler(async () => {
  await requireUser();
  const rows = [
    { Name: "Aarav Sharma", Phone: "9876543210", "Alt Phone": "", Gender: "Male", Source: "Mobiliser - Ramesh" },
    { Name: "Kavya Singh", Phone: "9876543211", "Alt Phone": "9876500000", Gender: "Female", Source: "Campaign - August" },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Candidates");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="candidate-import-template.xlsx"',
    },
  });
});
