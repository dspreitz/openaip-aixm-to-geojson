import { XMLParser } from 'fast-xml-parser';

const TEXT_KEY = '#text';
const ATTRS_KEY = ':@';

/**
 * Parses an XML string into a lightweight, ORDER PRESERVING tree of
 * `{ name, attrs, text, children }` nodes.
 *
 * Order matters: a `gml:segments` element mixes `GeodesicString`, `ArcByCenterPoint`
 * and `LineStringSegment` children and the sequence defines the ring. The "compact"
 * modes of xml-js/fast-xml-parser group children by tag name and therefore lose it.
 *
 * @param {string|Buffer} xml
 * @return {Object[]}
 */
export function parseXml(xml) {
    const parser = new XMLParser({
        preserveOrder: true,
        ignoreAttributes: false,
        attributeNamePrefix: '',
        parseTagValue: false,
        parseAttributeValue: false,
        trimValues: true,
    });

    return normalizeNodes(parser.parse(xml));
}

/**
 * @param {Object[]} rawNodes
 * @return {Object[]}
 */
function normalizeNodes(rawNodes) {
    const nodes = [];
    for (const rawNode of rawNodes) {
        const name = Object.keys(rawNode).find((key) => key !== ATTRS_KEY);
        if (name == null || name === TEXT_KEY) continue;

        nodes.push({
            name,
            attrs: rawNode[ATTRS_KEY] ?? {},
            text: joinText(rawNode[name]),
            children: normalizeNodes(rawNode[name]),
        });
    }

    return nodes;
}

/**
 * @param {Object[]} rawChildren
 * @return {string|null}
 */
function joinText(rawChildren) {
    let text = '';
    for (const rawChild of rawChildren) {
        if (Object.hasOwn(rawChild, TEXT_KEY)) text += String(rawChild[TEXT_KEY]);
    }

    return text.length === 0 ? null : text;
}

/**
 * @param {Object} node
 * @param {string} name
 * @return {Object[]}
 */
export function children(node, name) {
    return node == null ? [] : node.children.filter((child) => child.name === name);
}

/**
 * @param {Object} node
 * @param {string} name
 * @return {Object|null}
 */
export function child(node, name) {
    return node == null ? null : node.children.find((child) => child.name === name) ?? null;
}

/**
 * Walks a chain of single child elements, e.g. path(node, 'aixm:timeSlice', 'aixm:AirspaceTimeSlice').
 *
 * @param {Object} node
 * @param {...string} names
 * @return {Object|null}
 */
export function path(node, ...names) {
    let current = node;
    for (const name of names) {
        current = child(current, name);
        if (current == null) return null;
    }

    return current;
}

/**
 * Returns the text content of the element at the given path. Elements carrying
 * `xsi:nil="true"` have no text and yield `null`.
 *
 * @param {Object} node
 * @param {...string} names
 * @return {string|null}
 */
export function text(node, ...names) {
    const found = names.length === 0 ? node : path(node, ...names);

    return found?.text ?? null;
}
