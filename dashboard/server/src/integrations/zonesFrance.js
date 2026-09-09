// Découpage France métropolitaine en régions/départements pour la recherche Otaree "nationale"
// (voir rechercherZoneAvecRepli dans otareeSearchClient.js) — une recherche sans aucun filtre de
// ville dépasse largement le plafond de pagination (MAX_PAGES=100, ~3000 lots) et le JWT Otaree
// peut expirer en cours de route sur une recherche aussi longue. Découper par région (repli en
// départements si une région dépasse elle-même le plafond) garde chaque appel individuel dans une
// plage de temps/volume raisonnable.
//
// DOM-TOM non inclus pour l'instant (Guadeloupe, Martinique, Guyane, La Réunion, Mayotte) — pas de
// besoin exprimé, à ajouter si nécessaire (même mécanisme, juste 5 régions/départements de plus).
export const REGIONS_FRANCE = [
    { nom: 'Auvergne-Rhône-Alpes', departements: ['Ain', 'Allier', 'Ardèche', 'Cantal', 'Drôme', 'Isère', 'Loire', 'Haute-Loire', 'Puy-de-Dôme', 'Rhône', 'Savoie', 'Haute-Savoie'] },
    { nom: 'Bourgogne-Franche-Comté', departements: ["Côte-d'Or", 'Doubs', 'Jura', 'Nièvre', 'Haute-Saône', 'Saône-et-Loire', 'Yonne', 'Territoire de Belfort'] },
    { nom: 'Bretagne', departements: ["Côtes-d'Armor", 'Finistère', 'Ille-et-Vilaine', 'Morbihan'] },
    { nom: 'Centre-Val de Loire', departements: ['Cher', 'Eure-et-Loir', 'Indre', 'Indre-et-Loire', 'Loir-et-Cher', 'Loiret'] },
    { nom: 'Corse', departements: ['Corse-du-Sud', 'Haute-Corse'] },
    { nom: 'Grand Est', departements: ['Ardennes', 'Aube', 'Marne', 'Haute-Marne', 'Meurthe-et-Moselle', 'Meuse', 'Moselle', 'Bas-Rhin', 'Haut-Rhin', 'Vosges'] },
    { nom: 'Hauts-de-France', departements: ['Aisne', 'Nord', 'Oise', 'Pas-de-Calais', 'Somme'] },
    { nom: 'Île-de-France', departements: ['Paris', 'Seine-et-Marne', 'Yvelines', 'Essonne', 'Hauts-de-Seine', 'Seine-Saint-Denis', 'Val-de-Marne', "Val-d'Oise"] },
    { nom: 'Normandie', departements: ['Calvados', 'Eure', 'Manche', 'Orne', 'Seine-Maritime'] },
    { nom: 'Nouvelle-Aquitaine', departements: ['Charente', 'Charente-Maritime', 'Corrèze', 'Creuse', 'Dordogne', 'Gironde', 'Landes', 'Lot-et-Garonne', 'Pyrénées-Atlantiques', 'Deux-Sèvres', 'Vienne', 'Haute-Vienne'] },
    { nom: 'Occitanie', departements: ['Ariège', 'Aude', 'Aveyron', 'Gard', 'Haute-Garonne', 'Gers', 'Hérault', 'Lot', 'Lozère', 'Hautes-Pyrénées', 'Pyrénées-Orientales', 'Tarn', 'Tarn-et-Garonne'] },
    { nom: 'Pays de la Loire', departements: ['Loire-Atlantique', 'Maine-et-Loire', 'Mayenne', 'Sarthe', 'Vendée'] },
    { nom: "Provence-Alpes-Côte d'Azur", departements: ['Alpes-de-Haute-Provence', 'Hautes-Alpes', 'Alpes-Maritimes', 'Bouches-du-Rhône', 'Var', 'Vaucluse'] },
];
