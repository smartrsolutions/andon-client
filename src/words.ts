/**
 * The words a refusal uses for the parts of an update. The same rules run behind
 * two interfaces: AndonView.set(tileId, value, { at, series, lane }) here, and
 * msg.topic / msg.payload / msg.timestamp in the Node-RED package. An error has to
 * name what the person in front of it actually wrote, so the runtime takes the
 * words from its caller.
 */
export interface Words {
    /** what names the tile */
    topic: string;
    /** what carries the value */
    payload: string;
    /** what carries a sample's or a segment's time */
    timestamp: string;
    /** what picks a series by name */
    series: string;
    /** what picks a timeline lane by name */
    lane: string;
    /** how a template gets to the runtime, for "there is no template yet: ..." */
    template: string;
}

/** The words of this package's own API. */
export const API_WORDS: Readonly<Words> = Object.freeze({
    topic: 'the tile ID',
    payload: 'the value',
    timestamp: 'options.at',
    series: 'options.series',
    lane: 'options.lane',
    template: 'pass one as the template option',
});

/** The words of the Node-RED package: a message's properties. */
export const NODE_RED_WORDS: Readonly<Words> = Object.freeze({
    topic: 'msg.topic',
    payload: 'msg.payload',
    timestamp: 'msg.timestamp',
    series: 'msg.series',
    lane: 'msg.lane',
    template: 'import one in the view',
});
