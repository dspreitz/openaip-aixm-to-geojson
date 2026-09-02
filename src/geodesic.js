import geographiclib from 'geographiclib-geodesic';

/*
 All distance/azimuth maths runs on the WGS84 ellipsoid via GeographicLib.

 This is not pedantry. turf's `destination`/`circle` use a sphere of radius 6371008.8 m,
 while DFS computes its arcs on the ellipsoid. Measured against the DFS dataset, the
 spherical model misses the neighbouring vertex of an arc by 0.18 % of the radius on
 average and by up to 0.47 % - roughly 300 m on a 34 NM arc (LEIPZIG TMZ C). GeographicLib
 reduces that to millimetres.
*/
const GEODESIC = geographiclib.Geodesic.WGS84;

/**
 * @param {number[]} position - GeoJSON position [lon, lat]
 * @param {number} azimuthDegrees - measured clockwise from true north
 * @param {number} distanceMeters
 * @return {number[]} GeoJSON position
 */
export function destination(position, azimuthDegrees, distanceMeters) {
    const result = GEODESIC.Direct(position[1], position[0], azimuthDegrees, distanceMeters);

    return [result.lon2, result.lat2];
}

/**
 * @param {number[]} from - GeoJSON position [lon, lat]
 * @param {number[]} to - GeoJSON position [lon, lat]
 * @return {{distanceMeters: number, azimuthDegrees: number}}
 */
export function inverse(from, to) {
    const result = GEODESIC.Inverse(from[1], from[0], to[1], to[0]);

    return { distanceMeters: result.s12, azimuthDegrees: result.azi1 };
}

/**
 * @param {number[]} from
 * @param {number[]} to
 * @return {number}
 */
export function distanceMeters(from, to) {
    return GEODESIC.Inverse(from[1], from[0], to[1], to[0]).s12;
}
