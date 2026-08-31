// Miroir CommonJS de dashboard/server/src/services/dispositifFiscal.js — les deux services
// (Ubiflow-Auto-API en CommonJS, dashboard/server en ESM) ne partagent pas de code, donc cette
// logique est dupliquée volontairement. Garder les deux fichiers synchronisés si CODES_LMNP change.
//
// Codes lawsKeys confirmés comme appartenant à la famille LMNP (lus directement sur lot.laws —
// ex. lawsKeys:[21], laws:["LMNP second marché"] — jamais devinés) : LMNP, LMNP second marché,
// LMNP non géré, LMNP non géré réhabilité.
const CODES_LMNP = [2, 21, 30, 32];

function estLotLmnp(lot) {
    if (!Array.isArray(lot?.lawsKeys)) return false;
    return lot.lawsKeys.some((k) => CODES_LMNP.includes(k));
}

module.exports = { estLotLmnp, CODES_LMNP };
