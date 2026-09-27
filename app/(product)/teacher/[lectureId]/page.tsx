import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { lectureMediaUrl } from "@/lib/media";
import { loadClassReport } from "@/lib/teacher";
import TeacherView from "@/components/TeacherView";

export const metadata: Metadata = {
  title: "Teacher view · Inkling",
  description: "Where did the class get lost? Anonymous class hesitation and erasing over a lecture.",
};

export default async function TeacherPage(props: PageProps<"/teacher/[lectureId]">) {
  // Always the class as it is now (never prerendered).
  await connection();
  const { lectureId } = await props.params;
  const report = await loadClassReport(lectureId);
  if (!report) notFound();
  return <TeacherView report={report} mediaSrc={lectureMediaUrl(report.lecture.id)} />;
}
