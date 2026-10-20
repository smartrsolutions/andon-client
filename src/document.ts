/**
 * A view document, as loose as the runtime needs it. The full shape is the view
 * schema (schema/view-v1.schema.json); the validator holds a document to it before
 * anything is sealed, so the types here describe only what the code reads.
 */

/** One tile. Its fields depend on its kind (`view`); see the view schema. */
export interface Tile {
    id: string;
    view: string;
    status?: string | null;
    [field: string]: any;
}

/** A view document: what the configurator's template is, and what gets sealed. */
export interface ViewDocument {
    tiles: Tile[];
    generatedAt?: string;
    staleAfterSec?: number;
    [field: string]: any;
}
