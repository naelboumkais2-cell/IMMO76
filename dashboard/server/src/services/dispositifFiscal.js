// Bit du champ `law` (bitmask brut Otaree, un bit par dispositif fiscal) correspondant à LMNP —
// confirmé empiriquement (100% des lots d'une recherche filtrée uniquement sur LMNP ont
// law === 4, ce bit n'apparaissant dans aucune autre valeur observée en base), pas une valeur
// devinée à partir de l'ID utilisé dans le filtre de recherche. Source unique partagée entre
// referenceGenerator.js (génération de référence) et orchestrator.js (routage par portail).
const BIT_LOI_LMNP = 4;

export function estLotLmnp(lot) {
    return typeof lot?.law === 'number' && (lot.law & BIT_LOI_LMNP) === BIT_LOI_LMNP;
}
