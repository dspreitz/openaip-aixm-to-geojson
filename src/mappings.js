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

/*
 AIXM 4.5 uses a different vocabulary from 5.1, so it gets its own tables rather than
 aliases into the ones above. Every value below was taken from the SIA
 `AIXM4.5_all_FR_OM` data set; unknown values are reported, not silently dropped.

 Two differences worth knowing:
 - The kind of area a French pilot cares about sits in `txtLocalType`, which is free
   text and mostly French abbreviations (AER = aeromodelisme, PJE = parachutage,
   TRPLA = treuillage planeur). As in 5.1 the local type overrides the coarse type.
 - `D-OTHER` is the catch-all the SIA uses for activity zones of every kind; on its own
   it says only "danger area, see the remarks".
*/

const TYPE_MAP_45 = {
    FIR: 'OTHER',
    UIR: 'OTHER',
    'UIR-P': 'OTHER',
    CTA: 'CTA',
    UTA: 'CTA',
    OCA: 'CTA',
    TMA: 'TMA',
    CTR: 'CTR',
    ATZ: 'ATZ',
    P: 'PROHIBITED',
    R: 'RESTRICTED',
    D: 'DANGER',
    'D-OTHER': 'DANGER',
    'R-AMC': 'RESTRICTED',
    'D-AMC': 'DANGER',
    TSA: 'RESTRICTED',
    TRA: 'RESTRICTED',
    CBA: 'RESTRICTED',
    // Delegation and sector areas: airspace whose ATS is delegated to a neighbouring
    // unit, plus the ACC/UAC sectorisation. Both are ATC structure, not something a VFR
    // pilot enters or avoids, so they map to OTHER and keep their name.
    RAS: 'OTHER',
    SECTOR: 'OTHER',
    'SECTOR-C': 'OTHER',
    PART: 'OTHER',
    CLASS: 'OTHER',
    NAS: 'OTHER',
    OTHER: 'OTHER',
};

const LOCAL_TYPE_MAP_45 = {
    AER: { type: 'AERIAL_SPORTING_RECREATIONAL' }, // aeromodelisme - model flying
    PJE: { type: 'AERIAL_SPORTING_RECREATIONAL', activity: 'PARACHUTING' },
    VOL: { type: 'AERIAL_SPORTING_RECREATIONAL', activity: 'AEROBATICS' }, // voltige
    TRPLA: { type: 'AERIAL_SPORTING_RECREATIONAL' }, // treuillage planeur - glider winch
    TRPVL: { type: 'AERIAL_SPORTING_RECREATIONAL' }, // treuillage vol libre
    TRVL: { type: 'AERIAL_SPORTING_RECREATIONAL' }, // treuillage vol libre
    BAL: { type: 'AERIAL_SPORTING_RECREATIONAL', activity: 'BALLOON' },
    RMZ: { type: 'RMZ' },
    TMZ: { type: 'TMZ' },
    'RMZ-TMZ': { type: 'RMZ' },
    // ATC and information structure - no dedicated openAIP type.
    APP: { type: 'OTHER' },
    ACC: { type: 'OTHER' },
    UAC: { type: 'OTHER' },
    LTA: { type: 'OTHER' },
    FRA: { type: 'OTHER' },
    FBZ: { type: 'OTHER' },
    'DLG-ATS': { type: 'OTHER' },
    'FLIGHT INFORMATION SECTOR': { type: 'OTHER' },
    AP: { type: 'OTHER' },
    PRN: { type: 'OTHER' },
    SUR: { type: 'OTHER' },
};

const ACTIVITY_MAP_45 = {
    PARACHUTE: 'PARACHUTING',
    GLIDER: 'GLIDING',
    PARAGLIDER: 'HANG_GLIDING',
    BALLOON: 'BALLOON',
    TOWING: 'AEROCLUB_AERIAL_WORK',
};

/**
 * @param {Object} input
 * @param {string|null} input.type - `Ase/AseUid/codeType`
 * @param {string|null} input.localType - `Ase/txtLocalType`
 * @param {string|null} input.airspaceClass - `Ase/codeClass`
 * @param {string|null} input.activity - `Ase/codeActivity`
 * @return {{type: string, class: string, activity: string, unmapped: string[]}}
 */
export function mapAirspaceMetadata45({ type, localType, airspaceClass, activity }) {
    const unmapped = [];

    let mappedType = TYPE_MAP_45[type];
    if (mappedType == null) {
        unmapped.push(`type=${type}`);
        mappedType = 'OTHER';
    }

    let mappedActivity = 'NONE';
    if (activity != null) {
        const found = ACTIVITY_MAP_45[activity];
        if (found == null) unmapped.push(`activity=${activity}`);
        else mappedActivity = found;
    }

    if (localType != null) {
        const override = LOCAL_TYPE_MAP_45[localType];
        if (override == null) {
            unmapped.push(`localType=${localType}`);
        } else {
            mappedType = override.type;
            if (mappedActivity === 'NONE' && override.activity != null) mappedActivity = override.activity;
        }
    }

    let mappedClass = 'UNCLASSIFIED';
    if (airspaceClass != null) {
        const found = CLASS_MAP[airspaceClass];
        if (found == null) unmapped.push(`class=${airspaceClass}`);
        else mappedClass = found;
    }

    return { type: mappedType, class: mappedClass, activity: mappedActivity, unmapped };
}
