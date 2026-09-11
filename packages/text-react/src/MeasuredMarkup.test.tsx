import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MeasuredMarkup } from "./MeasuredMarkup";

describe("MeasuredMarkup visibility boundaries", () => {
  it("lets a hidden parent suppress revealed units without changing layout", () => {
    const root = document.createElement("div");
    root.style.visibility = "hidden";
    root.innerHTML = renderToStaticMarkup(
      <MeasuredMarkup source="已排版但应随容器隐藏" />,
    );
    document.body.append(root);

    const unit = root.querySelector<HTMLElement>(".markup-preview-character");
    expect(unit?.style.visibility).toBe("inherit");
    expect(getComputedStyle(unit as HTMLElement).visibility).toBe("hidden");

    root.remove();
  });
});
