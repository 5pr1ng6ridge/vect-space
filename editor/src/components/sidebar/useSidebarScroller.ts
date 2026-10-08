import { useCallback, type UIEventHandler } from "react";
import type { SidebarScrollStore } from "../projectSections";
import type { SidebarTab } from "./types";

/**
 * Restore the host-owned scroll offset for `tab` exactly when the element that
 * owns the scrollbar mounts.  A callback ref is used instead of an effect
 * because the problems panel is rendered conditionally: an effect owned by the
 * sidebar runs once at first mount, when the ref is still null, and never
 * reruns on an ordinary tab switch.  The callback ref fires on every attach, so
 * it covers tab switches inside the sidebar, conditional panels appearing, and
 * keyframe/full-screen workspace remounts, and it runs during commit (before
 * paint), so there is no flash of the panel top.
 *
 * `store` is ref-shaped host state with a stable identity, so the callback ref
 * is not re-created on re-render and the offset is not re-applied mid-scroll.
 */
export function useSidebarScroller(
  tab: SidebarTab,
  store: SidebarScrollStore | undefined,
  onScrollOffset?: (tab: SidebarTab, offset: number) => void,
): {
  onScroll: UIEventHandler<HTMLDivElement>;
  ref(node: HTMLDivElement | null): void;
} {
  const offsets = store?.current;
  const ref = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node === null) return;
      node.scrollTop = offsets?.[tab] ?? 0;
    },
    [offsets, tab],
  );
  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      onScrollOffset?.(tab, event.currentTarget.scrollTop);
    },
    [onScrollOffset, tab],
  );
  return { onScroll, ref };
}
