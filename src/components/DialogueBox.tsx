/* eslint-disable react-refresh/only-export-components -- thin game-facing re-export of the shared gameplay surface */
/**
 * Game-facing alias of the shared gameplay surface.
 *
 * The implementation lives in `@vectspace/presentation-react/gameplay` so the
 * game and the editor gameplay preview render the same dialogue, long-text,
 * button and canvas components.  This module keeps the app's historical import
 * path stable.
 */
export * from "@vectspace/presentation-react/gameplay";
