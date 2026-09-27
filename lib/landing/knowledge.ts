// The one source of truth for what the landing page says about Inkling: the FAQ accordion, the
// "Ask Inkling" assistant's system prompt (grounding) and its offline keyword matcher all read
// this file. Every claim here must stay true to the app in the parent repository — edit it
// there first, then here.

export interface KnowledgeEntry {
  id: string;
  /** Short topic label (used in the system prompt). */
  topic: string;
  /** The canonical question, as a visitor would ask it. */
  question: string;
  /** A complete, self-contained answer (≤ ~110 words, plain text, no markdown). */
  answer: string;
  /** Extra words that should route a question here in the offline matcher (lower case). */
  keywords: string[];
  /** Shown in the FAQ accordion on the page. */
  faq?: boolean;
}

export const KNOWLEDGE: readonly KnowledgeEntry[] = [
  {
    id: "what",
    topic: "What Inkling is",
    question: "What is Inkling?",
    answer:
      "Inkling is a note-taking canvas for lectures, designed for iPad and Apple Pencil, that keeps what you erase. Erased handwriting stays on the page as dashed ghost ink. Inkling notices where you hesitated, pairs each erase with the correction that replaced it, and links every moment to the second of the lecture it happened in. After class, your session becomes a learning timeline of corrected misconceptions, open gaps and breakthroughs, each with a short AI re-explanation and a check question.",
    keywords: ["inkling", "overview", "product", "purpose", "idea", "summary", "pitch", "elevator"],
    faq: true,
  },
  {
    id: "stuck",
    topic: "How Inkling knows you're stuck (hesitation detection)",
    question: "How does Inkling know I'm stuck?",
    answer:
      "It compares you with yourself, not with a class average. The first couple of minutes of your writing set your personal baseline. After that, Inkling scores each 10-second window on three signals: writing slower than usual, erasing more than usual, and going quiet while the lecturer keeps talking (pen pressure is also used after the session when it's reliable). When the combined score crosses a threshold, that moment is flagged. A live meter on the capture screen shows steady, slowing or stuck as you write.",
    keywords: ["stuck", "confused", "hesitation", "hesitate", "detect", "detection", "baseline", "pause", "slow", "slower", "know", "notice", "signal", "signals", "meter", "struggling", "lost"],
    faq: true,
  },
  {
    id: "ghost",
    topic: "Ghost ink and erase-to-correction pairing",
    question: "What is ghost ink, and how are corrections detected?",
    answer:
      "When you erase, Inkling keeps the strokes as dashed ghost ink that you can show or hide in review. It groups erased strokes, then looks for new writing in the same spot within about 20 seconds. If the new ink overlaps the erased area enough, the two are paired as a revision: before and after. That pairing is what turns an erase into a corrected misconception or a breakthrough, instead of a mistake that silently disappears.",
    keywords: ["ghost", "ink", "erase", "erased", "eraser", "rewrite", "correction", "corrections", "corrected", "pairing", "pair", "mistake", "mistakes", "keep", "delete", "revision"],
    faq: true,
  },
  {
    id: "timeline",
    topic: "The learning timeline",
    question: "What is the learning timeline?",
    answer:
      "After a session, Inkling turns your notes into a strip of moments pinned to the lecture's own clock. Corrected misconceptions are places you got something wrong and fixed it. Unresolved gaps are places you slowed down or erased without resolving it. Breakthroughs are corrections you then proved by answering a check question. You can replay the 20 seconds of lecture around any moment, and open gaps carry over into your next session until you resolve them.",
    keywords: ["timeline", "review", "moments", "moment", "gap", "gaps", "breakthrough", "breakthroughs", "misconception", "replay", "progress", "session", "after", "class"],
  },
  {
    id: "reteach",
    topic: "AI re-teach and check questions",
    question: "How does the AI help?",
    answer:
      "For each moment, Inkling reads what you changed (the before and after of your handwriting) and what the lecturer was saying at that second. It then writes a short re-explanation of about 80 words and one multiple-choice check question. Your answer is graded on the server. Get it right and the moment becomes a breakthrough. The app can use Groq, Google Gemini, OpenAI or xAI Grok as its AI provider, and a demo mode runs entirely from saved, hand-checked answers with no network.",
    keywords: ["ai", "reteach", "re-teach", "explanation", "reexplain", "understand", "question", "quiz", "check", "tutor", "help", "model", "llm", "groq", "gemini", "openai", "grok"],
  },
  {
    id: "languages",
    topic: "Languages and voice",
    question: "Which languages does Inkling support?",
    answer:
      "Help cards, check questions and the session recap are available in 10 languages: English, Spanish, Hindi, Mandarin Chinese, Arabic, French, Telugu, Korean, Vietnamese and Brazilian Portuguese. Arabic is shown right to left. Any re-explanation can be read aloud, using an ElevenLabs voice when one is configured, and the browser's own voice otherwise. Inkling also speaks a short, encouraging recap of each session.",
    keywords: ["language", "languages", "spanish", "hindi", "chinese", "mandarin", "arabic", "french", "telugu", "korean", "vietnamese", "portuguese", "english", "translate", "translation", "esl", "voice", "audio", "read", "aloud", "speak", "recap", "elevenlabs", "multilingual"],
    faq: true,
  },
  {
    id: "notability",
    topic: "Notability relationship",
    question: "Does it work with Notability?",
    answer:
      "Yes, alongside it rather than instead of it. Compare with Notability takes a PDF export of the same notes from Notability and lays Inkling's process over the final page, side by side or with an overlay slider, and counts what the final page hides: erased attempts, corrections, open gaps and breakthroughs. Export for Notability downloads a session as a PDF you can open in Notability, with ghost ink, labelled moments and a page of re-explanations.",
    keywords: ["notability", "pdf", "export", "import", "compare", "comparison", "goodnotes", "notes", "app", "send", "overlay", "integration", "integrate"],
    faq: true,
  },
  {
    id: "privacy",
    topic: "Privacy and data",
    question: "Is my data private?",
    answer:
      "Inkling is local-first. By default everything is stored in a SQLite file on the computer that runs Inkling, or in a Postgres database you choose, such as Tiger Data. AI provider keys stay on the server and are never logged. When an AI provider is configured, only what a moment needs is sent: the lecture excerpt and the before and after of that revision. Inkling uses the microphone only in Live lecture mode, after you press Start; your browser's speech service does the transcribing. The teacher view is anonymous, and demo mode never touches the network. Handwriting and lecture text are treated as untrusted data in every AI prompt.",
    keywords: ["privacy", "private", "data", "secure", "security", "safe", "stored", "storage", "store", "share", "sharing", "sold", "sell", "tracking", "gdpr", "ferpa", "local", "keys", "who", "see", "microphone", "mic", "camera"],
    faq: true,
  },
  {
    id: "teacher",
    topic: "Teacher view (anonymous, k ≥ 3)",
    question: "What do teachers see?",
    answer:
      "The teacher view shows where a class slowed down or started erasing, on the lecture's own timeline, in 30-second buckets, and suggests the three stretches most worth re-teaching with the lecture excerpt for each. It is anonymous by design: no names, ids or handwriting leave the analysis, a count is only shown once at least three students share a moment (k-anonymity, k ≥ 3), and a class smaller than three gets no view at all.",
    keywords: ["teacher", "teachers", "instructor", "professor", "class", "classroom", "heatmap", "students", "anonymous", "anonymity", "aggregate", "k", "school", "educator"],
    faq: true,
  },
  {
    id: "signal-lab",
    topic: "Signal Lab and measured evaluation",
    question: "How accurate is the detection?",
    answer:
      "Signal Lab lets you inspect which signals fired for each moment and why. Detection has been checked against hand labels of where a student was confused, but only on a small labeled demo set, not a benchmark, so treat a flagged moment as a strong hint rather than a verdict. The in-app evaluation page at /insights/evaluation shows the details, including how the threshold changes what gets flagged.",
    keywords: ["accurate", "accuracy", "precision", "recall", "evaluation", "evaluate", "measured", "metrics", "signal", "lab", "benchmark", "false", "positive", "reliable", "tested", "works"],
    faq: true,
  },
  {
    id: "lectures",
    topic: "Lectures and transcripts",
    question: "Which lectures can I use?",
    answer:
      "Inkling ships with a short demo lecture on the chain rule. You can add your own audio or video lecture with captions (.vtt or .srt), or let it transcribe the audio with Whisper when an OpenAI or Groq key is set. In class, Live lecture mode transcribes the lecturer through your microphone as you write. Uploads are capped at 25 MB. Every stroke is stamped with the lecture second it belongs to, which is how each moment links back to exactly what was being said.",
    keywords: ["lecture", "lectures", "video", "audio", "upload", "captions", "transcript", "transcribe", "whisper", "youtube", "recording", "record", "course", "mit", "live", "class", "in-person"],
  },
  {
    id: "devices",
    topic: "Devices and requirements",
    question: "What devices does it work on?",
    answer:
      "Inkling is designed for iPad and Apple Pencil, where pressure and speed give the richest signals. It runs in a modern web browser, so it also works with touch or a mouse, with fewer signals to read. You open it from a laptop that is serving the app, or from any device on the same network.",
    keywords: ["ipad", "pencil", "apple", "device", "devices", "tablet", "android", "windows", "mac", "laptop", "phone", "mouse", "touch", "browser", "stylus", "requirements"],
  },
  {
    id: "try",
    topic: "How to try it",
    question: "How do I try Inkling?",
    answer:
      "Use Open Inkling at the top of this page, or watch the three-minute demo. To run it yourself, the source is on GitHub: npm install, then npm run dev. npm run demo seeds a sample student's sessions and serves a production build that works with no network at all, which is ideal for trying it on an iPad over local Wi-Fi.",
    keywords: ["try", "start", "started", "demo", "install", "run", "download", "github", "source", "code", "open", "signup", "sign", "account", "access", "use", "get"],
    faq: true,
  },
  {
    id: "tech",
    topic: "Technology and partners",
    question: "What is Inkling built with?",
    answer:
      "Inkling is a Next.js app. AI help runs through one OpenAI-compatible client that works with Groq, Google Gemini, OpenAI or xAI Grok, with strict structured output, a 10-second deadline and rate limits. ElevenLabs provides read-aloud voices. Data lives in SQLite by default or in Postgres on Tiger Data, where a TimescaleDB hypertable and continuous aggregate power the class heatmap. Notability is supported through PDF compare and export.",
    keywords: ["built", "stack", "tech", "technology", "nextjs", "next", "react", "groq", "gemini", "elevenlabs", "tiger", "timescale", "timescaledb", "postgres", "sqlite", "database", "sponsor", "partners", "powered"],
  },
  {
    id: "pricing",
    topic: "Cost",
    question: "How much does it cost?",
    answer:
      "There's no pricing information to share. The source is on GitHub and you can run it yourself for free. Using live AI help or premium voices needs your own provider keys, which have their own costs, while demo mode needs none.",
    keywords: ["price", "pricing", "cost", "costs", "free", "pay", "paid", "subscription", "plan", "plans", "money", "cheap", "license"],
  },
  {
    id: "limits",
    topic: "Limitations",
    question: "What are Inkling's limitations?",
    answer:
      "Detection is tuned on a small labeled demo set, so treat it as a strong hint, not a verdict. Corrections made in the first couple of minutes fall inside the baseline period, where hesitation spikes are never flagged by design, though erase-and-rewrite pairing still catches them. Live AI help needs a provider key. Uploads are limited to 25 MB. The teacher view needs at least three students on a lecture.",
    keywords: ["limitation", "limitations", "limits", "weakness", "downside", "cons", "wrong", "fail", "fails", "miss", "misses", "caveat", "problems"],
  },
];

/** The FAQ accordion, in page order. */
export const FAQ_ENTRIES = KNOWLEDGE.filter((e) => e.faq);

/** Starter chips in the assistant. */
export const STARTER_QUESTIONS = [
  "How does Inkling know I'm stuck?",
  "Does it work with Notability?",
  "Is my data private?",
  "Which languages?",
] as const;

/** The knowledge base as compact plain text for the system prompt. */
export function knowledgeAsText(entries: readonly KnowledgeEntry[] = KNOWLEDGE): string {
  return entries.map((e) => `## ${e.topic}\nQ: ${e.question}\nA: ${e.answer}`).join("\n\n");
}
