import type { Metadata } from "next";
import { SharedWorkspace } from "./shared-workspace";

export const metadata: Metadata = {
  title: "Shared item · Cloud Storage",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function SharedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SharedWorkspace id={id} />;
}
