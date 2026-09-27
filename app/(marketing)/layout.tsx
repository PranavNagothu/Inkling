import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { PageBackground } from "@/components/landing/PageBackground";
import "./globals.css";

// Fonts are downloaded at build time and self-hosted by next/font (no runtime font requests).
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
});

/**
 * Absolute base for og:image and friends. Set NEXT_PUBLIC_SITE_URL for a custom domain; on Vercel
 * the production URL is used automatically; locally it falls back to the dev server.
 */
function siteUrl(): URL {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return new URL(explicit);
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return new URL(`https://${vercel}`);
  return new URL(`http://localhost:${process.env.PORT || 3000}`);
}

const title = "Inkling — Handwriting intelligence for learners";
const description =
  "Inkling keeps what you erase. It reads how you write during a lecture — the pauses, the erasing, the rewrites — and turns them into a learning timeline of mistakes you fixed, gaps you still have, and the lecture moment behind each one.";

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title,
  description,
  applicationName: "Inkling",
  keywords: ["note-taking", "handwriting", "lecture notes", "iPad", "Apple Pencil", "learning analytics", "Notability", "study tools"],
  alternates: { canonical: "/welcome" },
  openGraph: {
    type: "website",
    siteName: "Inkling",
    title,
    description,
    url: "/welcome",
    images: [
      {
        url: "/inkling-demo-poster.jpg",
        width: 1280,
        height: 800,
        alt: "Inkling's review screen: an erased answer kept as dashed ghost ink under the rewrite, flagged as a corrected misconception.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/inkling-demo-poster.jpg"],
  },
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#fbfbf8",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Inkling",
  applicationCategory: "EducationalApplication",
  operatingSystem: "Web (designed for iPad and Apple Pencil)",
  description,
};

// Root layout of the marketing page (/welcome): its own stylesheet, fonts and the live pearl
// background. The app (/app, /session, …) has a separate root layout in app/(product).
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} antialiased`}
    >
      <body className="min-h-dvh text-ink">
        <PageBackground />
        {children}
        <script
          type="application/ld+json"
          // Static, build-time JSON (no user input).
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
        />
      </body>
    </html>
  );
}
