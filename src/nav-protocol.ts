// The wire protocol between a page and the client navigation runtime. No
// imports: this file is bundled into the browser and imported by the server.

/** Query parameter a partial-navigation fetch carries (`?fu-partial=1`). */
export const PARTIAL_PARAM = "fu-partial";
/** Query parameter carrying the client's build id on a partial fetch. */
export const BUILD_PARAM = "__b";
/** Response header telling the client to load the destination in full. */
export const BUILD_RELOAD_HEADER = "x-fu-reload";
/**
 * Attribute on `<body>` (or any ancestor of a link) that opts a document into
 * client navigation. Any value but "off" enables; read at click time.
 */
export const NAV_ATTR = "data-fu-nav";
/** Attribute on `<html>` carrying the build id the client stamps on fetches. */
export const BUILD_ATTR = "data-fu-build";
/**
 * The grammar of a `Partial` name, as regex source: lower-case words joined by
 * single hyphens. One definition, so the server that writes a region comment
 * and the client that reads it cannot disagree.
 */
export const REGION_NAME = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
