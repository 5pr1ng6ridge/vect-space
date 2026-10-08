import type { ChapterMapDefinition } from "../../types";

export type MapKind = "hotspot" | "decoration";

export type MapSelection = { kind: MapKind; id: string } | null;

export interface MapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MapObjectEntry =
  | { kind: "decoration"; item: ChapterMapDefinition["decorations"][number] }
  | { kind: "hotspot"; item: ChapterMapDefinition["hotspots"][number] };
