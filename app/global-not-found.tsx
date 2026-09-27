// 404 for URLs that match no route at all. The site has two root layouts (app/(marketing) and
// app/(product)), so this page brings its own document, fonts and the app's stylesheet.
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { NotFoundScreen } from "@/components/StatusScreen";
import "./(product)/globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const instrumentSerif = Instrument_Serif({ variable: "--font-instrument-serif", weight: "400", subsets: ["latin"] });

export const metadata: Metadata = { title: "Not found · Inkling" };
export const viewport: Viewport = { themeColor: "#fbfbf8", colorScheme: "light" };

export default function GlobalNotFound() {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col text-ink">
        <NotFoundScreen />
      </body>
    </html>
  );
}
