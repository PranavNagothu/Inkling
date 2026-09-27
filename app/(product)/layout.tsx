import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Display serif used only for the wordmark and page titles.
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Inkling",
  description: "Every other app deletes your mistakes. We keep them.",
};

export const viewport: Viewport = {
  themeColor: "#fbfbf8",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
};

// Root layout of the app itself (/app, /session, /review, …). The marketing page (/welcome) has its
// own root layout and stylesheet in app/(marketing), so the two sites' CSS never meets.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col text-ink">{children}</body>
    </html>
  );
}
