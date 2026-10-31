import { snapMap } from "@vectspace/presentation-core/chapter-map";

export const GRID = 20;
export const MIN_ROOM = 1920;
export const MAX_ROOM = 16380;

export const snap = (value: number): number => snapMap(value, GRID);
