import {
  MeasuredMarkup,
  type MeasuredMarkupProps,
} from "@vectspace/text-react";
import type { TextLayoutSnapshot, TextRevealAnimation } from "@vectspace/text";
import type { CSSProperties, ReactElement } from "react";

/** Backwards-compatible editor name backed by the shared text surface. */
export interface MarkupPreviewProps {
  source: string;
  onLayout?(layout: TextLayoutSnapshot): void;
  className?: string;
  style?: CSSProperties;
  fontFamily?: string;
  fontReady?: boolean;
  measurementScale?: number;
  visibleCount?: number;
  revealAnimation?: TextRevealAnimation;
}

export function MarkupPreview({
  source,
  onLayout,
  className,
  style,
  fontFamily,
  fontReady,
  measurementScale,
  visibleCount,
  revealAnimation,
}: MarkupPreviewProps): ReactElement {
  const props: MeasuredMarkupProps = {
    source,
    onLayout,
    className,
    style,
    fontFamily,
    fontReady,
    measurementScale,
    visibleCount,
    reveal: revealAnimation,
  };
  return <MeasuredMarkup {...props} />;
}
