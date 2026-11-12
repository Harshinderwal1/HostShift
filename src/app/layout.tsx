import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hostshift | Hotel Staffing",
  description: "Temporary shift staffing for independent hotels.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
