// The 10 languages Inkling's help comes in (same list as the app's lib/ai/languages.ts), each with
// the same sample re-explanation of the chain-rule mistake d/dx sin(x²) = cos(x²): pre-written,
// static strings (no AI call on the landing page). Arabic wraps the maths in Unicode isolates
// (U+2066…U+2069) so the formulas stay left-to-right inside right-to-left text.

export interface LandingLanguage {
  code: string;
  name: string;
  native: string;
  rtl?: boolean;
  sample: string;
}

const LRI = "\u2066";
const PDI = "\u2069";
const m = (s: string) => `${LRI}${s}${PDI}`;

export const LANGUAGES: readonly LandingLanguage[] = [
  {
    code: "es",
    name: "Spanish",
    native: "Español",
    sample: "Olvidaste multiplicar por la derivada interna, 2x. La derivada de sen(x²) es cos(x²) · 2x.",
  },
  {
    code: "hi",
    name: "Hindi",
    native: "हिन्दी",
    sample: "आप आंतरिक फलन के अवकलज 2x से गुणा करना भूल गए। sin(x²) का अवकलज cos(x²) · 2x है।",
  },
  {
    code: "zh",
    name: "Mandarin Chinese",
    native: "中文",
    sample: "你忘了乘以内层函数的导数 2x。sin(x²) 的导数是 cos(x²) · 2x。",
  },
  {
    code: "ar",
    name: "Arabic",
    native: "العربية",
    rtl: true,
    sample: `لقد نسيت الضرب في مشتقة الدالة الداخلية ${m("2x")}. مشتقة ${m("sin(x²)")} هي ${m("cos(x²) · 2x")}.`,
  },
  {
    code: "fr",
    name: "French",
    native: "Français",
    sample: "Tu as oublié de multiplier par la dérivée intérieure, 2x. La dérivée de sin(x²) est cos(x²) · 2x.",
  },
  {
    code: "te",
    name: "Telugu",
    native: "తెలుగు",
    sample: "మీరు లోపలి ఫంక్షన్ డెరివేటివ్ 2x తో గుణించడం మర్చిపోయారు. sin(x²) యొక్క డెరివేటివ్ cos(x²) · 2x.",
  },
  {
    code: "ko",
    name: "Korean",
    native: "한국어",
    sample: "안쪽 함수의 도함수 2x를 곱하는 것을 잊었어요. sin(x²)의 도함수는 cos(x²) · 2x예요.",
  },
  {
    code: "vi",
    name: "Vietnamese",
    native: "Tiếng Việt",
    sample: "Bạn quên nhân với đạo hàm của hàm bên trong, 2x. Đạo hàm của sin(x²) là cos(x²) · 2x.",
  },
  {
    code: "pt",
    name: "Portuguese",
    native: "Português",
    sample: "Você esqueceu de multiplicar pela derivada interna, 2x. A derivada de sen(x²) é cos(x²) · 2x.",
  },
  {
    code: "en",
    name: "English",
    native: "English",
    sample: "You forgot to multiply by the inner derivative, 2x. The derivative of sin(x²) is cos(x²) · 2x.",
  },
];
