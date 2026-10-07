/**
 * Package-resolved KaTeX woff2 URLs.
 *
 * Static `?url` imports are resolved by Vite through the `katex` package from
 * this file, so they behave the same under every Vite root (the game root and
 * `editor/`) in the dev server and in a production build.  A root-relative
 * `import.meta.glob("/node_modules/...")` depends on the root instead and
 * silently yields an empty map when the root is `editor/`.
 */

import fontAmsRegular from "katex/dist/fonts/KaTeX_AMS-Regular.woff2?url";
import fontCaligraphicBold from "katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?url";
import fontCaligraphicRegular from "katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?url";
import fontFrakturBold from "katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?url";
import fontFrakturRegular from "katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?url";
import fontMainBold from "katex/dist/fonts/KaTeX_Main-Bold.woff2?url";
import fontMainBoldItalic from "katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?url";
import fontMainItalic from "katex/dist/fonts/KaTeX_Main-Italic.woff2?url";
import fontMainRegular from "katex/dist/fonts/KaTeX_Main-Regular.woff2?url";
import fontMathBoldItalic from "katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?url";
import fontMathItalic from "katex/dist/fonts/KaTeX_Math-Italic.woff2?url";
import fontSansSerifBold from "katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?url";
import fontSansSerifItalic from "katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?url";
import fontSansSerifRegular from "katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?url";
import fontScriptRegular from "katex/dist/fonts/KaTeX_Script-Regular.woff2?url";
import fontSize1Regular from "katex/dist/fonts/KaTeX_Size1-Regular.woff2?url";
import fontSize2Regular from "katex/dist/fonts/KaTeX_Size2-Regular.woff2?url";
import fontSize3Regular from "katex/dist/fonts/KaTeX_Size3-Regular.woff2?url";
import fontSize4Regular from "katex/dist/fonts/KaTeX_Size4-Regular.woff2?url";
import fontTypewriterRegular from "katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?url";

/** Keyed by the file name `katex.min.css` references as `fonts/<name>`. */
export const KATEX_FONT_URLS: Readonly<Record<string, string>> = {
  "KaTeX_AMS-Regular.woff2": fontAmsRegular,
  "KaTeX_Caligraphic-Bold.woff2": fontCaligraphicBold,
  "KaTeX_Caligraphic-Regular.woff2": fontCaligraphicRegular,
  "KaTeX_Fraktur-Bold.woff2": fontFrakturBold,
  "KaTeX_Fraktur-Regular.woff2": fontFrakturRegular,
  "KaTeX_Main-Bold.woff2": fontMainBold,
  "KaTeX_Main-BoldItalic.woff2": fontMainBoldItalic,
  "KaTeX_Main-Italic.woff2": fontMainItalic,
  "KaTeX_Main-Regular.woff2": fontMainRegular,
  "KaTeX_Math-BoldItalic.woff2": fontMathBoldItalic,
  "KaTeX_Math-Italic.woff2": fontMathItalic,
  "KaTeX_SansSerif-Bold.woff2": fontSansSerifBold,
  "KaTeX_SansSerif-Italic.woff2": fontSansSerifItalic,
  "KaTeX_SansSerif-Regular.woff2": fontSansSerifRegular,
  "KaTeX_Script-Regular.woff2": fontScriptRegular,
  "KaTeX_Size1-Regular.woff2": fontSize1Regular,
  "KaTeX_Size2-Regular.woff2": fontSize2Regular,
  "KaTeX_Size3-Regular.woff2": fontSize3Regular,
  "KaTeX_Size4-Regular.woff2": fontSize4Regular,
  "KaTeX_Typewriter-Regular.woff2": fontTypewriterRegular,
};
