/*
 Mapping of AIXM airspace metadata onto the openAIP airspace model.

 Two things make this more than a lookup table:
 - `aixm:type` is coarse. DFS carries the airspace kind an aviator actually cares about
   (RMZ, TMZ, glider sector, parachute area, ...) in `aixm:localType`, so localType
   OVERRIDES the mapped type where it is set.
 - `aixm:activity` adds the sporting/recreational activity, which openAIP models as a
   separate `activity` property.

 Every value below was taken from the DFS ED_Airspace_StrokedBorders snapshot; unknown
 values are reported instead of silently dropped.
*/

const TYPE_MAP = {
    NAS: 'OTHER',
    FIR: 'OTHER',
    FIR_P: 'OTHER',
    UIR: 'OTHER',
    UIR_P: 'OTHER',
    CTA: 'CTA',
    CTA_P: 'CTA',
    UTA: 'CTA',
    UTA_P: 'CTA',
    OCA: 'CTA',
    OCA_P: 'CTA',
    TMA: 'TMA',
    TMA_P: 'TMA',
    CTR: 'CTR',
    CTR_P: 'CTR',
    ATZ: 'ATZ',
    ATZ_P: 'ATZ',
    P: 'PROHIBITED',
    R: 'RESTRICTED',
    D: 'DANGER',
    A: 'DANGER', // alert area - no dedicated openAIP type, closest match
    W: 'WARNING',
    D_OTHER: 'DANGER',
    'OTHER:R_AMC': 'RESTRICTED', // AMC manageable restricted area
    'OTHER:D_AMC': 'DANGER', // AMC manageable danger area
    TSA: 'RESTRICTED',
    TRA: 'RESTRICTED',
    CBA: 'RESTRICTED',
    PROTECT: 'OTHER',
    RAS: 'OTHER',
    SECTOR: 'OTHER',
    SECTOR_C: 'OTHER',
    CLASS: 'OTHER',
    PART: 'OTHER',
    STATE: 'OTHER',
    ENTRY: 'OTHER',
    EXIT: 'OTHER',
    ENTRY_EXIT: 'OTHER',
    ADIZ: 'OTHER',
    AWY: 'OTHER',
    MTR: 'OTHER',
    AMA: 'OTHER',
    ASR: 'OTHER',
    ADV: 'OTHER',
    UADV: 'OTHER',
    HTZ: 'OTHER',
    POLITICAL: 'OTHER',
    NO_FIR: 'OTHER',
    RCA: 'OTHER',
    OTA: 'OTHER',
    OTHER: 'OTHER',
    NAS_P: 'OTHER',
};

// localType wins over type where set.
const LOCAL_TYPE_MAP = {
    RMZ: { type: 'RMZ' },
    TMZ: { type: 'TMZ' },
    ATZ: { type: 'ATZ' },
    GLD: { type: 'GLIDING_SECTOR', activity: 'HANG_GLIDING' },
    PJA: { type: 'AERIAL_SPORTING_RECREATIONAL', activity: 'PARACHUTING' },
    ACR: { type: 'AERIAL_SPORTING_RECREATIONAL', activity: 'AEROBATICS' },
    UAV: { type: 'RESTRICTED' },
    NPZ: { type: 'RESTRICTED' }, // Naturschutzgebiet / noise protection zone
    FBZ: { type: 'OTHER' }, // flight briefing zone
    FRA: { type: 'OTHER' }, // free route airspace
    'DLG-ATS': { type: 'OTHER' },
    'FLIGHT INFORMATION SECTOR': { type: 'OTHER' },
    // Free Route Airspace entry/exit gates (EDGT*) - ATC routing metadata rather than an
    // airspace a pilot enters.
    GT: { type: 'OTHER' },
    // Military low flying areas (ETLFA*). Published as aixm:type=PROTECT. openAIP has no
    // dedicated type for these; mapping them to DANGER would overstate what the AIP says.
    'MIL LOW FLYING AREA': { type: 'OTHER' },
};

const ACTIVITY_MAP = {
    AEROBATICS: 'AEROBATICS',
    PARACHUTE: 'PARACHUTING',
    GLIDING: 'HANG_GLIDING',
    UAV: 'NONE',
    AD_TFC: 'AEROCLUB_AERIAL_WORK',
    GAS: 'NONE',
    // Laser activity areas are coded as danger areas (aixm:type=D_OTHER); openAIP has no
    // matching activity value, so only the DANGER type carries the information.
    LASER: 'NONE',
};

const CLASS_MAP = { A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F', G: 'G', NO: 'UNCLASSIFIED' };

/**
 * @param {Object} input
 * @param {string|null} input.type - `aixm:type`
 * @param {string|null} input.localType - `aixm:localType`
 * @param {string|null} input.airspaceClass - `aixm:class/AirspaceLayerClass/classification`
 * @param {string|null} input.activity - `aixm:activation/AirspaceActivation/activity`
 * @return {{type: string, class: string, activity: string, unmapped: string[]}}
 */
export function mapAirspaceMetadata({ type, localType, airspaceClass, activity }) {
    const unmapped = [];

    let mappedType = TYPE_MAP[type];
    if (mappedType == null) {
        unmapped.push(`type=${type}`);
        mappedType = 'OTHER';
    }

    let mappedActivity = 'NONE';
    if (activity != null) {
        const found = ACTIVITY_MAP[activity];
        if (found == null) unmapped.push(`activity=${activity}`);
        else mappedActivity = found;
    }

    if (localType != null) {
        const override = LOCAL_TYPE_MAP[localType];
        if (override == null) {
            unmapped.push(`localType=${localType}`);
        } else {
            mappedType = override.type;
            if (mappedActivity === 'NONE' && override.activity != null) mappedActivity = override.activity;
        }
    }

    // openAIP requires a class; airspaces without an ICAO classification are "UNCLASSIFIED".
    let mappedClass = 'UNCLASSIFIED';
    if (airspaceClass != null) {
        const found = CLASS_MAP[airspaceClass];
        if (found == null) unmapped.push(`class=${airspaceClass}`);
        else mappedClass = found;
    }

    return { type: mappedType, class: mappedClass, activity: mappedActivity, unmapped };
}
